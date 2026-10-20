import { createHash } from "node:crypto";
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { verifyAccessToken } from "../security/jwt.js";
import { ApiError } from "../util/errors.js";
import { checkPermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";
import { exportTableSchema, fileName, prepareTable, type PreparedTable } from "../export/table.js";
import { buildPdf } from "../export/pdf.js";
import { buildWorkbook, buildXlsx } from "../export/xlsx.js";
import { bundleDocumentSizes, bundleReadme, bundleRecord, bundleTables,
  loadBundleCatalog, readCargoBundle } from "../export/cargo.js";
import { ZipWriter } from "../export/zip.js";
import { getObject, storageConfigured } from "../storage/supabase.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

/**
 * Which register a seat may print, and the duty that lets it.
 *
 * The rows arrive from the browser, so this endpoint cannot read anything the caller
 * could not already see on screen. The table is here for the other half of the question:
 * producing an official-looking register of the payroll, the customs files or the audit
 * trail is a duty in its own right, and the platform already seeds one per module as
 * `<module>.export`. A report with no seeded export duty is gated on its read duty.
 */
const REPORTS: Record<string, string> = {
  summary: "reports.export",
  cargo: "shipments.export",
  "cargo-delays": "shipments.export",
  invoices: "invoices.export",
  receipts: "invoices.export",
  ledger: "costs.export",
  costs: "costs.export",
  "office-costs": "office_costs.view",
  budgets: "office_budgets.view",
  "office-tasks": "office_tasks.view",
  payroll: "payroll.view",
  "trip-pay": "driver_pay.view",
  employees: "employees.view",
  trainees: "trainee_reports.view",
  attendance: "attendance.view",
  leave: "leave.view",
  drivers: "drivers.export",
  fleet: "fleet.export",
  trips: "trips.export",
  routes: "routes.export",
  incidents: "incidents.export",
  fuel: "tracking.export",
  inventory: "tracking.export",
  compliance: "screening.view",
  quotations: "quotations.export",
  consolidation: "consolidation.export",
  customers: "customers.export",
  jobs: "jobs.view",
  documents: "documents.export",
  tax: "tax.view",
  "shipper-accounts": "shipper_accounts.view"
};

/** A 20 000-row PDF is 700 pages of drawText on the API box: Excel is the file for that. */
const PDF_ROW_CAP = 3000;

const body = exportTableSchema.extend({
  format: z.enum(["xlsx", "pdf"])
});

export async function exportRoutes(app: FastifyInstance, _opts: unknown) {

  /** The registers the signed-in seat is allowed to print — the web hides the rest. */
  app.get("/exports/reports", { preHandler: [requireAuth] }, async (req: any) => {
    const allowed = await withTenant(req.user.tid, async (c) => {
      const out: string[] = [];
      for (const [report, key] of Object.entries(REPORTS)) {
        if (await checkPermission(c, req.user.sub, key)) out.push(report);
      }
      return out;
    });
    return { reports: allowed };
  });

  /**
   * Build one register as a workbook or a printed page.
   *
   * The payload is the table the desk is displaying, so the file always matches the
   * screen — including the rows past the fold, which is the whole reason the operator
   * asked for it. Nothing is read from the database here on purpose: a second query
   * would answer with a different figure than the one the operator is looking at the
   * moment a page turns underneath them.
   */
  app.post("/exports/table", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const input = body.parse(req.body);
    const duty = REPORTS[input.report];
    if (!duty) {
      throw new ApiError("VALIDATION_FAILED", `Unknown report "${input.report}".`, 400);
    }
    const { allowed, actor } = await withTenant(req.user.tid, async (c) => {
      const ok = await checkPermission(c, req.user.sub, duty);
      // The name goes on the face of the file: a register handed to an auditor says
      // whose desk printed it. The token carries no name, so it is read from the seat.
      const who = ok
        ? await c.query("select full_name from users where id = $1", [req.user.sub])
        : null;
      return { allowed: ok, actor: who?.rows[0]?.full_name ?? req.user.sub };
    });
    if (!allowed) {
      throw new ApiError("FORBIDDEN", `Your role does not allow exporting this report (${duty}).`, 403);
    }
    if (input.format === "pdf" && input.rows.length > PDF_ROW_CAP) {
      throw new ApiError("VALIDATION_FAILED",
        `A printed register stops at ${PDF_ROW_CAP} rows — take Excel for all ${input.rows.length}.`, 413);
    }

    const table = prepareTable(input, actor);
    const pdf = input.format === "pdf";
    const bytes = pdf ? await buildPdf(table) : await buildXlsx(table);

    await withTenant(req.user.tid, (c) => writeAudit(c, {
      tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
      // No entity_id: an export is not a row. The register's own key is carried in
      // `after.report`, because this column is a uuid and the log must stay joinable
      // to the ones that do name a record.
      entity: "report_exports", entityId: null,
      action: pdf ? "export.pdf" : "export.xlsx",
      after: { report: input.report, title: table.title, columns: table.columns.length,
        rows: table.cells.length, bytes: bytes.length }
    }));

    reply.header("Content-Disposition", `attachment; filename="${fileName(table, input.format)}"`);
    reply.header("Cache-Control", "no-store");
    reply.type(pdf
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return bytes;
  });

  /**
   * A batch of cargo files, each with everything the platform knows about it.
   *
   * Unlike the register endpoint this one reads from the database, because the operator
   * is not asking for the table on the screen — they are asking for the file. So the
   * gate is the same duty (`shipments.export`), and every statement of the read is
   * scoped to the caller's tenant in its own WHERE clause: the bundle cannot reach a row
   * the desk could not already open, and encrypted columns are never selected at all
   * (see `export/cargo.ts`).
   *
   * The archive is written straight onto the socket as it is assembled: a batch is 25
   * files of registers plus their stored documents, and holding all of that in memory to
   * answer with one Buffer would be the reason the request fails. Each file is read in
   * its own short transaction and streamed before the next one begins, so the pool is not
   * held while Supabase Storage is being downloaded from, and only one file's rows are
   * ever resident.
   */
  const MAX_BATCH_FILES = 25;
  const MAX_BATCH_BYTES = 200 * 1024 * 1024;

  const batchBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(MAX_BATCH_FILES) });

  app.post("/exports/cargo-batch", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const ids = [...new Set(batchBody.parse(req.body).ids)];
    const duty = REPORTS.cargo;

    // Everything that can still be answered with a status code is answered here, before
    // a byte of the archive exists: a half-written download is worse than a refusal.
    // The tenant predicate is written, not inherited — this connection holds BYPASSRLS,
    // so `withTenant` alone would let another company's file id through.
    const gate = await withTenant(req.user.tid, async (c) => {
      if (!await checkPermission(c, req.user.sub, duty)) return { allowed: false as const };
      const files: { id: string; fileNumber: string; documents: number; bytes: number }[] = [];
      for (const id of ids) {
        const one = await c.query(
          "select file_number from cargo_shipments where id = $1 and tenant_id = $2",
          [id, req.user.tid]);
        if (!one.rowCount) continue;
        const size = await bundleDocumentSizes(c, id);
        files.push({ id, fileNumber: String(one.rows[0].file_number ?? id), ...size });
      }
      const who = await c.query(
        "select full_name from users where id = $1 and tenant_id = $2",
        [req.user.sub, req.user.tid]);
      return {
        allowed: true as const, files,
        actor: who.rows[0]?.full_name ?? req.user.sub,
        bytes: files.reduce((n, f) => n + f.bytes, 0)
      };
    });
    if (!gate.allowed) {
      throw new ApiError("FORBIDDEN", `Your role does not allow exporting cargo files (${duty}).`, 403);
    }
    const missing = ids.filter((id) => !gate.files.some((f) => f.id === id));
    if (missing.length) {
      throw new ApiError("NOT_FOUND",
        `${missing.length} of these cargo files is not on your desk. Nothing was exported.`, 404);
    }
    if (gate.bytes > MAX_BATCH_BYTES) {
      throw new ApiError("VALIDATION_FAILED",
        `These ${gate.files.length} files hold ${(gate.bytes / 1048576).toFixed(0)} MB of documents `
        + `and one batch stops at ${MAX_BATCH_BYTES / 1048576} MB — take fewer files at a time.`, 413);
    }

    const actor = gate.actor;
    const generatedAt = new Date();
    const catalog = await withTenant(req.user.tid, loadBundleCatalog);

    reply.hijack();
    const res: ServerResponse = reply.raw;
    // hijack() leaves the reply pipeline, so the guards helmet and the CORS plugin had
    // already decided have to be written onto the socket by hand.
    const headers: Record<string, string> = {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="cargo-files-${generatedAt
        .toISOString().slice(0, 10)}.zip"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    };
    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (/^access-control-/i.test(key) && value !== undefined) headers[key] = String(value);
    }
    res.writeHead(200, headers);

    const zip = new ZipWriter();
    const checksums: string[] = [];
    const skipped: { entry: string; reason: string }[] = [];
    const packed: { file: string; folder: string; registers: number; rows: number;
      documents: number; bytes: number }[] = [];
    let aborted = false;
    let failure: string | null = null;
    // An operator who closes the tab mid-download must not leave this request hanging on
    // a drain that will never come.
    const stop = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) { aborted = true; stop.abort(); }
    });

    const put = async (name: string, data: Buffer): Promise<string> => {
      if (aborted) return name;
      const entry = zip.add(name, data);
      checksums.push(`${createHash("sha256").update(data).digest("hex")}  ${entry.name}`);
      for (const chunk of entry.chunks) {
        if (aborted || res.writableEnded) return entry.name;
        if (!res.write(chunk)) await once(res, "drain", { signal: stop.signal }).catch(() => {});
      }
      // The writer's own name, which is not always the one asked for: a second
      // `BL.pdf` becomes `BL (2).pdf`, and a manifest that printed the first name
      // would point at the wrong file.
      return entry.name;
    };

    try {
      for (const file of gate.files) {
        if (aborted) break;
        const bundle = await withTenant(req.user.tid, (c) => readCargoBundle(c, catalog, file.id));
        if (!bundle) continue;   // deleted between the gate and here — the manifest says so

        // The bytes go in first, so the record, the readme and the workbook can state
        // where each of them actually ended up rather than where it was meant to go.
        for (const doc of bundle.documents) {
          if (aborted) break;
          if (!storageConfigured()) {
            const reason = "this deployment has no storage configured";
            doc.missing = reason;
            skipped.push({ entry: doc.entryName, reason });
            continue;
          }
          let bytes: Buffer | null = null;
          try {
            bytes = (await getObject(doc.storagePath)).bytes;
          } catch (e: any) {
            const reason: string = e?.message ?? "the stored object could not be read";
            doc.missing = reason;
            skipped.push({ entry: doc.entryName, reason });
            continue;
          }
          doc.sha256 = createHash("sha256").update(bytes).digest("hex");
          doc.entryName = await put(doc.entryName, bytes);
        }

        await put(`${bundle.folder}/README.txt`, Buffer.from(bundleReadme(bundle, actor, generatedAt), "utf8"));
        await put(`${bundle.folder}/record.json`, Buffer.from(bundleRecord(bundle, actor, generatedAt), "utf8"));

        // Written last, so its Documents sheet can carry the checksums of what it points at.
        const workbook = await buildWorkbook(bundleTables(bundle, generatedAt, actor));
        await put(`${bundle.folder}/cargo-file.xlsx`, workbook);
        packed.push({
          file: bundle.fileNumber, folder: bundle.folder,
          registers: bundle.registers.length + (bundle.documents.length ? 1 : 0),
          rows: bundle.rowCount, documents: bundle.documents.filter((d) => !d.missing).length,
          bytes: bundle.documents.filter((d) => !d.missing)
            .reduce((n, d) => n + d.sizeBytes, 0)
        });
      }

      await put("README.txt", Buffer.from(rootReadme(actor, generatedAt, packed, skipped, gate.files.length), "utf8"));
      await put("batch-register.xlsx", await buildWorkbook([batchRegister(packed, actor, generatedAt)]));
      await put("SHA256SUMS.txt", Buffer.from(`${checksums.join("\n")}\n`, "utf8"));
      for (const chunk of zip.finish()) {
        if (aborted || res.writableEnded) break;
        if (!res.write(chunk)) await once(res, "drain", { signal: stop.signal }).catch(() => {});
      }
    } catch (e: any) {
      // Headers are already away, so this cannot become a 500 — it becomes an audit row
      // and a manifest that does not claim to be complete.
      failure = String(e?.message ?? e).slice(0, 300);
      req.log.error({ err: e }, "cargo batch export failed");
    }

    if (!res.writableEnded) res.end();

    await withTenant(req.user.tid, (c) => writeAudit(c, {
      tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
      entity: "report_exports", entityId: null, action: "export.zip",
      after: { report: "cargo", files: packed.length, requested: ids.length,
        entries: zip.entryCount, bytes: zip.bytesWritten, documents_skipped: skipped.length,
        aborted, failure }
    }));
  });
}

function batchRegister(
  packed: { file: string; folder: string; registers: number; rows: number; documents: number;
    bytes: number }[],
  actor: string, generatedAt: Date
): PreparedTable {
  return {
    report: "cargo-batch",
    title: "Cargo batch",
    subtitle: "One folder per file: record.json, cargo-file.xlsx and documents/",
    meta: [{ label: "Files", value: String(packed.length) }],
    columns: [
      { key: "file", label: "File number", type: "text", width: 160 },
      { key: "folder", label: "Folder in archive", type: "text", width: 280 },
      { key: "registers", label: "Registers", type: "number" },
      { key: "rows", label: "Rows", type: "number" },
      { key: "documents", label: "Documents", type: "number" },
      { key: "bytes", label: "Document bytes", type: "number" }
    ],
    cells: packed.map((p) => [p.file, p.folder, p.registers, p.rows, p.documents, p.bytes]),
    generatedAt,
    actor
  };
}

function rootReadme(actor: string, generatedAt: Date,
  packed: { file: string; folder: string; registers: number; rows: number; documents: number;
    bytes: number }[],
  skipped: { entry: string; reason: string }[], requested: number): string {
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  const lines = [
    "Waisha cargo batch",
    `Exported ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC by ${actor}`,
    "",
    `${packed.length} of ${requested} requested file(s) are in this archive. Each folder holds:`,
    "  record.json       every register of that file as data",
    "  cargo-file.xlsx   the same registers, one sheet each, with totals",
    "  documents/        the stored documents, exactly as uploaded",
    "",
    "Files:",
    ...packed.map((p) => `  ${p.file.padEnd(18)} ${String(p.registers).padStart(2)} registers, `
      + `${String(p.rows).padStart(5)} rows, ${String(p.documents).padStart(3)} document(s), `
      + `${mb(p.bytes)}`),
    "",
    "Encrypted columns and their search hashes (NIDA numbers, phone numbers, password and",
    "TOTP material) are never selected into a bundle. Each folder's README lists the exact",
    "column names withheld from its tables.",
    "",
    "Timestamps in every file are UTC (a name ending in Z); a plain date is a calendar day.",
    "",
    `Integrity: sha256sum -c SHA256SUMS.txt   (${packed.length ? "checks every entry" : "no entries"})`
  ];
  if (skipped.length) {
    lines.push("", `Documents that could not be read and are NOT in this archive (${skipped.length}):`,
      ...skipped.map((s) => `  ${s.entry}: ${s.reason}`));
  }
  return lines.join("\n") + "\n";
}
