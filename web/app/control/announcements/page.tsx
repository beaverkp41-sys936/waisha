"use client";
import { useEffect, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

interface Row {
  id: string; message: string; kind: string; active: boolean;
  starts_at: string | null; ends_at: string | null;
  created_at: string; updated_at: string;
}
type Draft = Partial<Record<"message" | "kind" | "active" | "startsAt" | "endsAt", any>>;

const KINDS = ["info", "update", "upgrade", "maintenance", "warning"] as const;

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}
function statusOf(a: Row): { label: string; color: string } {
  if (!a.active) return { label: "Off", color: "var(--ink-soft)" };
  const now = Date.now();
  if (a.starts_at && new Date(a.starts_at).getTime() > now) return { label: "Scheduled", color: "var(--warning)" };
  if (a.ends_at && new Date(a.ends_at).getTime() < now) return { label: "Ended", color: "var(--ink-soft)" };
  return { label: "Live", color: "var(--success)" };
}

export default function AnnouncementsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const [msg, setMsg] = useState("");
  const [kind, setKind] = useState<string>("info");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      const r = await fetch(`${API}/api/v1/control/announcements`, { credentials: "include" });
      const j = await r.json().catch(() => []);
      if (r.ok) setRows(j);
      else setError(j?.error?.message ?? "Could not load announcements");
    })();
  }, []);

  function edit(id: string, field: string, value: any) {
    setDrafts(d => ({ ...d, [id]: { ...d[id], [field]: value } }));
  }

  async function post(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null); setNotice(null);
    setPosting(true);
    try {
      const res = await fetch(`${API}/api/v1/control/announcements`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          message: msg.trim(),
          kind,
          ...(startsAt ? { startsAt: fromLocalInput(startsAt) } : {}),
          ...(endsAt ? { endsAt: fromLocalInput(endsAt) } : {})
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "Post failed"); return; }
      setRows(rs => [j, ...rs]);
      setMsg(""); setStartsAt(""); setEndsAt("");
      setNotice("Posted — it is scrolling in every header now.");
      window.dispatchEvent(new Event("waisha:announcements"));
      setTimeout(() => setNotice(null), 4000);
    } finally { setPosting(false); }
  }

  async function save(a: Row) {
    setBusyId(a.id); setError(null);
    const d = drafts[a.id] ?? {};
    try {
      const res = await fetch(`${API}/api/v1/control/announcements/${a.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          message: d.message ?? a.message,
          kind: d.kind ?? a.kind,
          active: d.active ?? a.active,
          ...(d.startsAt !== undefined ? { startsAt: fromLocalInput(d.startsAt) } : {}),
          ...(d.endsAt !== undefined ? { endsAt: fromLocalInput(d.endsAt) } : {})
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "Save failed"); return; }
      setRows(rs => rs.map(r => (r.id === a.id ? j : r)));
      setDrafts(dd => { const n = { ...dd }; delete n[a.id]; return n; });
      window.dispatchEvent(new Event("waisha:announcements"));
      setSavedId(a.id);
      setTimeout(() => setSavedId(null), 2500);
    } finally { setBusyId(null); }
  }

  async function logout() {
    await fetch(`${API}/api/v1/control/auth/logout`, { method: "POST", credentials: "include" });
    window.location.href = "/control/login";
  }

  const cell = "w-full rounded-input border px-8 py-8 text-sm";
  const cellStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Super Admin · Announcements
          </p>
        </div>
        <AnnouncementTicker />
        <div className="flex items-center gap-16 text-xs font-semibold">
          <a href="/control" className="underline" style={{ color: "var(--adm-accent)" }}>Plans</a>
          <a href="/control/tenants" className="underline" style={{ color: "var(--adm-accent)" }}>Tenants</a>
          <a href="/control/directory" className="underline" style={{ color: "var(--adm-accent)" }}>Directory</a>
          <a href="/control/staff" className="underline" style={{ color: "var(--adm-accent)" }}>Staff</a>
          <span className="text-white">Announcements</span>
          <button type="button" className="rounded-input border px-16 py-8 text-white"
            style={{ borderColor: "rgba(255,255,255,0.4)" }}
            onClick={logout}>Sign out</button>
        </div>
      </header>

      <main className="mx-auto max-w-[900px] px-16 py-32">
        <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Announcements</h1>
        <p className="mt-8 mb-24 text-sm" style={{ color: "var(--ink-soft)" }}>
          These scroll through the middle of the header for every signed-in user — transporter portal, shipper portal and control.
          Switch one off when it is no longer relevant; entries are kept, never deleted.
        </p>

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

        <form onSubmit={post} className="mb-24 space-y-12 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Message</span>
            <textarea required minLength={4} maxLength={400} rows={2} value={msg}
              onChange={e => setMsg(e.target.value)}
              placeholder="e.g. Scheduled upgrade tonight 22:00–23:00 — the portal may briefly slow down."
              className={cell} style={cellStyle} />
          </label>
          <div className="grid gap-12 sm:grid-cols-3">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Type</span>
              <select value={kind} onChange={e => setKind(e.target.value)} className={cell} style={cellStyle}>
                {KINDS.map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Start (optional)</span>
              <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)}
                className={cell} style={cellStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>End (optional)</span>
              <input type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)}
                className={cell} style={cellStyle} />
            </label>
          </div>
          <button type="submit" disabled={posting}
            className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-60">
            {posting ? "Posting" : "Post announcement"}
          </button>
        </form>

        <div className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Message</th>
                <th className="p-12 w-28">Type</th>
                <th className="p-12 w-44">Starts</th>
                <th className="p-12 w-44">Ends</th>
                <th className="p-12 w-16">On</th>
                <th className="p-12 w-24">Status</th>
                <th className="p-12"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a, i) => {
                const d = drafts[a.id] ?? {};
                const st = statusOf({ ...a, ...(d.active !== undefined ? { active: d.active } : {}) });
                return (
                  <tr key={a.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className="p-8">
                      <textarea rows={2} className={cell} style={cellStyle}
                        defaultValue={d.message ?? a.message} maxLength={400}
                        onChange={e => edit(a.id, "message", e.target.value)} />
                    </td>
                    <td className="p-8">
                      <select className={cell} style={cellStyle} value={d.kind ?? a.kind}
                        onChange={e => edit(a.id, "kind", e.target.value)}>
                        {KINDS.map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
                      </select>
                    </td>
                    <td className="p-8">
                      <input type="datetime-local" className={cell} style={cellStyle}
                        value={d.startsAt !== undefined ? d.startsAt : toLocalInput(a.starts_at)}
                        onChange={e => edit(a.id, "startsAt", e.target.value)} />
                    </td>
                    <td className="p-8">
                      <input type="datetime-local" className={cell} style={cellStyle}
                        value={d.endsAt !== undefined ? d.endsAt : toLocalInput(a.ends_at)}
                        onChange={e => edit(a.id, "endsAt", e.target.value)} />
                    </td>
                    <td className="p-8 text-center">
                      <input type="checkbox" checked={d.active ?? a.active}
                        onChange={e => edit(a.id, "active", e.target.checked)} />
                    </td>
                    <td className="p-8">
                      <span className="text-[10px] font-bold uppercase tracking-[0.1em]"
                        style={{ borderLeft: `4px solid ${st.color}`, paddingLeft: 6, color: "var(--ink)" }}>
                        {st.label}
                      </span>
                    </td>
                    <td className="p-8">
                      <button type="button" disabled={busyId === a.id} onClick={() => save(a)}
                        className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
                        {busyId === a.id ? "Saving" : savedId === a.id ? "Saved" : "Save"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td className="p-16 text-sm" style={{ color: "var(--ink-soft)" }} colSpan={7}>
                  Nothing posted yet — the header bar stays hidden until the first announcement goes live.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-24 text-xs" style={{ color: "var(--ink-soft)" }}>
          The bar shows on the transporter, shipper and control headers, and refreshes on every page load.
          Words scroll continuously and pause on hover; users who prefer reduced motion see the text standing still.
        </p>
      </main>
    </div>
  );
}
