"use client";
import { useCallback, useEffect, useState } from "react";
import { Package } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { apiFetch } from "../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface Item {
  id: string; name: string; part_number: string | null; category: string | null;
  quantity: string; min_quantity: string; unit_cost: string | null;
  location: string | null; notes: string | null; stock_status: string;
}

const EMPTY = { name: "", partNumber: "", category: "", quantity: "0", minQuantity: "0", unitCost: "", location: "", notes: "" };

export default function InventoryPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [lowCount, setLowCount] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch("/inventory");
    if (res.ok) { const j = await res.json(); setItems(j.items ?? []); setLowCount(j.lowCount ?? 0); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const editing = editingId !== null;
      const res = await apiFetch(editing ? `/inventory/${editingId}` : "/inventory", {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          partNumber: form.partNumber || null,
          category: form.category || null,
          quantity: Number(form.quantity) || 0,
          minQuantity: Number(form.minQuantity) || 0,
          unitCost: form.unitCost ? Number(form.unitCost) : null,
          location: form.location || null,
          notes: form.notes || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save.")); return; }
      setNotice(editing ? "Item updated." : "Item added to inventory.");
      setForm(EMPTY); setEditingId(null); setShowForm(false);
      load();
    } finally { setBusy(false); }
  }

  function startEdit(it: Item) {
    setEditingId(it.id);
    setForm({
      name: it.name ?? "", partNumber: it.part_number ?? "", category: it.category ?? "",
      quantity: String(Number(it.quantity)), minQuantity: String(Number(it.min_quantity)),
      unitCost: it.unit_cost ?? "", location: it.location ?? "", notes: it.notes ?? ""
    });
    setError(null); setNotice(null); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function remove(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/inventory/${id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed to delete."));
    load();
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Spare parts inventory</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Parts on hand with low-stock warnings.
            {lowCount > 0 && <span style={{ color: "var(--danger)" }}> {lowCount} item{lowCount === 1 ? "" : "s"} at or below minimum.</span>}
          </p>
        </div>
        <button type="button" onClick={() => { setForm(EMPTY); setEditingId(null); setShowForm(s => !s); }}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm ? "Close form" : "+ Add part"}
        </button>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {showForm && (
        <form onSubmit={submit} className="mb-32 space-y-12 rounded-card border bg-surface p-24" style={cardStyle}>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Part name *</span>
              <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Air filter — Isuzu FRR" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Part number</span>
              <input value={form.partNumber} onChange={e => setForm(f => ({ ...f, partNumber: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Category</span>
              <input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                placeholder="e.g. Filters, Tyres, Brakes" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Quantity on hand</span>
              <input type="number" min={0} step="0.01" value={form.quantity}
                onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Minimum quantity (alert level)</span>
              <input type="number" min={0} step="0.01" value={form.minQuantity}
                onChange={e => setForm(f => ({ ...f, minQuantity: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Unit cost (TZS)</span>
              <input type="number" min={0} step="0.01" value={form.unitCost}
                onChange={e => setForm(f => ({ ...f, unitCost: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Store location</span>
              <input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                placeholder="e.g. HQ store, shelf B2" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>
          <button type="submit" disabled={busy}
            className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
            {busy ? "Saving…" : (editingId ? "Save changes" : "Add part")}
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-card border bg-surface" style={cardStyle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Part</th><th className="p-12">Category</th>
              <th className="p-12 text-right">On hand</th><th className="p-12 text-right">Min</th>
              <th className="p-12 text-right">Unit cost</th><th className="p-12">Location</th>
              <th className="p-12">Stock</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                  {it.name}
                  {it.part_number && <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>{it.part_number}</span>}
                </td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{it.category ?? "—"}</td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{Number(it.quantity).toLocaleString()}</td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{Number(it.min_quantity).toLocaleString()}</td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {it.unit_cost ? Number(it.unit_cost).toLocaleString() : "—"}
                </td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{it.location ?? "—"}</td>
                <td className="p-12">
                  <span className="px-8 py-4 text-[10px] font-bold uppercase"
                    style={{ borderLeft: `4px solid ${it.stock_status === "low" ? "var(--danger)" : "var(--success)"}`, color: "var(--ink)" }}>
                    {it.stock_status === "low" ? "Low stock" : "OK"}
                  </span>
                </td>
                <td className="p-12 text-right whitespace-nowrap">
                  <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                    onClick={() => startEdit(it)}>Edit</button>
                  <button type="button" className="underline" style={{ color: "var(--danger)" }}
                    onClick={() => remove(it.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <EmptyState colSpan={8} icon={Package} title="No parts yet"
                hint="Track spares and consumables so a breakdown never waits on stock."
                action={{ label: "Add a part", onClick: () => { setForm(EMPTY); setEditingId(null); setShowForm(true); } }} />
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
