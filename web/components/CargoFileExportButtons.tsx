"use client";

import { useEffect, useState } from "react";
import { FileSpreadsheet, FileText } from "lucide-react";
import {
  downloadCargoFile, exportableReports, type ExportFormat
} from "@/app/app/export-client";

/**
 * Excel and PDF for the whole cargo file, not for the screen showing it.
 *
 * The server reads every register it holds on the file — the record, the stage history,
 * the tasks and their steps, the master sheet, the intake drafts it was typed from, the
 * quotations and the invoices and debit notes they became, the parcels and the handovers —
 * so the printed page lists more than this desk does. Because of that the notice counts
 * the registers that came back rather than pretending the file matches what the operator
 * can see. Like every export button it disappears when the seat holds no cargo duty: a
 * press would only answer 403.
 */
export function CargoFileExportButtons({ shipmentId, fileNumber }: { shipmentId: string; fileNumber: string }) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    exportableReports().then((keys) => { if (live) setAllowed(keys.has("cargo")); });
    return () => { live = false; };
  }, []);

  if (allowed === false) return null;

  async function run(format: ExportFormat) {
    setBusy(format);
    setNote({ ok: true, text: `Reading every register of ${fileNumber}…` });
    try {
      const name = await downloadCargoFile(shipmentId, format);
      setNote({ ok: true, text: `Saved ${name} — every register on this file, documents listed but not packed.` });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "The export could not be built." });
    } finally {
      setBusy(null);
    }
  }

  const buttons: { format: ExportFormat; label: string; Icon: typeof FileSpreadsheet }[] = [
    { format: "xlsx", label: "Excel (all)", Icon: FileSpreadsheet },
    { format: "pdf", label: "PDF (all)", Icon: FileText }
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
