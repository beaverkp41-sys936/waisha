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

interface Member {
  id: string; full_name: string | null; email: string | null;
  status: string; user_type: string; last_login_at: string | null;
  created_at: string; roles: { key: string; name: string }[];
}
interface Role { key: string; name: string; }

const STATUS_LABELS: Record<string, string> = {
  active: "Active", pending_verification: "Invite pending",
  deactivated: "Deactivated", suspended: "Suspended"
};
const STATUS_COLORS: Record<string, string> = {
  active: "var(--success)", pending_verification: "var(--gold)",
  deactivated: "var(--ink-soft)", suspended: "var(--danger)"
};

interface StaffForm {
  fullName: string; email: string; phone: string; roleKeys: string[];
}
const EMPTY: StaffForm = { fullName: "", email: "", phone: "", roleKeys: [] };

export default function StaffPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [seatLimit, setSeatLimit] = useState<number | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<StaffForm>(EMPTY);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const u = await apiFetch("/users");
    if (u.ok) { const j = await u.json(); setMembers(j.users ?? []); setSeatLimit(j.seatLimit ?? null); }
    const r = await apiFetch("/roles");
    if (r.ok) setRoles(await r.json());
    const m = await apiFetch("/auth/me");
    if (m.ok) { const j = await m.json(); setMeId(j.id ?? null); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleRole(key: string) {
    setForm(f => ({
      ...f,
      roleKeys: f.roleKeys.includes(key)
        ? f.roleKeys.filter(k => k !== key)
        : [...f.roleKeys, key]
    }));
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setInviteUrl(null); setBusy(true);
    try {
      const editing = editingId !== null;
      const res = await apiFetch(editing ? `/users/${editingId}` : "/users", {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing
          ? { fullName: form.fullName, roleKeys: form.roleKeys }
          : {
              fullName: form.fullName, email: form.email,
              phone: form.phone || null, roleKeys: form.roleKeys
            })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save.")); return; }
      if (!editing && j.inviteUrl) {
        setInviteUrl(j.inviteUrl);
        setNotice(`Invitation created for ${form.fullName}.`);
      } else {
        setNotice("Staff member updated.");
      }
      setForm(EMPTY); setEditingId(null); setShowForm(false);
      load();
    } finally { setBusy(false); }
  }

  function startEdit(m: Member) {
    setEditingId(m.id);
    setForm({
      fullName: m.full_name ?? "", email: m.email ?? "", phone: "",
      roleKeys: (m.roles ?? []).map(r => r.key)
    });
    setError(null); setNotice(null); setInviteUrl(null); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function changeStatus(m: Member) {
    setError(null); setNotice(null); setInviteUrl(null);
    const next = m.status === "deactivated" ? "active" : "deactivated";
    const res = await apiFetch(`/users/${m.id}/status`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed to change status."));
    else setNotice(next === "deactivated"
      ? `${m.full_name ?? "Member"} deactivated — their sessions were signed out.`
      : `${m.full_name ?? "Member"} reactivated.`);
    load();
  }

  async function reinvite(m: Member) {
    setError(null); setNotice(null); setInviteUrl(null); setBusy(true);
    try {
      const res = await apiFetch(`/users/${m.id}/reinvite`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to resend the invite.")); return; }
      setInviteUrl(j.inviteUrl);
      setNotice(`Invite link refreshed for ${m.full_name ?? "member"}.`);
      load();
    } finally { setBusy(false); }
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    try { await navigator.clipboard.writeText(inviteUrl); setNotice("Invite link copied."); }
    catch { setError("Could not copy — select the link text manually."); }
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Staff</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Portal members and their roles.{seatLimit !== null ? ` ${members.length} of ${seatLimit} seats used.` : ""}
          </p>
        </div>
        <button type="button" onClick={() => { setForm(EMPTY); setEditingId(null); setInviteUrl(null); setShowForm(s => !s); }}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm ? "Close form" : "+ Invite member"}
        </button>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {inviteUrl && (
        <div className="mb-32 rounded-card border bg-surface p-24" style={{ borderColor: "var(--success)" }}>
          <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Invite link — shown once, valid for 7 days</p>
          <div className="mt-12 flex flex-wrap items-center gap-12">
            <code className="min-w-0 flex-1 break-all rounded-input border px-12 py-8 text-xs"
              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
              {inviteUrl}
            </code>
            <button type="button" onClick={copyInvite}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">Copy link</button>
          </div>
          <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
            Send it to the member (email or WhatsApp). After they set a password they sign in with the company TIN and their email.
          </p>
        </div>
      )}

      {showForm && (
        <form onSubmit={submit} className="mb-32 space-y-12 rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Full name *</span>
              <input required value={form.fullName}
                onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            {editingId === null && (
              <>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Work email *</span>
                  <input type="email" required value={form.email}
                    onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                    placeholder="name@company.co.tz" className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Phone (optional)</span>
                  <input value={form.phone}
                    onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder="+255712345678" className={inputCls} style={inputStyle} />
                </label>
              </>
            )}
          </div>
          <div>
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Roles * (pick at least one)</span>
            <div className="grid grid-cols-2 gap-8 md:grid-cols-3">
              {roles.map(r => (
                <label key={r.key} className="flex items-center gap-8 rounded-input border px-12 py-8 text-sm"
                  style={{ borderColor: form.roleKeys.includes(r.key) ? "var(--brand)" : "var(--line)" }}>
                  <input type="checkbox" checked={form.roleKeys.includes(r.key)}
                    onChange={() => toggleRole(r.key)} />
                  <span style={{ color: "var(--ink)" }}>{r.name}</span>
                </label>
              ))}
            </div>
          </div>
          <button type="submit" disabled={busy || form.roleKeys.length === 0}
            className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
            {busy ? "Saving…" : (editingId ? "Save changes" : "Create invitation")}
          </button>
          {editingId === null && (
            <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
              The member receives a link to set their password. Email cannot be changed later — deactivate and re-invite instead.
            </p>
          )}
        </form>
      )}

      <div className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Member</th><th className="p-12">Roles</th>
              <th className="p-12">Status</th><th className="p-12">Last sign-in</th><th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => (
              <tr key={m.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12" style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{m.full_name ?? "—"}</span>
                  {m.user_type === "director" && (
                    <span className="ml-8 text-[10px] font-bold uppercase" style={{ color: "var(--gold)" }}>Director</span>
                  )}
                  <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>{m.email ?? ""}</span>
                </td>
                <td className="p-12">
                  {(m.roles ?? []).length === 0 ? <span style={{ color: "var(--ink-soft)" }}>—</span> : (
                    <span className="flex flex-wrap gap-4">
                      {(m.roles ?? []).map(r => (
                        <span key={r.key} className="rounded-input border px-8 py-2 text-[10px] font-semibold uppercase"
                          style={{ borderColor: "var(--line)", color: "var(--ink)" }}>{r.name}</span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="p-12">
                  <span className="px-8 py-4 text-[10px] font-bold uppercase"
                    style={{ borderLeft: `4px solid ${STATUS_COLORS[m.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                    {STATUS_LABELS[m.status] ?? m.status}
                  </span>
                </td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {m.last_login_at ? new Date(m.last_login_at).toLocaleDateString() : "Never"}
                </td>
                <td className="p-12 text-right whitespace-nowrap">
                  {m.id !== meId && m.user_type !== "director" && (
                    <>
                      {m.status !== "deactivated" && (
                        <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                          onClick={() => startEdit(m)}>Edit</button>
                      )}
                      {m.status === "pending_verification" && (
                        <button type="button" disabled={busy} className="mr-12 underline" style={{ color: "var(--brand)" }}
                          onClick={() => reinvite(m)}>Resend invite</button>
                      )}
                      <button type="button" className="underline" style={{ color: m.status === "deactivated" ? "var(--success)" : "var(--danger)" }}
                        onClick={() => changeStatus(m)}>
                        {m.status === "deactivated" ? "Activate" : "Deactivate"}
                      </button>
                    </>
                  )}
                  {m.id === meId && <span className="text-xs" style={{ color: "var(--ink-soft)" }}>You — manage on Account</span>}
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr><td colSpan={5} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                No members yet — invite your first dispatcher above.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
