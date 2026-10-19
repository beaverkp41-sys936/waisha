import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { verifyAccessToken } from "../security/jwt.js";
import { ApiError } from "../util/errors.js";
import { checkPermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";
import { exportTableSchema, fileName, prepareTable } from "../export/table.js";
import { buildPdf } from "../export/pdf.js";
import { buildXlsx } from "../export/xlsx.js";

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
}
