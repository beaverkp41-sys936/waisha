"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface Client {
  id: string; name: string; tin: string | null; email: string | null;
  address: string | null; notes: string | null; has_phone: boolean; created_at: string;
}

const EMPTY = { name: "", tin: "", email: "", phone: "", address: "", notes: "" };

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch("/clients");
    if (res.ok) setClients(await res.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const editing = editingId !== null;
      const res = await apiFetch(editing ? `/clients/${editingId}` : "/clients", {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          tin: form.tin || null,
          email: form.email || null,
          // blank phone keeps the stored (encrypted) value
          phone: form.phone || undefined,
          address: form.address || null,
          notes: form.notes || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save.")); return; }
      setNotice(editing ? "Client updated." : `Client "${form.name}" added.`);
      setForm(EMPTY); setEditingId(null); setShowForm(false);
      load();
    } finally { setBusy(false); }
  }

  function startEdit(c: Client) {
    setEditingId(c.id);
    setForm({
      name: c.name ?? "", tin: c.tin ?? "", email: c.email ?? "",
      phone: "", address: c.address ?? "", notes: c.notes ?? ""
    });
    setError(null); setNotice(null); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function remove(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/clients/${id}`, { method: "DELETE" });
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
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Clients</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            The shippers and traders you move cargo for.
          </p>
        </div>
        <button type="button" onClick={() => { setForm(EMPTY); setEditingId(null); setShowForm(s => !s); }}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm ? "Close form" : "+ Add client"}
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
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Client name *</span>
              <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>TIN</span>
              <input value={form.tin} onChange={e => setForm(f => ({ ...f, tin: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Email</span>
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Phone{editingId ? " — blank keeps current" : ""}
              </span>
              <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="+255712345678" className={inputCls} style={inputStyle} />
            </label>
            <label className="block col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Address</span>
              <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>
          <button type="submit" disabled={busy}
            className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
            {busy ? "Saving…" : (editingId ? "Save changes" : "Add client")}
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-card border bg-surface" style={cardStyle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Client</th><th className="p-12">TIN</th>
              <th className="p-12">Email</th><th className="p-12">Address</th>
              <th className="p-12">Phone</th><th></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c, i) => (
              <tr key={c.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                  {c.name}
                  {c.notes && <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>{c.notes}</span>}
                </td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{c.tin ?? "—"}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{c.email ?? "—"}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{c.address ?? "—"}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                  {c.has_phone ? "On file" : "—"}
                </td>
                <td className="p-12 text-right whitespace-nowrap">
                  <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                    onClick={() => startEdit(c)}>Edit</button>
                  <button type="button" className="underline" style={{ color: "var(--danger)" }}
                    onClick={() => remove(c.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                No clients yet — add the businesses you serve.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
