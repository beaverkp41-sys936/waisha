"use client";
import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { apiFetch } from "../api-client";
import { fmtDate, fmtDateTime, errorText } from "../../portal/labels";

interface Account {
  id: string; client_id: string; client_name: string; user_id: string;
  full_name: string; email: string; user_status: string; status: string;
  notes: string | null; invited_at: string | null; invited_by_name: string | null;
  has_phone: boolean; matched_files: number; shared_files: number; invoice_count: number;
}

const EMPTY_CREATE = { clientId: "", fullName: "", email: "", phone: "", password: "", notes: "" };

export default function ShipperAccessPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [form, setForm] = useState(EMPTY_CREATE);
  const [editForm, setEditForm] = useState({ fullName: "", phone: "", notes: "", password: "" });
  const [detail, setDetail] = useState<any>(null);
  const [cargo, setCargo] = useState<any[]>([]);
  const [shareFile, setShareFile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [a, c] = await Promise.all([apiFetch("/shipper-accounts"), apiFetch("/clients")]);
    if (a.ok) setAccounts(await a.json());
    if (c.ok) setClients(await c.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDetail = useCallback(async (id: string) => {
    setDetail(null); setShareFile("");
    const [d, c] = await Promise.all([
      apiFetch(`/shipper-accounts/${id}`), apiFetch("/cargo")
    ]);
    if (d.ok) setDetail(await d.json());
    if (c.ok) setCargo(await c.json());
  }, []);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch("/shipper-accounts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: form.clientId, fullName: form.fullName, email: form.email,
          phone: form.phone || null, password: form.password, notes: form.notes || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to create the account.")); return; }
      setNotice(`Portal account created. ${form.fullName} signs in on the Shipper tab with ${form.email}.`);
      setForm(EMPTY_CREATE); setShowForm(false);
      load();
    } finally { setBusy(false); }
  }

  async function saveEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const body: any = { fullName: editForm.fullName, notes: editForm.notes || null };
      if (editForm.phone !== "") body.phone = editForm.phone;
      if (editForm.password) body.password = editForm.password;
      const res = await apiFetch(`/shipper-accounts/${editing!.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save.")); return; }
      setNotice("Account updated." + (editForm.password ? " The new password applies at next sign-in." : ""));
      setEditing(null);
      load(); openDetail(editing!.id);
    } finally { setBusy(false); }
  }

  async function setStatus(acc: Account, status: "active" | "suspended") {
    setError(null); setNotice(null);
    const res = await apiFetch(`/shipper-accounts/${acc.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Failed to change status.")); return; }
    setNotice(status === "suspended"
      ? `${acc.full_name} suspended — their portal sessions were revoked.`
      : `${acc.full_name} reactivated.`);
    load();
    if (detail?.account?.id === acc.id) openDetail(acc.id);
  }

  async function remove(acc: Account) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/shipper-accounts/${acc.id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Failed to remove the account.")); return; }
    setNotice(`Removed ${acc.full_name}. Their login no longer works.`);
    if (detail?.account?.id === acc.id) setDetail(null);
    load();
  }

  async function addShare() {
    if (!detail || !shareFile) return;
    setError(null); setNotice(null);
    const res = await apiFetch(`/shipper-accounts/${detail.account.id}/shares`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shipmentId: shareFile })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Failed to share the file.")); return; }
    setShareFile("");
    load();
    openDetail(detail.account.id);
  }

  async function removeShare(shipmentId: string) {
    if (!detail) return;
    setError(null);
    const res = await apiFetch(`/shipper-accounts/${detail.account.id}/shares/${shipmentId}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed to remove the share."));
    load();
    openDetail(detail.account.id);
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const cardStyle = { borderColor: "var(--line)" };
  const soft = { color: "var(--ink-soft)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Shipper access</h1>
          <p className="mt-8 text-sm" style={soft}>
            Give clients their own portal — they track their cargo files, invoices and
            documents, and upload paperwork straight to the file.
          </p>
        </div>
        <button type="button"
          onClick={() => { setForm(EMPTY_CREATE); setShowForm(s => !s); setEditing(null); }}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm ? "Close form" : "+ Create account"}
        </button>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {showForm && (
        <form onSubmit={create} className="mb-32 space-y-12 rounded-card border bg-surface p-24" style={cardStyle}>
          <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>New portal account</p>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={soft}>Client (company) *</span>
              <select required value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">Choose a client…</option>
                {clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {clients.length === 0 && (
                <span className="mt-4 block text-xs" style={{ color: "var(--danger)" }}>
                  No clients yet — add the company under Clients first.
                </span>
              )}
            </label>
            <label className="block">
              <span className={labelCls} style={soft}>Contact full name *</span>
              <input required value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={soft}>Email (their login) *</span>
              <input required type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={soft}>Phone</span>
              <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="+255712345678" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={soft}>Temporary password *</span>
              <input required type="text" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                className={inputCls} style={inputStyle} />
              <span className="mt-4 block text-[10px]" style={soft}>
                10+ chars with upper, lower, number and symbol — share it with the shipper privately.
              </span>
            </label>
            <label className="block">
              <span className={labelCls} style={soft}>Notes</span>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>
          <p className="text-xs" style={soft}>
            The shipper signs in on the login screen&apos;s <strong>Shipper</strong> tab with this email and password.
            They see cargo files where the client name matches the consignee or consignor, plus any file you share below.
          </p>
          <button type="submit" disabled={busy}
            className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
            {busy ? "Creating…" : "Create account"}
          </button>
        </form>
      )}

      {editing && (
        <form onSubmit={saveEdit} className="mb-32 space-y-12 rounded-card border bg-surface p-24" style={cardStyle}>
          <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>Edit — {editing.full_name} ({editing.client_name})</p>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={soft}>Contact full name</span>
              <input required value={editForm.fullName} onChange={e => setEditForm(f => ({ ...f, fullName: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={soft}>Phone — blank keeps current</span>
              <input value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="+255712345678" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={soft}>New password — blank keeps current</span>
              <input type="text" value={editForm.password} onChange={e => setEditForm(f => ({ ...f, password: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={soft}>Notes</span>
              <input value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>
          <div className="flex gap-12">
            <button type="submit" disabled={busy}
              className="waisha-btn rounded-input px-16 py-8 text-sm font-semibold disabled:opacity-60">
              {busy ? "Saving…" : "Save changes"}
            </button>
            <button type="button" onClick={() => setEditing(null)}
              className="rounded-input border px-16 py-8 text-sm font-semibold" style={cardStyle}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Client</th><th className="p-12">Contact</th>
              <th className="p-12">Status</th><th className="p-12 text-center">Files</th>
              <th className="p-12 text-center">Shared</th><th className="p-12 text-center">Invoices</th>
              <th className="p-12">Created</th><th></th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a, i) => (
              <tr key={a.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                  {a.client_name}
                  {a.notes && <span className="block text-xs font-normal" style={soft}>{a.notes}</span>}
                </td>
                <td className="p-12">
                  <span className="block font-semibold" style={{ color: "var(--ink)" }}>{a.full_name}</span>
                  <span className="block text-xs" style={soft}>{a.email}</span>
                </td>
                <td className="p-12">
                  <span className="text-xs font-bold uppercase tracking-[0.1em]"
                    style={{ color: a.status === "active" ? "var(--success)" : "var(--danger)" }}>
                    {a.status}
                  </span>
                </td>
                <td className="p-12 text-center tabular-nums" style={soft} title="Auto-matched by consignee/consignor name">
                  {a.matched_files}
                </td>
                <td className="p-12 text-center tabular-nums" style={soft}>{a.shared_files}</td>
                <td className="p-12 text-center tabular-nums" style={soft}>{a.invoice_count}</td>
                <td className="p-12 text-xs" style={soft}>{fmtDate(a.invited_at)}</td>
                <td className="p-12 text-right whitespace-nowrap">
                  <button type="button" className="mr-12 underline" style={{ color: "var(--brand)" }}
                    onClick={() => { setDetail(null); openDetail(a.id); window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); }}>
                    Files
                  </button>
                  <button type="button" className="mr-12 underline" style={soft}
                    onClick={() => {
                      setEditing(a);
                      setEditForm({ fullName: a.full_name, phone: "", notes: a.notes ?? "", password: "" });
                      setShowForm(false);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}>Edit</button>
                  <button type="button" className="mr-12 underline"
                    style={{ color: a.status === "active" ? "var(--warning)" : "var(--success)" }}
                    onClick={() => setStatus(a, a.status === "active" ? "suspended" : "active")}>
                    {a.status === "active" ? "Suspend" : "Reactivate"}
                  </button>
                  <button type="button" className="underline" style={{ color: "var(--danger)" }}
                    onClick={() => remove(a)}>Remove</button>
                </td>
              </tr>
            ))}
            {accounts.length === 0 && (
              <EmptyState colSpan={8} icon={KeyRound} title="No shipper accounts yet"
                hint="Give a client a login and they can track their own files, invoices and documents in the portal."
                action={{ label: "Create an account", onClick: () => { setForm(EMPTY_CREATE); setEditing(null); setShowForm(true); } }} />
            )}
          </tbody>
        </table>
      </div>

      {detail && (
        <section className="mt-32 rounded-card border bg-surface p-24" style={cardStyle}>
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>
                {detail.account.client_name} — {detail.account.full_name}
              </h2>
              <p className="mt-4 text-xs" style={soft}>
                {detail.account.email} · {detail.account.status}
                {detail.account.invited_by_name ? ` · invited by ${detail.account.invited_by_name}` : ""}
              </p>
            </div>
            <button type="button" onClick={() => setDetail(null)} className="text-xs underline" style={soft}>Close</button>
          </div>

          <h3 className="mt-24 mb-8 text-xs font-bold uppercase tracking-[0.14em]" style={soft}>
            Auto-matched files ({detail.matchedFiles.length})
          </h3>
          <p className="mb-8 text-xs" style={soft}>
            Files where this client&apos;s name appears as consignee or consignor — visible to the shipper automatically.
          </p>
          <div className="max-h-[240px] overflow-y-auto rounded-input border" style={cardStyle}>
            <table className="w-full text-sm">
              <tbody>
                {detail.matchedFiles.map((f: any, i: number) => (
                  <tr key={f.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className="px-12 py-8 font-semibold" style={{ color: "var(--ink)" }}>{f.file_number}</td>
                    <td className="px-12 py-8" style={soft}>{f.consignee_name ?? "—"}</td>
                    <td className="px-12 py-8" style={soft}>{f.stage}</td>
                    <td className="px-12 py-8" style={soft}>{f.status}</td>
                    <td className="px-12 py-8 text-xs" style={soft}>ETA {fmtDate(f.eta)}</td>
                  </tr>
                ))}
                {detail.matchedFiles.length === 0 && (
                  <tr><td className="px-12 py-12 text-sm" style={soft}>No auto-matched files yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <h3 className="mt-24 mb-8 text-xs font-bold uppercase tracking-[0.14em]" style={soft}>
            Explicitly shared files ({detail.sharedFiles.length})
          </h3>
          <div className="max-h-[240px] overflow-y-auto rounded-input border" style={cardStyle}>
            <table className="w-full text-sm">
              <tbody>
                {detail.sharedFiles.map((f: any, i: number) => (
                  <tr key={f.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className="px-12 py-8 font-semibold" style={{ color: "var(--ink)" }}>{f.file_number}</td>
                    <td className="px-12 py-8" style={soft}>{f.stage}</td>
                    <td className="px-12 py-8 text-xs" style={soft}>shared {fmtDateTime(f.shared_at)}</td>
                    <td className="px-12 py-8 text-right">
                      <button type="button" className="underline" style={{ color: "var(--danger)" }}
                        onClick={() => removeShare(f.id)}>Unshare</button>
                    </td>
                  </tr>
                ))}
                {detail.sharedFiles.length === 0 && (
                  <tr><td className="px-12 py-12 text-sm" style={soft}>No extra shares — matched files already cover this client.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-16 flex flex-wrap items-end gap-12">
            <label className="block flex-1" style={{ minWidth: 240 }}>
              <span className={labelCls} style={soft}>Share an extra file with this shipper</span>
              <select value={shareFile} onChange={e => setShareFile(e.target.value)} className={inputCls} style={inputStyle}>
                <option value="">Choose a cargo file…</option>
                {cargo
                  .filter(c => !(detail.matchedFiles as any[]).some(m => m.id === c.id))
                  .map(c => (
                    <option key={c.id} value={c.id}>
                      {c.file_number} — {c.consignee_name ?? c.consignor_name ?? "no party"}
                    </option>
                  ))}
              </select>
            </label>
            <button type="button" onClick={addShare} disabled={!shareFile}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-60">
              Share file
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
