"use client";

import { useEffect, useState } from "react";
import { FileArchive } from "lucide-react";
import { downloadCargoBatch, exportableReports } from "@/app/app/export-client";

/** The server refuses a batch larger than this, so say so before the press, not after. */
const MAX_FILES = 25;

/**
 * The archive of everything the platform knows about the ticked cargo files.
 *
 * This is the slow export in the product: the server reads twenty registers per file
 * and then walks Supabase Storage for the documents, so the button keeps its own
 * progress line instead of pretending a press is instant. Like the register buttons it
 * disappears when the seat holds no cargo export duty — a press would only answer 403.
 */
export function CargoBatchButton({ ids }: { ids: string[] }) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    exportableReports().then((keys) => { if (live) setAllowed(keys.has("cargo")); });
    return () => { live = false; };
  }, []);

  if (allowed === false) return null;

  const tooMany = ids.length > MAX_FILES;
  const disabled = busy || allowed === null || ids.length === 0 || tooMany;

  async function run() {
    setBusy(true);
    setNote({ ok: true, text: `Packing ${ids.length} file${ids.length === 1 ? "" : "s"} — documents are fetched as the archive is built.` });
    try {
      const name = await downloadCargoBatch(ids);
      setNote({ ok: true, text: `Saved ${name} · ${ids.length} file${ids.length === 1 ? "" : "s"}` });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "The archive could not be built." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0">
      <button type="button" onClick={run} disabled={disabled}
        className="on-photo-btn flex items-center gap-8 min-h-[38px] px-16 py-8 text-xs font-semibold disabled:opacity-50">
        <FileArchive size={15} aria-hidden="true" />
        {busy ? "Packing…" : `ZIP selected (${ids.length})`}
      </button>
      {ids.length === 0 && allowed === true && (
        <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
          Tick the files to archive, up to {MAX_FILES} at a time.
        </p>
      )}
      {tooMany && (
        <p className="mt-8 text-xs" style={{ color: "var(--warning)" }}>
          One batch takes {MAX_FILES} files — untick {ids.length - MAX_FILES}.
        </p>
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} aria-live="polite"
          className="mt-8 break-words text-xs"
          style={{ color: note.ok ? "var(--success)" : "var(--danger)" }}>
          {note.text}
        </p>
      )}
    </div>
  );
}
