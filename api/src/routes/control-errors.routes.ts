import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";

/**
 * The error desk (082) — every failure the system produced, in one register, read by the
 * seats that already read the technical report.
 *
 * Cross-tenant by definition, so every statement here is a definer call: a bare pool query
 * has no app.tenant_id and RLS would answer with nothing, which on this screen would read
 * as "the system is not failing" — the most misleading empty result the panel could produce.
 * The table has no grants at all, so a handler cannot rewrite its own bug into silence, and
 * the two writes the desk has are the only mutations the register accepts: a judgement on a
 * fingerprint, and an explicit retention decision.
 *
 * Gates: reading it is control.system.view, the same key the technical report and the
 * advisory use. Changing a judgement or deleting evidence is control.system.manage, and
 * both of those are audited with the actor who did it.
 */

const VIEW = "control.system.view";
const MANAGE = "control.system.manage";

/** Exported so the verify script executes the identical string, not a re-typing. */
export const ERROR_REGISTER_SQL =
  "select * from platform_auth.error_register($1,$2,$3,$4,$5)";
export const ERROR_OCCURRENCES_SQL =
  "select * from platform_auth.error_occurrences($1,$2)";
export const ERROR_SUMMARY_SQL = "select platform_auth.error_summary($1) as s";
export const ERROR_MARK_SQL =
  "select fingerprint, state, note, updated_at from platform_auth.mark_error($1,$2,$3,$4)";
export const ERROR_PRUNE_SQL = "select platform_auth.prune_errors($1) as r";

const KINDS = ["server", "client"] as const;
const STATES = ["open", "triaged", "resolved", "ignored", "untouched"] as const;
const FINGERPRINT = /^[0-9a-f]{8,64}$/;

const DAYS = z.coerce.number().int().min(1).max(90).default(7);
const LIMIT = z.coerce.number().int().min(1).max(300).default(100);

const triageSchema = z.object({
  state: z.enum(["open", "triaged", "resolved", "ignored"]),
  // Absent or blank keeps the previous sentence: a state change is not the moment to quietly
  // drop why the last seat made it. Only a new sentence rewrites one. (083.)
  note: z.string().trim().max(600).nullish()
}).strict();

function parseFingerprint(value: unknown): string {
  const raw = String(value ?? "");
  if (!FINGERPRINT.test(raw)) {
    throw new ApiError("NOT_FOUND", "That error line is not in the register.", 404);
  }
  return raw;
}

export async function controlErrorRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- the register ----------
  app.get("/control/errors", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`errors:uid:${req.control.user_id}`, 60, 60);

    const q = z.object({
      kind: z.enum(KINDS).optional(),
      state: z.enum(STATES).optional(),
      q: z.string().trim().max(200).optional(),
      days: DAYS,
      limit: LIMIT
    }).strict().parse(req.query ?? {});

    const { rows } = await pool.query(ERROR_REGISTER_SQL,
      [q.kind ?? null, q.state ?? null, q.q || null, q.days, q.limit]);
    const summary = await pool.query(ERROR_SUMMARY_SQL, [q.days]);

    return {
      window_days: q.days,
      filters: { kind: q.kind ?? null, state: q.state ?? null, q: q.q ?? null },
      summary: summary.rows[0]?.s ?? {},
      items: rows
    };
  });

  // ---------- one line, minute by minute ----------
  app.get("/control/errors/:fingerprint", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`errors-detail:uid:${req.control.user_id}`, 60, 60);

    const fingerprint = parseFingerprint((req.params as any).fingerprint);
    const limit = z.coerce.number().int().min(1).max(100).default(20)
      .parse((req.query as any)?.limit ?? 20);

    const { rows } = await pool.query(ERROR_OCCURRENCES_SQL, [fingerprint, limit]);
    if (!rows.length) {
      // An empty list would read as "this bug is in the register but never happened", which
      // is only ever true of a fingerprint nobody typed correctly. Same answer the triage
      // door gives for the same mistake.
      throw new ApiError("NOT_FOUND", "That error line is not in the register.", 404);
    }
    return { fingerprint, occurrences: rows };
  });

  // ---------- the desk's judgement ----------
  app.post("/control/errors/:fingerprint/triage", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`errors-triage:uid:${req.control.user_id}`, 60, 60);

    const fingerprint = parseFingerprint((req.params as any).fingerprint);
    const body = triageSchema.parse(req.body);

    const { rows } = await pool.query(ERROR_MARK_SQL,
      [fingerprint, body.state, body.note ?? null, req.control.user_id]);
    const row = rows[0];
    if (!row?.fingerprint) {
      // The definer refuses a state it does not know and a fingerprint the register has
      // never seen; the route turns either into an answer instead of a silent no-op.
      throw new ApiError("CONFLICT",
        "That error line cannot be triaged — it is not in the register.", 404);
    }

    await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
      entity: "app_errors", entityId: fingerprint, action: "control.error.triaged",
      after: { state: row.state, note: row.note !== null }
    }));
    return row;
  });

  // ---------- retention: an operator decision, not a background job ----------
  app.post("/control/errors/retention", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`errors-prune:uid:${req.control.user_id}`, 5, 3600);

    const body = z.object({ keepDays: z.number().int().min(7).max(3650) }).strict().parse(req.body);
    const { rows } = await pool.query(ERROR_PRUNE_SQL, [body.keepDays]);
    const result = rows[0]?.r ?? {};
    if (result.status !== "ok") {
      throw new ApiError("CONFLICT", result.message ?? "Retention was refused.", 400);
    }

    await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
      entity: "app_errors", entityId: null, action: "control.error.retention",
      after: { keep_days: body.keepDays, deleted: result.deleted, cutoff: result.cutoff }
    }));
    return {
      deleted: result.deleted ?? 0,
      keep_days: body.keepDays,
      cutoff: result.cutoff ? new Date(result.cutoff).toISOString() : null
    };
  });
}
