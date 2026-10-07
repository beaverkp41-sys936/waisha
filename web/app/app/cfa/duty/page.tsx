"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface RateRow {
  id: string; kind: string; hs_code: string | null; category: string | null;
  label: string; basis: string; rate_type: string; rate_value: string;
}
interface RatesPayload {
  version: string; effectiveFrom: string; effectiveTo: string | null; expired: boolean;
  bands: RateRow[]; idl: RateRow[]; excise: RateRow[];
  core: { vatRate: number; whVatGoods: number; whVatServices: number; railwayLevyRate: number; customsProcessingRate: number };
}
interface Breakdown {
  version: string; expired: boolean; currency: string; exchangeRate: number;
  importDutyLabel: string; exciseLabel: string | null;
  cifTzs: number; fobTzs: number; importDuty: number; excise: number;
  railwayLevy: number; customsProcessingFee: number; vat: number; totalLandedCost: number;
}

const CURRENCIES = ["USD", "EUR", "GBP", "CNY", "RUB", "JPY", "TZS", "KES", "INR", "AED"];

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DutyCalculatorPage() {
  const [rates, setRates] = useState<RatesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Breakdown | null>(null);

  const [fob, setFob] = useState("");
  const [freight, setFreight] = useState("");
  const [insurance, setInsurance] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [fx, setFx] = useState("");
  const [rateId, setRateId] = useState("");
  const [hsQuery, setHsQuery] = useState("");
  const [exciseId, setExciseId] = useState("");
  const [exciseUnits, setExciseUnits] = useState("");

  const load = useCallback(async () => {
    const res = await apiFetch("/duty/rates");
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Could not load duty rates.")); return; }
    setRates(j);
    if (j.bands?.length) setRateId(j.bands.find((b: RateRow) => b.category === "final_consumer")?.id ?? j.bands[0].id);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Combined rate picker: bands + IDL codes, filtered by the search box.
  const filtered = useMemo(() => {
    if (!rates) return { bands: [], idl: [] };
    const q = hsQuery.trim().toLowerCase();
    const match = (r: RateRow) => !q || r.label.toLowerCase().includes(q) || (r.hs_code ?? "").toLowerCase().includes(q);
    return { bands: rates.bands.filter(match), idl: rates.idl.filter(match) };
  }, [rates, hsQuery]);

  async function calculate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      const res = await apiFetch("/duty/calculate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fob: Number(fob) || 0,
          freight: Number(freight) || 0,
          insurance: Number(insurance) || 0,
          currency,
          exchangeRate: Number(fx),
          rateId,
          exciseId: exciseId || null,
          exciseUnits: exciseUnits ? Number(exciseUnits) : null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Calculation failed.")); return; }
      setResult(j);
    } finally { setBusy(false); }
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  const exciseSelected = rates?.excise.find(x => x.id === exciseId);

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Duty calculator</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Import duty, excise, railway development levy, VAT and total landed cost — from the TRA rate tables.
      </p>
      {rates && !rates.expired && (
        <p className="mt-8 text-xs" style={{ color: "var(--gold)" }}>
          Rates: {rates.version}, effective {new Date(rates.effectiveFrom).toLocaleDateString()}
          {rates.effectiveTo ? ` to ${new Date(rates.effectiveTo).toLocaleDateString()}` : " onwards"}.
          Rates change with each Finance Act — new versions publish here automatically.
        </p>
      )}
      {rates?.expired && (
        <div role="status" className="mt-16 px-16 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--warning) 15%, transparent)", borderLeft: "4px solid var(--warning)" }}>
          The published rate edition ({rates.version}) expired
          {rates.effectiveTo ? ` on ${new Date(rates.effectiveTo).toLocaleDateString()}` : ""}.
          The calculator is showing it until the next TRA edition is published — verify against TRA before relying on figures.
        </div>
      )}
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      <form onSubmit={calculate} className="mt-24 space-y-12 rounded-card border bg-surface p-24" style={cardStyle}>
        <div className="grid grid-cols-2 gap-12">
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>FOB value *</span>
            <input type="number" required min={0} step="0.01" value={fob}
              onChange={e => setFob(e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Currency</span>
            <select value={currency} onChange={e => setCurrency(e.target.value)} className={inputCls} style={inputStyle}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Freight</span>
            <input type="number" min={0} step="0.01" value={freight}
              onChange={e => setFreight(e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Insurance</span>
            <input type="number" min={0} step="0.01" value={insurance}
              onChange={e => setInsurance(e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Exchange rate (TZS per 1 {currency}) *</span>
            <input type="number" required min={0.0001} step="0.0001" value={fx}
              onChange={e => setFx(e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Import duty band / HS rate *</span>
            <select required value={rateId} onChange={e => setRateId(e.target.value)} className={inputCls} style={inputStyle}>
              <optgroup label="Import duty bands">
                {filtered.bands.map(b => <option key={b.id} value={b.id}>{b.label} — {Number(b.rate_value)}%</option>)}
              </optgroup>
              <optgroup label="Industrial Development Levy (by HS code)">
                {filtered.idl.map(r => <option key={r.id} value={r.id}>{r.hs_code} — {r.label.replace(/^IDL — /, "")} ({Number(r.rate_value)}%)</option>)}
              </optgroup>
            </select>
          </label>
          <label className="block col-span-2">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Search rates (HS code or description)</span>
            <input value={hsQuery} onChange={e => setHsQuery(e.target.value)}
              placeholder="e.g. 8701, cement, tiles" className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Excise (optional)</span>
            <select value={exciseId} onChange={e => setExciseId(e.target.value)} className={inputCls} style={inputStyle}>
              <option value="">None</option>
              {rates?.excise.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
          {exciseSelected?.basis === "per_unit" && (
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Units (litres / pieces) *</span>
              <input type="number" required min={0} step="0.01" value={exciseUnits}
                onChange={e => setExciseUnits(e.target.value)} className={inputCls} style={inputStyle} />
            </label>
          )}
        </div>
        <button type="submit" disabled={busy || !rateId}
          className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
          {busy ? "Calculating…" : "Calculate landed cost"}
        </button>
      </form>

      {result && (
        <section className="mt-24 rounded-card border bg-surface p-24" style={cardStyle}>
          <div className="flex items-start justify-between gap-12">
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              Total landed cost
            </h2>
            <span className="text-[10px] font-bold uppercase" style={{ color: "var(--gold)" }}>{result.version}</span>
          </div>
          <div className="mt-16 space-y-8 text-sm">
            <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
              <span>CIF value (customs value, TZS)</span>
              <span className="tabular-nums">TZS {fmt(result.cifTzs)}</span>
            </div>
            <div className="flex justify-between" style={{ color: "var(--ink)" }}>
              <span>Import duty — {result.importDutyLabel.replace(/^IDL — /, "")}</span>
              <span className="tabular-nums">TZS {fmt(result.importDuty)}</span>
            </div>
            {result.excise > 0 && (
              <div className="flex justify-between" style={{ color: "var(--ink)" }}>
                <span>Excise — {result.exciseLabel}</span>
                <span className="tabular-nums">TZS {fmt(result.excise)}</span>
              </div>
            )}
            <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
              <span>Railway development levy (2% of CIF)</span>
              <span className="tabular-nums">TZS {fmt(result.railwayLevy)}</span>
            </div>
            <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
              <span>Customs processing fee (0.6% of FOB)</span>
              <span className="tabular-nums">TZS {fmt(result.customsProcessingFee)}</span>
            </div>
            <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
              <span>VAT (18% of duty-paid value)</span>
              <span className="tabular-nums">TZS {fmt(result.vat)}</span>
            </div>
            <div className="flex justify-between border-t pt-8 text-base font-bold" style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
              <span>Total landed cost</span>
              <span className="tabular-nums">TZS {fmt(result.totalLandedCost)}</span>
            </div>
          </div>
        </section>
      )}

      {rates && (
        <TariffExplorer version={rates.version} />
      )}
    </div>
  );
}

const KIND_OPTIONS = [
  { key: "", label: "All kinds" },
  { key: "import_band", label: "Import duty bands" },
  { key: "idl", label: "Industrial Development Levy" },
  { key: "excise", label: "Excise" },
  { key: "vat", label: "VAT" },
  { key: "levy", label: "Levies" },
  { key: "fee", label: "Fees" }
];
const BASIS_LABELS: Record<string, string> = {
  cif: "of CIF", fob: "of FOB", duty_paid_value: "of duty-paid value",
  per_unit: "per unit", fixed: "fixed"
};

function TariffExplorer({ version }: { version: string }) {
  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [minRate, setMinRate] = useState("");
  const [maxRate, setMaxRate] = useState("");
  const [rows, setRows] = useState<RateRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async () => {
    setBusy(true);
    try {
      const qs = new URLSearchParams();
      if (kind) qs.set("kinds", kind);
      if (query.trim()) qs.set("query", query.trim());
      if (minRate) qs.set("minRate", minRate);
      if (maxRate) qs.set("maxRate", maxRate);
      const res = await apiFetch(`/duty/tariff?${qs.toString()}`);
      const j = await res.json().catch(() => ({}));
      if (res.ok) setRows(j.rows ?? []);
    } finally { setBusy(false); }
  }, [kind, query, minRate, maxRate]);

  return (
    <section className="mt-24">
      <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
        Tariff explorer — duties, VAT, levies and fees ({version})
      </h2>
      <div className="mt-16 grid grid-cols-2 gap-12 rounded-card border bg-surface p-24 md:grid-cols-5" style={{ borderColor: "var(--line)" }}>
        <label className="block">
          <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Kind</span>
          <select value={kind} onChange={e => setKind(e.target.value)} className={inputCls} style={inputStyle}>
            {KIND_OPTIONS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Search</span>
          <input value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") search(); }}
            placeholder="HS code or description" className={inputCls} style={inputStyle} />
        </label>
        <label className="block">
          <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Min rate</span>
          <input type="number" min={0} value={minRate} onChange={e => setMinRate(e.target.value)} className={inputCls} style={inputStyle} />
        </label>
        <label className="block">
          <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Max rate</span>
          <input type="number" min={0} value={maxRate} onChange={e => setMaxRate(e.target.value)} className={inputCls} style={inputStyle} />
        </label>
        <button type="button" onClick={search} disabled={busy}
          className="waisha-btn self-end rounded-input py-8 text-xs font-semibold disabled:opacity-60">
          {busy ? "Searching…" : "Search tariff"}
        </button>
      </div>
      {rows && (
        <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">HS code</th><th className="p-12">Kind</th>
                <th className="p-12">Description</th><th className="p-12">Basis</th>
                <th className="p-12 text-right">Rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-b" style={{ borderColor: "var(--line)" }}>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink)" }}>{r.hs_code ?? "—"}</td>
                  <td className="p-12 text-xs uppercase" style={{ color: "var(--ink-soft)" }}>{r.kind.replace("_", " ")}</td>
                  <td className="p-12" style={{ color: "var(--ink)" }}>{r.label}</td>
                  <td className="p-12 text-xs" style={{ color: "var(--ink-soft)" }}>{BASIS_LABELS[r.basis] ?? r.basis}</td>
                  <td className="p-12 text-right font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                    {r.rate_type === "percent" ? `${Number(r.rate_value)}%` : `TZS ${Number(r.rate_value).toLocaleString()}`}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>No rates match the filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
