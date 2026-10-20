"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface LastMessage { body: string; senderName: string | null; createdAt: string; }
interface Thread {
  scope: "general" | "shipment";
  title?: string; shipmentId?: string; fileNumber?: string; consigneeName?: string;
  status?: string; stage?: string;
  lastMessage: LastMessage | null; unread: number;
}
interface Attachment { id: string; fileName: string; mimeType: string; sizeBytes: number; }
interface Message {
  id: string; body: string; senderId: string; senderName: string | null;
  createdAt: string; attachments: Attachment[];
}
interface Conversation {
  scope: "general" | "shipment";
  shipment: { id: string; fileNumber: string; consigneeName: string; status: string; stage: string } | null;
  messages: Message[];
}

const MAX_FILES = 5;
const STATUS_COLORS: Record<string, string> = {
  open: "var(--success)", on_hold: "var(--gold)",
  completed: "var(--ink-soft)", cancelled: "var(--danger)"
};

function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((today - day) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "short", day: "numeric", month: "short",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric"
  });
}

function fmtSize(n: number): string {
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function initials(name: string | null): string {
  if (!name) return "?";
  return name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? "").join("");
}

function snippet(t: Thread): string {
  if (!t.lastMessage) return "No messages yet";
  const body = t.lastMessage.body || "Attachment";
  const sender = t.lastMessage.senderName?.split(" ")[0];
  return sender ? `${sender}: ${body}` : body;
}

/** The caller's user id, read from the access token — drives own-message styling. */
function myUserId(): string | null {
  try {
    const t = sessionStorage.getItem("waisha_access");
    if (!t) return null;
    let b64 = t.split(".")[1] ?? "";
    b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
    b64 = b64.padEnd(b64.length + (4 - (b64.length % 4)) % 4, "=");
    const p = JSON.parse(atob(b64));
    return typeof p.sub === "string" ? p.sub : null;
  } catch {
    return null;
  }
}

function MessagesContent() {
  const params = useSearchParams();
  const fileParam = params.get("file");

  const [threads, setThreads] = useState<Thread[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [activeKey, setActiveKey] = useState<string>(fileParam ?? "general");
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [loadingConversation, setLoadingConversation] = useState(true);

  const me = useRef<string | null>(null);
  useEffect(() => { me.current = myUserId(); }, []);

  const activeRef = useRef(activeKey);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinBottom = useRef(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadThreads = useCallback(async (silent?: boolean) => {
    if (!silent) setLoadingThreads(true);
    try {
      const res = await apiFetch("/messages/threads");
      if (res.ok) {
        const j = await res.json();
        setThreads(j.threads ?? []);
      }
    } finally {
      if (!silent) setLoadingThreads(false);
    }
  }, []);

  const loadConversation = useCallback(async (key: string, silent?: boolean) => {
    if (!silent) { setLoadingConversation(true); pinBottom.current = true; }
    const res = await apiFetch(`/messages${key === "general" ? "" : `?shipmentId=${key}`}`);
    if (activeRef.current !== key) return; // a newer switch won the race
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (!silent) { setConversation(null); setError(errorText(j, "Conversation not found.")); setLoadingConversation(false); }
      return;
    }
    setConversation(j);
    setLoadingConversation(false);
    // Opening marked the thread read — refresh so its badge clears.
    loadThreads(true);
  }, [loadThreads]);

  useEffect(() => {
    activeRef.current = activeKey;
    setError(null);
    loadConversation(activeKey);
    window.history.replaceState(null, "",
      activeKey === "general" ? "/app/cfa/messages" : `/app/cfa/messages?file=${activeKey}`);
  }, [activeKey, loadConversation]);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      loadThreads(true);
      loadConversation(activeRef.current, true);
    }, 15_000);
    return () => clearInterval(t);
  }, [loadThreads, loadConversation]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinBottom.current) el.scrollTop = el.scrollHeight;
  }, [conversation]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    pinBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  async function send(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = draft.trim();
    if (busy || !conversation || (!text && files.length === 0)) return;
    setBusy(true); setError(null);
    try {
      const res = await apiFetch("/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipmentId: activeKey === "general" ? null : activeKey, body: text })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to send.")); return; }

      const failed: string[] = [];
      for (const f of files) {
        const fd = new FormData();
        fd.append("entityType", "message");
        fd.append("entityId", j.id);
        fd.append("kind", "attachment");
        fd.append("file", f);
        const up = await apiFetch("/documents", { method: "POST", body: fd });
        if (!up.ok) failed.push(f.name);
      }

      setDraft(""); setFiles([]);
      pinBottom.current = true;
      if (failed.length) setError(`Message sent — these files could not attach: ${failed.join(", ")}`);
      await loadConversation(activeKey, true);
    } finally {
      setBusy(false);
    }
  }

  function pickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!list.length) return;
    setError(null);
    const next = [...files];
    for (const f of list) {
      if (next.length >= MAX_FILES) { setError(`Up to ${MAX_FILES} files per message.`); break; }
      if (f.size > 8 * 1024 * 1024) { setError(`"${f.name}" is larger than 8 MB.`); continue; }
      next.push(f);
    }
    setFiles(next);
  }

  async function removeMessage(id: string) {
    setError(null);
    const res = await apiFetch(`/messages/${id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Failed to delete.")); return; }
    await loadConversation(activeKey, true);
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "text-[11px] font-semibold uppercase tracking-[0.14em]";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[1100px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Internal Messages</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        One conversation per cargo file, plus a team channel for the whole office — messages carry files
        straight from the documents vault.
      </p>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      <div className="mt-24 grid grid-cols-1 gap-16 md:grid-cols-[300px_1fr]">
        {/* Thread list */}
        <aside className="self-start overflow-hidden rounded-card border bg-surface" style={cardStyle}>
          <div className="border-b px-16 py-12" style={{ borderColor: "var(--line)" }}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Conversations</p>
          </div>
          <div className="max-h-[70dvh] overflow-y-auto">
            {threads.map(t => {
              const key = t.scope === "general" ? "general" : t.shipmentId!;
              const active = key === activeKey;
              return (
                <button key={key} type="button" onClick={() => setActiveKey(key)}
                  className="block w-full border-b px-16 py-12 text-left"
                  style={{
                    borderColor: "var(--line)",
                    borderLeft: active ? "4px solid var(--brand)" : "4px solid transparent",
                    background: active ? "color-mix(in srgb, var(--brand) 8%, transparent)" : "transparent"
                  }}>
                  <div className="flex items-center justify-between gap-8">
                    <span className="truncate text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {t.scope === "general" ? (t.title ?? "Team channel") : t.fileNumber}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                      {t.lastMessage ? when(t.lastMessage.createdAt) : ""}
                    </span>
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-8">
                    <span className="truncate text-xs" style={{ color: "var(--ink-soft)" }}>
                      {t.scope === "shipment" && t.consigneeName ? `${t.consigneeName} · ` : ""}
                      {snippet(t)}
                    </span>
                    {t.unread > 0 && (
                      <span className="shrink-0 rounded-full px-8 py-2 text-[10px] font-bold"
                        style={{ background: "#c9a84c", color: "#09263c" }}>{t.unread}</span>
                    )}
                  </div>
                  {t.scope === "shipment" && (
                    <span className="mt-4 inline-block text-[10px] font-bold uppercase"
                      style={{ color: STATUS_COLORS[t.status ?? "open"] ?? "var(--ink-soft)" }}>
                      {(t.status ?? "open").replace("_", " ")}
                    </span>
                  )}
                </button>
              );
            })}
            {loadingThreads && threads.length === 0 && (
              <p className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</p>
            )}
            {!loadingThreads && threads.length === 0 && (
              <p className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>No conversations yet.</p>
            )}
          </div>
        </aside>

        {/* Conversation */}
        <section className="flex min-h-[520px] flex-col overflow-hidden rounded-card border bg-surface" style={cardStyle}>
          <div className="flex flex-wrap items-center justify-between gap-12 border-b px-16 py-12" style={{ borderColor: "var(--line)" }}>
            <div>
              <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
                {conversation?.scope === "shipment" ? conversation.shipment?.fileNumber : "Team channel"}
              </p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                {conversation?.scope === "shipment"
                  ? `${conversation.shipment?.consigneeName ?? ""} · ${(conversation.shipment?.status ?? "").replace("_", " ")}`
                  : "Everyone in your organisation"}
              </p>
            </div>
            {conversation?.scope === "shipment" && conversation.shipment && (
              <Link href={`/app/cfa/cargo/${conversation.shipment.id}`} className="text-xs underline" style={{ color: "var(--brand)" }}>
                Open cargo file
              </Link>
            )}
          </div>

          <div ref={scrollRef} onScroll={onScroll}
            className="flex-1 space-y-12 overflow-y-auto px-16 py-16" style={{ maxHeight: "58dvh", minHeight: "320px" }}>
            {loadingConversation && !conversation && (
              <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Loading conversation…</p>
            )}
            {conversation && conversation.messages.length === 0 && (
              <p className="text-sm" style={{ color: "var(--ink-soft)" }}>No messages yet — start the conversation below.</p>
            )}
            {conversation?.messages.map((m, i) => {
              const prev = conversation.messages[i - 1];
              const showDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
              const mine = me.current !== null && m.senderId === me.current;
              return (
                <div key={m.id}>
                  {showDay && (
                    <p className="my-12 text-center text-[10px] font-bold uppercase tracking-[0.14em]"
                      style={{ color: "var(--ink-soft)" }}>{dayLabel(m.createdAt)}</p>
                  )}
                  <div className={`flex gap-8 ${mine ? "justify-end" : "justify-start"}`}>
                    {!mine && (
                      <span className="mt-2 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                        style={{ background: "var(--milk-deep)", color: "var(--ink)" }}>{initials(m.senderName)}</span>
                    )}
                    <div className="max-w-[75%]">
                      <div className="rounded-card border px-12 py-8"
                        style={{
                          borderColor: "var(--line)",
                          background: mine ? "color-mix(in srgb, var(--brand) 10%, transparent)" : "var(--milk)"
                        }}>
                        {m.body && <p className="whitespace-pre-wrap text-sm" style={{ color: "var(--ink)" }}>{m.body}</p>}
                        {m.attachments.length > 0 && (
                          <div className={`${m.body ? "mt-8 " : ""}space-y-4`}>
                            {m.attachments.map(a => <AttachmentChip key={a.id} doc={a} />)}
                          </div>
                        )}
                      </div>
                      <div className={`mt-4 flex items-center gap-8 text-[10px] ${mine ? "justify-end" : ""}`}
                        style={{ color: "var(--ink-soft)" }}>
                        <span>{mine ? "You" : (m.senderName ?? "Member")} · {when(m.createdAt)}</span>
                        {mine && (
                          <button type="button" className="underline" style={{ color: "var(--danger)" }}
                            onClick={() => removeMessage(m.id)}>Delete</button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <form onSubmit={send} className="border-t px-16 py-12" style={{ borderColor: "var(--line)" }}>
            {files.length > 0 && (
              <div className="mb-8 flex flex-wrap gap-8">
                {files.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="flex items-center gap-8 rounded-input border px-8 py-4 text-xs"
                    style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                    {f.name} <span style={{ color: "var(--ink-soft)" }}>{fmtSize(f.size)}</span>
                    <button type="button" aria-label={`Remove ${f.name}`} style={{ color: "var(--danger)" }}
                      onClick={() => setFiles(files.filter((_, n) => n !== i))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-8">
              <textarea value={draft} rows={2}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Write a message… Enter to send, Shift+Enter for a new line"
                className={`${inputCls} resize-y`} style={inputStyle} />
              <input ref={fileInputRef} type="file" multiple hidden
                accept=".pdf,image/jpeg,image/png,image/webp" onChange={pickFiles} />
              <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}
                className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-50"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Attach</button>
              <button type="submit" disabled={busy || !conversation || (!draft.trim() && files.length === 0)}
                className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-60">
                {busy ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

function AttachmentChip({ doc }: { doc: Attachment }) {
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true);
    try {
      const res = await apiFetch(`/documents/${doc.id}/url`);
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.url) window.open(j.url, "_blank", "noreferrer");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" onClick={open} disabled={busy}
      className="flex w-full items-center justify-between gap-8 rounded-input border px-8 py-4 text-left text-xs"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      <span className="truncate" style={{ color: "var(--brand)" }}>{doc.fileName}</span>
      <span className="shrink-0" style={{ color: "var(--ink-soft)" }}>
        {fmtSize(doc.sizeBytes)} · {busy ? "Opening…" : "Open"}
      </span>
    </button>
  );
}

export default function MessagesPage() {
  return (
    <Suspense fallback={
      <div className="pane-note mx-auto max-w-[1100px] px-16 py-32 text-sm">Loading…</div>
    }>
      <MessagesContent />
    </Suspense>
  );
}
