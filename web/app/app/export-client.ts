"use client";

import { authFetch } from "@/lib/session";

/**
 * The client half of the report export.
 *
 * A register is already on the screen as columns and rows, so the desk sends that
 * shape to the server and gets a real file back — the workbook and the printed page
 * are built by the same code for every report, which is what keeps the figures in
 * the file identical to the figures on the screen.
 *
 * Nothing is rendered here: a browser cannot be trusted to lay out a document an
 * operator signs for, and the duty gate has to be the server's, not a hidden button.
 */

export type ExportFormat = "xlsx" | "pdf";
export type ExportCellType = "text" | "money" | "number" | "date" | "bool";

export interface ExportColumn {
  key: string;
  label: string;
  type?: ExportCellType;
  /** Preferred width in points, for a column the printed page should not wrap. */
  width?: number;
}

export interface ExportTable {
  /** One of the register keys the server allowlists; it decides the duty checked. */
  report: string;
  title: string;
  subtitle?: string;
  meta?: { label: string; value: string }[];
  columns: ExportColumn[];
  rows: Record<string, string | number | boolean | null>[];
}

/**
 * Which registers this seat may export. A page that offers a button the role cannot
 * press is a dead end with a spinner, so the allowlist is fetched once per surface.
 * A failure answers with an empty set: no buttons, no guessing.
 */
export async function exportableReports(): Promise<Set<string>> {
  try {
    const res = await authFetch("/exports/reports", {}, () => { window.location.href = "/login"; });
    if (!res.ok) return new Set();
    const j = await res.json();
    return new Set<string>(Array.isArray(j?.reports) ? j.reports : []);
  } catch {
    return new Set();
  }
}

/** The server's own reason, if it gave one — otherwise the raw head of the answer. */
async function failure(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let message = "";
  try { message = String(JSON.parse(text)?.error?.message ?? ""); } catch { /* not JSON */ }
  if (message) return message;
  // A 500 behind a proxy answers HTML; the status is the only honest thing to show.
  return text.trim() ? `${res.status} ${text.trim().slice(0, 120)}` : `Export failed (${res.status}).`;
}

function stem(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report";
}

/**
 * A file named on this side of the wire is named for the clerk's day. UTC is four hours
 * behind Dar es Salaam, so a sheet worked on late in an afternoon would otherwise download
 * stamped with yesterday — and a folder of dated exports is only useful if the dates mean
 * the day somebody filed them.
 */
function officeDay(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Dar_es_Salaam", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

/**
 * Build a file on the server and hand it to the browser's downloader.
 *
 * Resolves with the name it saved under, so the caller can put that name in its own
 * confirmation — "Exported." with no file is not a confirmation.
 */
export async function downloadExport(table: ExportTable, format: ExportFormat): Promise<string> {
  const res = await authFetch("/exports/table", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...table, format })
  }, () => { window.location.href = "/login"; });

  if (!res.ok) throw new Error(await failure(res));

  const disposition = res.headers.get("Content-Disposition") ?? "";
  const named = /filename="?([^";]+)"?/i.exec(disposition);
  const name = named?.[1] ?? `${stem(table.title)}-${officeDay()}.${format}`;

  const blob = await res.blob();
  if (!blob.size) throw new Error("The export came back empty.");
  saveBlob(blob, name);
  return name;
}

/**
 * The batch archive for the cargo desk: one folder per selected file, each with its
 * registers as data and as a workbook, plus the documents stored against it.
 *
 * The server reads these rows rather than receiving them, so the archive carries the
 * registers a file has that no desk lists — the handovers, the cost lines, the parcels.
 * It is the slow export in the product, so the caller keeps its own progress line.
 */
export async function downloadCargoBatch(ids: string[]): Promise<string> {
  const res = await authFetch("/exports/cargo-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids })
  }, () => { window.location.href = "/login"; });

  if (!res.ok) throw new Error(await failure(res));

  const disposition = res.headers.get("Content-Disposition") ?? "";
  const named = /filename="?([^";]+)"?/i.exec(disposition);
  const name = named?.[1] ?? `cargo-files-${officeDay()}.zip`;

  const blob = await res.blob();
  if (!blob.size) throw new Error("The archive came back empty.");
  saveBlob(blob, name);
  return name;
}

/**
 * One cargo file, printed whole: every register the platform holds on it, as a
 * workbook or as a page.
 *
 * The server reads the rows — the desk never sends them — so this carries the registers
 * that no screen lists: the invoice lines, the debit note lines, the step checks. The
 * batch ZIP is still what carries the documents themselves; this is what carries the
 * facts about them.
 */
export async function downloadCargoFile(shipmentId: string, format: ExportFormat): Promise<string> {
  const res = await authFetch("/exports/cargo-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: shipmentId, format })
  }, () => { window.location.href = "/login"; });

  if (!res.ok) throw new Error(await failure(res));

  const disposition = res.headers.get("Content-Disposition") ?? "";
  const named = /filename="?([^";]+)"?/i.exec(disposition);
  const name = named?.[1] ?? `cargo-file-${shipmentId.slice(0, 8)}-${officeDay()}.${format}`;

  const blob = await res.blob();
  if (!blob.size) throw new Error("The export came back empty.");
  saveBlob(blob, name);
  return name;
}

/**
 * The master document bundle for one cargo file: the signed cover sheet as a printed
 * page, the three papers it names as they are stored, and a README that says which
 * of them were found.
 *
 * The server reads the pointers from the master register rather than receiving them,
 * so a sheet whose invoice was deleted after signing says so in the archive instead
 * of quietly shipping a folder with a gap in it.
 */
export async function downloadMasterBundle(shipmentId: string): Promise<string> {
  const res = await authFetch(`/cargo/${shipmentId}/master/bundle`, {
    method: "POST"
  }, () => { window.location.href = "/login"; });

  if (!res.ok) throw new Error(await failure(res));

  const disposition = res.headers.get("Content-Disposition") ?? "";
  const named = /filename="?([^";]+)"?/i.exec(disposition);
  const name = named?.[1] ?? `master-${shipmentId.slice(0, 8)}-${officeDay()}.zip`;

  const blob = await res.blob();
  if (!blob.size) throw new Error("The archive came back empty.");
  saveBlob(blob, name);
  return name;
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking on the next tick can cut the transfer short: the browser reads the
  // object URL when it starts writing the file, not when the click lands.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Flatten an object-of-objects report into the register the writers expect, so a
 * summary card and a table can both go into one file. Money columns are sent as
 * numbers, not as the formatted string on the screen — a figure that opens as text
 * cannot be summed, and that is the one thing an export is for.
 */
export function rowsFrom<T extends object>(
  rows: T[],
  pick: (keyof T)[]
): Record<string, string | number | boolean | null>[] {
  return rows.map((row) => {
    const out: Record<string, string | number | boolean | null> = {};
    for (const key of pick) {
      const v = row[key];
      out[key as string] = v === undefined ? null
        : typeof v === "object" || typeof v === "function" ? null
          : typeof v === "bigint" ? Number(v) : v as string | number | boolean;
    }
    return out;
  });
}
