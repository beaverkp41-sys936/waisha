"use client";

import { useEffect, useState } from "react";
import { FileSpreadsheet, FileText } from "lucide-react";
import {
  downloadExport, exportableReports,
  type ExportColumn, type ExportFormat
} from "@/app/app/export-client";

type Props = {
  /** One of the server's register keys — it decides the duty the export asks for. */
  report: string;
  title: string;
  subtitle?: string;
  meta?: { label: string; value: string }[];
  columns: ExportColumn[];
  rows: Record<string, string | number | boolean | null>[];
};

/**
 * Excel and PDF for the register the desk is showing.
 *
 * The buttons disappear when the seat holds no export duty rather than sitting there
 * waiting to answer 403, and the file name comes back into the notice: "Exported." with
 * no file to look at is not a confirmation an operator can act on.
 */
export function ExportButtons({ report, title, subtitle, meta, columns, rows }: Props) {
  // null until the duty list arrives, so the buttons start disabled instead of
  // appearing, disappearing and reappearing around the answer.
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    setAllowed(null);
    exportableReports().then((keys) => { if (live) setAllowed(keys.has(report)); });
    return () => { live = false; };
  }, [report]);

  if (allowed === false) return null;

  async function run(format: ExportFormat) {
    setBusy(format);
    setNote(null);
    try {
      const name = await downloadExport({ report, title, subtitle, meta, columns, rows }, format);
      setNote({ ok: true, text: `Saved ${name} · ${rows.length} row${rows.length === 1 ? "" : "s"}` });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "The export could not be built." });
    } finally {
      setBusy(null);
    }
  }

  const buttons: { format: ExportFormat; label: string; Icon: typeof FileSpreadsheet }[] = [
    { format: "xlsx", label: "Excel", Icon: FileSpreadsheet },
    { format: "pdf", label: "PDF", Icon: FileText }
  ];

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-8">
        {buttons.map(({ format, label, Icon }) => (
          <button key={format} type="button" onClick={() => run(format)}
            disabled={busy !== null || allowed === null}
            className="on-photo-btn flex items-center gap-8 min-h-[38px] px-16 py-8 text-xs font-semibold disabled:opacity-50">
            <Icon size={15} aria-hidden="true" />
            {busy === format ? "Building…" : label}
          </button>
        ))}
      </div>
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
