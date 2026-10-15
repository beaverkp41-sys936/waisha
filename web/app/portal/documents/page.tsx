"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { portalFetch } from "../api-client";
import { fmtDateTime, fmtBytes, errorText } from "../labels";

export default function PortalDocumentsPage() {
  const [docs, setDocs] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await portalFetch("/portal/documents");
        const j = await res.json().catch(() => ({}));
        if (!res.ok) setError(errorText(j, "Could not load your documents."));
        else setDocs(j);
      } catch (e: any) {
        if (e.message !== "session ended") setError("Could not load your documents.");
      } finally { setReady(true); }
    })();
  }, []);

  async function openDocument(id: string) {
    const res = await portalFetch(`/portal/documents/${id}/url`);
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.url) window.open(j.url, "_blank", "noopener");
  }

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Documents</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Documents shared on your cargo files — and the ones you uploaded yourself.
      </p>

      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      {!ready ? (
        <p className="mt-24 text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</p>
      ) : docs.length === 0 ? (
        <div className="mt-24 rounded-card border bg-surface p-24 text-sm" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
          No documents yet. Open a cargo file to view or upload documents.
        </div>
      ) : (
        <ul className="mt-24 space-y-8">
          {docs.map(d => (
            <li key={d.id} className="flex items-center justify-between gap-12 rounded-card border bg-surface px-16 py-12"
              style={{ borderColor: "var(--line)" }}>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold" style={{ color: "var(--ink)" }}>{d.file_name}</span>
                <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  File {d.file_number} · {d.kind.replace(/_/g, " ")} · {fmtBytes(d.size_bytes)} · {fmtDateTime(d.created_at)}
                </span>
              </span>
              <button type="button" onClick={() => openDocument(d.id)}
                className="whitespace-nowrap text-xs underline" style={{ color: "var(--brand)" }}>
                View
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-24 text-xs" style={{ color: "var(--ink-soft)" }}>
        Need to send your agent a document? Open the relevant cargo file from{" "}
        <Link href="/portal/files" className="underline" style={{ color: "var(--brand)" }}>My files</Link> and use the upload form there.
      </p>
    </div>
  );
}
