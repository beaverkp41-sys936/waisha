"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../api-client";
import {
  BASES, BASIS_LABELS, SECTION_SHORT, SECTIONS, STATUS_LABELS, errorText, fmt
} from "./shared";
import type { CatalogRow, Section } from "./shared";

interface Quotation {
  id: string; quotation_number: string; kind: string; status: string;
  customer_name: string; vessel_name: string | null; bl_number: string | null;
  currency: string; issue_date: string | null; valid_until: string | null;
  statutory_total: string; port_total: string; transport_total: string; total: string;
  converted_invoice_id: string | null; created_at: string;
}
interface Kpis { drafts: number; awaiting: number; accepted: number; open_value: number; lapsed: number; }

const STATUS_COLORS: Record<string, string> = {
  draft: "var(--ink-soft)", issued: "var(--brand)", accepted: "var(--success)",
  declined: "var(--danger)", converted: "var(--gold)", cancelled: "var(--ink-soft)"
};

export default function ProformaListPage() {
  const [tab, setTab] = useState<"documents" | "catalog">("documents");
  const [rows, setRows] = useState<Quotation[]>([]);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The list is searched as the clerk types; one request per pause, not per key.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (kind) qs.set("kind", kind);
    if (query) qs.set("q", query);
    const res = await apiFetch(`/quotations${qs.toString() ? `?${qs}` : ""}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Could not load the documents.")); return; }
    setRows(j.quotations ?? []);
    setKpis(j.kpis ?? null);
  }, [status, kind, query]);

  useEffect(() => { load(); }, [load]);

  async function act(id: string, action: "status" | "convert", value?: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = action === "convert"
        ? await apiFetch(`/quotations/${id}/convert`, { method: "POST" })
        : await apiFetch(`/quotations/${id}/status`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: value })
        });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed.")); return; }
      setNotice(action === "convert"
        ? "Invoice raised as a draft from this document."
        : `Marked ${STATUS_LABELS[value!] ?? value}.`);
    } finally { setBusy(false); load(); }
  }

  async function remove(id: string) {
    setError(null); setBusy(true);
    try {
      const res = await apiFetch(`/quotations/${id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setError(errorText(j, "Could not delete the document."));
    } finally { setBusy(false); load(); }
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  const kpi = (label: string, value: string, color: string) => (
    <div className={card} style={cardStyle}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</p>
      <p className="mt-8 text-lg font-bold tabular-nums" style={{ color }}>{value}</p>
    </div>
  );

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Proforma &amp; quotations</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Clearing and forwarding bills in three blocks — statutory duties, port charges, transport — with inline editing and a
            two-document cross-check before anything is issued.
          </p>
        </div>
        <div className="flex flex-wrap gap-12">
          <TabButton active={tab === "documents"} onClick={() => setTab("documents")}>Documents</TabButton>
          <TabButton active={tab === "catalog"} onClick={() => setTab("catalog")}>Charge catalogue</TabButton>
          <Link href="/app/cfa/proforma/new" className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
            + New proforma
          </Link>
        </div>
      </div>

      {error && <div role="alert" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {tab === "documents" ? (
        <>
          {kpis && (
            <section className="mt-24 grid grid-cols-2 gap-16 lg:grid-cols-4">
              {kpi("Drafts", String(kpis.drafts), "var(--ink)")}
              {kpi("Awaiting decision", String(kpis.awaiting), "var(--brand)")}
              {kpi("Accepted", String(kpis.accepted), "var(--success)")}
              {kpi("Value in force", `${fmt(kpis.open_value)}`, "var(--gold)")}
            </section>
          )}
          {kpis && kpis.lapsed > 0 && (
            <p role="status" className="mt-12 px-12 py-8 text-sm"
              style={{ background: "color-mix(in srgb, var(--warning) 12%, transparent)", borderLeft: "4px solid var(--warning)", color: "var(--ink)" }}>
              {kpis.lapsed} issued document(s) are past their validity date.
            </p>
          )}

          <div className="no-print mt-24 grid gap-12 md:grid-cols-[1fr_180px_180px]">
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search number, customer, vessel or B/L" className={inputCls} style={inputStyle} />
            <select value={kind} onChange={e => setKind(e.target.value)} className={inputCls} style={inputStyle} aria-label="Kind">
              <option value="">Both kinds</option>
              <option value="proforma">Proforma</option>
              <option value="quotation">Quotation</option>
            </select>
            <select value={status} onChange={e => setStatus(e.target.value)} className={inputCls} style={inputStyle} aria-label="Status">
              <option value="">Any status</option>
              {Object.keys(STATUS_LABELS).map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>

          <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className="p-12">Document</th><th className="p-12">Customer</th>
                  <th className="p-12">Statutory</th><th className="p-12">Port</th>
                  <th className="p-12">Transport</th><th className="p-12 text-right">Total</th>
                  <th className="p-12">Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                      <Link href={`/app/cfa/proforma/${r.id}`} className="underline">{r.quotation_number}</Link>
                      <span className="block text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>
                        {r.kind === "quotation" ? "Quotation" : "Proforma"}
                        {r.vessel_name ? ` · ${r.vessel_name}` : ""}{r.bl_number ? ` · B/L ${r.bl_number}` : ""}
                      </span>
                    </td>
                    <td className="p-12" style={{ color: "var(--ink)" }}>
                      {r.customer_name}
                      <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                        {r.issue_date ?? "—"}
                        {r.valid_until ? ` · valid to ${r.valid_until}` : ""}
                      </span>
                    </td>
                    <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmt(Number(r.statutory_total))}</td>
                    <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmt(Number(r.port_total))}</td>
                    <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmt(Number(r.transport_total))}</td>
                    <td className="p-12 text-right font-semibold tabular-nums" style={{ color: "var(--ink)" }}>
                      {r.currency} {fmt(Number(r.total))}
                    </td>
                    <td className="p-12">
                      <span className="px-8 py-4 text-[10px] font-bold uppercase"
                        style={{ borderLeft: `4px solid ${STATUS_COLORS[r.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                        {STATUS_LABELS[r.status] ?? r.status}
                      </span>
                    </td>
                    <td className="p-12 text-right whitespace-nowrap">
                      {r.status === "draft" && (
                        <>
                          <button type="button" className="mr-12 underline" style={{ color: "var(--brand)" }}
                            disabled={busy} onClick={() => act(r.id, "status", "issued")}>Issue</button>
                          <Link href={`/app/cfa/proforma/${r.id}`} className="mr-12 underline" style={{ color: "var(--ink-soft)" }}>Edit</Link>
                        </>
                      )}
                      {(r.status === "issued" || r.status === "accepted") && (
                        <button type="button" className="mr-12 underline" style={{ color: "var(--brand)" }}
                          disabled={busy} onClick={() => act(r.id, "convert")}>Bill</button>
                      )}
                      {r.status === "converted" && r.converted_invoice_id && (
                        <Link href={`/app/cfa/invoices/${r.converted_invoice_id}`} className="mr-12 underline"
                          style={{ color: "var(--success)" }}>Invoice</Link>
                      )}
                      {r.status !== "converted" && r.status !== "cancelled" && (
                        <button type="button" className="mr-12 underline" style={{ color: "var(--danger)" }}
                          disabled={busy} onClick={() => act(r.id, "status", "cancelled")}>Cancel</button>
                      )}
                      {(r.status === "draft" || r.status === "cancelled") && (
                        <button type="button" className="underline" style={{ color: "var(--danger)" }}
                          disabled={busy} onClick={() => remove(r.id)}>Delete</button>
                      )}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                    Nothing matches these filters yet — start a proforma to build the first one.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <CatalogPanel onError={setError} onNotice={setNotice} />
      )}

      <p className="pane-note mt-24 text-xs">
        Standard codes come from the platform and cannot be edited here — copy one into your own office list to re-rate it.
        Bills already printed keep the lines they were raised with.
      </p>
    </div>
  );
}

function TabButton({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`on-photo-btn px-16 py-8 text-xs font-semibold${active ? " is-on" : ""}`}>
      {children}
    </button>
  );
}

const emptyDraft = {
  code: "", label: "", section: "port" as Section, basis: "flat",
  defaultRate: "", rateType: "", notes: ""
};

function CatalogPanel({ onError, onNotice }: {
  onError: (m: string | null) => void; onNotice: (m: string | null) => void;
}) {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [edited, setEdited] = useState<Record<string, { label: string; defaultRate: string }>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch("/charge-catalog");
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { onError(errorText(j, "Could not load the charge catalogue.")); return; }
    setRows(Array.isArray(j) ? j : []);
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); onError(null); onNotice(null); setBusy(true);
    try {
      const res = await apiFetch("/charge-catalog", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: draft.code.trim().toUpperCase(),
          label: draft.label.trim(),
          section: draft.section,
          basis: draft.basis,
          defaultRate: draft.defaultRate === "" ? null : Number(draft.defaultRate),
          rateType: draft.rateType || null,
          notes: draft.notes.trim() || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { onError(errorText(j, "Could not add the charge code.")); return; }
      onNotice(`${draft.code.toUpperCase()} added to your office catalogue.`);
      setDraft(emptyDraft);
    } finally { setBusy(false); load(); }
  }

  async function save(row: CatalogRow) {
    const patch = edited[row.id];
    if (!patch) return;
    onError(null); onNotice(null); setBusy(true);
    try {
      const body: any = {};
      if (patch.label && patch.label !== row.label) body.label = patch.label;
      const rate = patch.defaultRate === "" ? null : Number(patch.defaultRate);
      if (rate !== null ? rate !== row.defaultRate : row.defaultRate !== null) body.defaultRate = rate;
      if (!Object.keys(body).length) { onNotice("Nothing changed."); return; }
      const res = await apiFetch(`/charge-catalog/${row.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { onError(errorText(j, "Could not save the charge.")); return; }
      onNotice(`${row.code} updated.`);
      setEdited(e => { const n = { ...e }; delete n[row.id]; return n; });
    } finally { setBusy(false); load(); }
  }

  async function toggle(row: CatalogRow, isActive: boolean) {
    onError(null); setBusy(true);
    try {
      const res = await apiFetch(`/charge-catalog/${row.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) onError(errorText(j, "Could not change that charge."));
    } finally { setBusy(false); load(); }
  }

  function startCopy(row: CatalogRow) {
    setDraft({
      code: `${row.code}`, label: row.label, section: row.section, basis: row.basis,
      defaultRate: row.defaultRate === null ? "" : String(row.defaultRate),
      rateType: row.rateType ?? "", notes: row.notes ?? ""
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="mt-24">
      <form onSubmit={add} className="rounded-card border bg-surface p-24" style={inputStyle}>
        <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>Add a charge code for this office</p>
        <div className="mt-12 grid gap-12 md:grid-cols-3">
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Code *</span>
            <input required value={draft.code} onChange={e => setDraft(d => ({ ...d, code: e.target.value }))}
              placeholder="REEFER_PLUG" className={inputCls} style={inputStyle} />
          </label>
          <label className="block md:col-span-2">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Label as it should print *</span>
            <input required value={draft.label} onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
              placeholder="Reefer plug and monitoring" className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Block</span>
            <select value={draft.section} onChange={e => setDraft(d => ({ ...d, section: e.target.value as Section }))}
              className={inputCls} style={inputStyle}>
              {SECTIONS.map(s => <option key={s} value={s}>{SECTION_SHORT[s]}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Basis</span>
            <select value={draft.basis} onChange={e => setDraft(d => ({ ...d, basis: e.target.value as any }))}
              className={inputCls} style={inputStyle}>
              {BASES.map(b => <option key={b} value={b}>{BASIS_LABELS[b]}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Rate type</span>
            <select value={draft.rateType} onChange={e => setDraft(d => ({ ...d, rateType: e.target.value }))}
              className={inputCls} style={inputStyle}>
              <option value="">None</option>
              <option value="percent">Percent</option>
              <option value="amount">Amount</option>
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Standard rate</span>
            <input type="number" min={0} step="0.0001" value={draft.defaultRate}
              onChange={e => setDraft(d => ({ ...d, defaultRate: e.target.value }))}
              placeholder="blank until the tariff says otherwise" className={inputCls} style={inputStyle} />
          </label>
          <label className="block md:col-span-2">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note (not printed)</span>
            <input value={draft.notes} onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
        </div>
        <button type="submit" disabled={busy || !draft.code.trim() || !draft.label.trim()}
          className="waisha-btn mt-16 rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-60">
          Add charge code
        </button>
      </form>

      {SECTIONS.map(section => {
        const inSection = rows.filter(r => r.section === section);
        if (!inSection.length) return null;
        return (
          <div key={section} className="mt-24">
            <h2 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
              {SECTION_SHORT[section]}
            </h2>
            <div className="mt-12 overflow-hidden rounded-card border bg-surface" style={inputStyle}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className="p-12">Code</th><th className="p-12">Label</th><th className="p-12">Basis</th>
                    <th className="p-12 text-right">Standard rate</th><th className="p-12">Source</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {inSection.map(r => {
                    const e = edited[r.id] ?? { label: r.label, defaultRate: r.defaultRate === null ? "" : String(r.defaultRate) };
                    return (
                      <tr key={r.id} className="border-b" style={{ borderColor: "var(--line)" }}>
                        <td className="p-12 font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{r.code}</td>
                        <td className="p-12">
                          {r.tenantOwn ? (
                            <input value={e.label} className={inputCls} style={inputStyle}
                              onChange={ev => setEdited(p => ({ ...p, [r.id]: { ...e, label: ev.target.value } }))} />
                          ) : <span style={{ color: "var(--ink)" }}>{r.label}</span>}
                          {r.eacExempt && (
                            <span className="mt-4 block text-[10px]" style={{ color: "var(--gold)" }}>
                              EAC originating goods may qualify
                            </span>
                          )}
                        </td>
                        <td className="p-12 text-xs" style={{ color: "var(--ink-soft)" }}>{BASIS_LABELS[r.basis] ?? r.basis}</td>
                        <td className="p-12 text-right">
                          {r.tenantOwn ? (
                            <input type="number" min={0} step="0.0001" value={e.defaultRate}
                              className={`${inputCls} max-w-[120px] text-right`} style={inputStyle}
                              onChange={ev => setEdited(p => ({ ...p, [r.id]: { ...e, defaultRate: ev.target.value } }))} />
                          ) : (
                            <span className="tabular-nums" style={{ color: "var(--ink)" }}>
                              {r.defaultRate === null ? "—" : `${fmt(r.defaultRate)}${r.rateType === "percent" ? "%" : ""}`}
                            </span>
                          )}
                        </td>
                        <td className="p-12 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>
                          {r.tenantOwn ? "This office" : "Platform"}
                        </td>
                        <td className="p-12 text-right whitespace-nowrap">
                          {r.tenantOwn ? (
                            <>
                              <button type="button" className="mr-12 underline" style={{ color: "var(--brand)" }}
                                disabled={busy} onClick={() => save(r)}>Save</button>
                              <button type="button" className="underline" style={{ color: "var(--danger)" }}
                                disabled={busy} onClick={() => toggle(r, false)}>Retire</button>
                            </>
                          ) : (
                            <button type="button" className="underline" style={{ color: "var(--ink-soft)" }}
                              onClick={() => startCopy(r)}>Copy to office</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
