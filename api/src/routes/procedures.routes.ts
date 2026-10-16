import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";
import { materializeTaskFlow, readTaskFlow, setCheckTick } from "../operations/task-flow.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

/**
 * A trigger raised the gate (056): the checklist is still open, an earlier step
 * is unfinished, or a closed flow is being rewritten. The database holds those
 * rules so the route does not have to remember them — and its message is the
 * reason, which is exactly what the desk needs to see.
 */
function gateConflict(e: unknown): ApiError | null {
  const err = e as { code?: string; message?: string };
  if (!err || err.code !== "P0001" || typeof err.message !== "string") return null;
  const message = err.message.split("\n")[0];
  return new ApiError("CONFLICT", message, 409);
}

// doc_kind speaks the documents vault's own vocabulary; it is a label, not a key,
// so it is validated by shape rather than against an enum the vault keeps moving.
const docKind = z.string().trim().min(2).max(40).regex(/^[a-z][a-z_]*$/);

const stepSchema = z.object({
  seq: z.number().int().min(1).max(25),
  name: z.string().trim().min(2).max(160),
  instructions: z.string().trim().max(1000).nullable().optional(),
  checklist: z.array(z.string().trim().min(1).max(120)).max(15).default([]),
  requiredDocuments: z.array(docKind).max(15).default([]),
  isFinal: z.boolean().default(false)
});

const procedureSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(500).nullable().optional(),
  scope: z.enum(["office", "cargo"]).default("office"),
  steps: z.array(stepSchema).min(1).max(25)
});

const procedureUpdateSchema = procedureSchema.partial().extend({
  isActive: z.boolean().optional()
});

const flowAttachSchema = z.object({ procedureId: z.string().uuid() });

const stepStatusSchema = z.object({
  status: z.enum(["not_started", "in_progress", "blocked", "done"]).optional(),
  blockedReason: z.string().trim().max(500).nullable().optional()
});

const tickSchema = z.object({
  ticked: z.boolean(),
  evidence: z.string().trim().max(500).nullable().optional()
});

const checkAddSchema = z.object({
  label: z.string().trim().min(2).max(120),
  requiresDocument: z.boolean().default(false),
  docKind: docKind.nullable().optional()
});

const STEPS_JSON_SQL = `coalesce((select json_agg(json_build_object(
    'seq', s.seq, 'name', s.name, 'instructions', s.instructions,
    'checklist', s.checklist, 'required_documents', s.required_documents,
    'is_final', s.is_final) order by s.seq)
  from task_procedure_steps s
  where s.procedure_id = p.id and s.deleted_at is null), '[]'::json)`;

export async function proceduresRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- The procedure library ----------

  app.get("/procedures", { preHandler: [requireAuth, requirePermission("procedures.view")] },
    async (req: any) => {
      const q = z.object({ scope: z.enum(["office", "cargo"]).optional() }).parse(req.query);
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select p.id, p.name, p.description, p.scope, p.is_active,
                (p.tenant_id is null) as is_system,
                ${STEPS_JSON_SQL} as steps,
                (select count(*)::int from office_tasks t
                  where t.procedure_id = p.id
                    and t.status in ('pending','in_progress')) as open_tasks
         from task_procedures p
         where p.deleted_at is null
           and (p.tenant_id is null or p.tenant_id = $1)
           and ($2::text is null or p.scope = $2)
         order by (p.tenant_id is null) desc, p.name`,
        [req.user.tid, q.scope ?? null]));
      return rows;
    });

  app.post("/procedures", { preHandler: [requireAuth, requirePermission("procedures.create")] },
    async (req: any, reply) => {
      const body = procedureSchema.parse(req.body);
      const id = uuidv7();
      try {
        await withTenant(req.user.tid, async (c) => {
          assertSequence(body.steps);
          await c.query(
            `insert into task_procedures (id, tenant_id, name, description, scope, is_active,
               created_by, updated_by)
             values ($1,$2,$3,$4,$5,true,$6,$6)`,
            [id, req.user.tid, body.name, body.description ?? null, body.scope, req.user.sub]);
          await insertSteps(c, req.user.tid, id, body.steps);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "task_procedures", entityId: id,
            action: "procedure.created",
            after: { name: body.name, scope: body.scope, steps: body.steps.length }
          });
        });
      } catch (e) {
        const conflict = translate(e);
        if (conflict) throw conflict;
        throw e;
      }
      return reply.status(201).send({ id });
    });

  // Copy a shipped default (or anyone's own) into the tenant, where it can then
  // be edited. The library stays read-only from below; tenants work on copies.
  app.post("/procedures/:id/duplicate",
    { preHandler: [requireAuth, requirePermission("procedures.create")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({ name: z.string().trim().min(2).max(160).optional() }).parse(req.body ?? {});
      const newId = uuidv7();
      try {
        await withTenant(req.user.tid, async (c) => {
          const src = await c.query(
            `select p.name, p.description, p.scope from task_procedures p
              where p.id = $1 and p.deleted_at is null
                and (p.tenant_id is null or p.tenant_id = $2)`,
            [id, req.user.tid]);
          if (!src.rowCount) throw new ApiError("NOT_FOUND", "Procedure not found", 404);
          await c.query(
            `insert into task_procedures (id, tenant_id, name, description, scope, is_active,
               created_by, updated_by)
             values ($1,$2,$3,$4,$5,true,$6,$6)`,
            [newId, req.user.tid, body.name ?? `${src.rows[0].name} (copy)`,
             src.rows[0].description, src.rows[0].scope, req.user.sub]);
          await c.query(
            `insert into task_procedure_steps
               (tenant_id, procedure_id, seq, name, instructions, checklist, required_documents, is_final)
             select $2, $1, s.seq, s.name, s.instructions, s.checklist, s.required_documents, s.is_final
               from task_procedure_steps s
              where s.procedure_id = $3 and s.deleted_at is null
              order by s.seq`,
            [newId, req.user.tid, id]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "task_procedures", entityId: newId,
            action: "procedure.duplicated",
            after: { name: body.name ?? `${src.rows[0].name} (copy)`, from: id }
          });
        });
      } catch (e) {
        const conflict = translate(e);
        if (conflict) throw conflict;
        throw e;
      }
      return reply.status(201).send({ id: newId });
    });

  app.put("/procedures/:id", { preHandler: [requireAuth, requirePermission("procedures.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = procedureUpdateSchema.parse(req.body);
      if (body.steps) assertSequence(body.steps);

      await withTenant(req.user.tid, async (c) => {
        // Only a tenant's own procedure is editable; the shipped defaults are
        // someone else's paper. Duplicate one to change its steps.
        const prev = await c.query(
          `select p.name, p.scope, p.tenant_id, count(s.id)::int as steps
             from task_procedures p
             left join task_procedure_steps s on s.procedure_id = p.id and s.deleted_at is null
            where p.id = $1 and (p.tenant_id is null or p.tenant_id = $2) and p.deleted_at is null
            group by p.id`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Procedure not found", 404);
        if (!prev.rows[0].tenant_id) {
          throw new ApiError("CONFLICT",
            "A system default procedure cannot be edited. Duplicate it and change the copy.",
            409, [{ field: "id" }]);
        }

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid];
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("name" in body) set("name", body.name);
        if ("description" in body) set("description", body.description ?? null);
        if ("scope" in body) set("scope", body.scope);
        if ("isActive" in body) set("is_active", body.isActive);

        if (sets.length) {
          await c.query(
            `update task_procedures set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
              where id = $1 and tenant_id = $3 and deleted_at is null`, params);
        }

        // Steps are replaced, never patched in place: the old rows retire so a
        // flow already copied onto a task keeps the steps it was given.
        if (body.steps) {
          await c.query(
            `update task_procedure_steps set deleted_at = now()
              where procedure_id = $1 and tenant_id = $2 and deleted_at is null`,
            [id, req.user.tid]);
          await insertSteps(c, req.user.tid, id, body.steps);
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "task_procedures", entityId: id,
          action: "procedure.updated",
          before: { name: prev.rows[0].name, steps: prev.rows[0].steps },
          after: { name: body.name ?? null, steps: body.steps?.length ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/procedures/:id", { preHandler: [requireAuth, requirePermission("procedures.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const owner = await c.query(
          `select tenant_id from task_procedures where id = $1 and deleted_at is null`, [id]);
        if (!owner.rowCount) throw new ApiError("NOT_FOUND", "Procedure not found", 404);
        if (!owner.rows[0].tenant_id) {
          throw new ApiError("CONFLICT",
            "A system default procedure belongs to everyone. It cannot be retired.",
            409, [{ field: "id" }]);
        }
        const res = await c.query(
          `update task_procedures set deleted_at = now(), updated_by = $2
            where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await c.query(
            `update task_procedure_steps set deleted_at = now()
              where procedure_id = $1 and deleted_at is null`, [id]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "task_procedures", entityId: id,
            action: "procedure.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Procedure not found", 404);
      return reply.send({ ok: true });
    });

  // ---------- The flow behind one task ----------

  app.get("/office-tasks/:id/flow", { preHandler: [requireAuth, requirePermission("procedures.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const flow = await withTenant(req.user.tid, (c) => readTaskFlow(c, req.user.tid, id));
      if (!flow) throw new ApiError("NOT_FOUND", "Task not found", 404);
      return flow;
    });

  app.post("/office-tasks/:id/flow", { preHandler: [requireAuth, requirePermission("office_tasks.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = flowAttachSchema.parse(req.body);
      const out = await withTenant(req.user.tid, async (c) => {
        const task = await c.query(
          "select id, title, procedure_id from office_tasks where id = $1 and tenant_id = $2",
          [id, req.user.tid]);
        if (!task.rowCount) throw new ApiError("NOT_FOUND", "Task not found", 404);
        const made = await materializeTaskFlow(c, {
          tenantId: req.user.tid, taskId: id, procedureId: body.procedureId, userId: req.user.sub
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_tasks", entityId: id,
          action: "office_task.flow_attached",
          after: { procedureId: body.procedureId, steps: made.steps, checks: made.checks }
        });
        return made;
      });
      return reply.status(201).send(out);
    });

  // ---------- Steps and their mandatory checklists ----------

  app.put("/task-steps/:id", { preHandler: [requireAuth, requirePermission("procedures.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = stepStatusSchema.parse(req.body);
      // The database also refuses this (056), but a caller who blocks a step
      // without saying why wants to be told which field is missing, not 500.
      if (body.status === "blocked" && !body.blockedReason?.trim()) {
        throw new ApiError("VALIDATION_FAILED", "A blocked step must say what is holding it.", 400,
          [{ field: "blockedReason" }]);
      }
      try {
        await withTenant(req.user.tid, async (c) => {
          const prev = await c.query(
            `select s.status, s.name, s.seq, s.blocked_reason, s.office_task_id, t.employee_id
               from office_task_steps s
               join office_tasks t on t.id = s.office_task_id
              where s.id = $1 and s.tenant_id = $2`,
            [id, req.user.tid]);
          if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Step not found", 404);

          const sets: string[] = [];
          const params: unknown[] = [id, req.user.sub, req.user.tid];
          const set = (col: string, val: unknown) => {
            params.push(val);
            sets.push(`${col} = $${params.length}`);
          };
          if ("status" in body) set("status", body.status);
          if ("blockedReason" in body) set("blocked_reason", body.blockedReason ?? null);
          if (body.status === "done") set("completed_by", req.user.sub);

          if (sets.length) {
            await c.query(
              `update office_task_steps set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
                where id = $1 and tenant_id = $3`, params);
          }
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "office_task_steps", entityId: id,
            action: "task_step.updated",
            before: { status: prev.rows[0].status },
            after: { status: body.status ?? null, blockedReason: body.blockedReason ?? null }
          });
        });
      } catch (e) {
        const conflict = translate(e);
        if (conflict) throw conflict;
        throw e;
      }
      return reply.send({ ok: true });
    });

  app.post("/task-steps/:id/checks", { preHandler: [requireAuth, requirePermission("procedures.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = checkAddSchema.parse(req.body);
      const checkId = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        const step = await c.query(
          `select s.office_task_id, s.status,
                  coalesce((select max(ck.seq)::int from office_task_step_checks ck
                             where ck.step_id = s.id), 0) as last_seq
             from office_task_steps s
            where s.id = $1 and s.tenant_id = $2`,
          [id, req.user.tid]);
        if (!step.rowCount) throw new ApiError("NOT_FOUND", "Step not found", 404);
        if (step.rows[0].status === "done") {
          throw new ApiError("CONFLICT", "This step is closed. Reopen it before adding to its checklist.",
            409, [{ field: "id" }]);
        }
        await c.query(
          `insert into office_task_step_checks
             (id, tenant_id, step_id, seq, label, requires_document, doc_kind)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [checkId, req.user.tid, id, step.rows[0].last_seq + 1, body.label,
           body.requiresDocument, body.requiresDocument ? body.docKind ?? null : null]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_task_step_checks", entityId: checkId,
          action: "task_check.added", after: { label: body.label, stepId: id }
        });
      });
      return reply.status(201).send({ id: checkId });
    });

  app.put("/task-step-checks/:id", { preHandler: [requireAuth, requirePermission("procedures.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = tickSchema.parse(req.body);
      try {
        await withTenant(req.user.tid, async (c) => {
          const prev = await c.query(
            `select ck.label, ck.ticked_at, ck.step_id from office_task_step_checks ck
              where ck.id = $1 and ck.tenant_id = $2`,
            [id, req.user.tid]);
          if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Checklist item not found", 404);
          await setCheckTick(c, {
            tenantId: req.user.tid, checkId: id, ticked: body.ticked,
            userId: req.user.sub, evidence: body.evidence ?? null
          });
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "office_task_step_checks", entityId: id,
            action: body.ticked ? "task_check.ticked" : "task_check.unticked",
            before: { label: prev.rows[0].label, ticked: !!prev.rows[0].ticked_at },
            after: { ticked: body.ticked }
          });
        });
      } catch (e) {
        const conflict = translate(e);
        if (conflict) throw conflict;
        throw e;
      }
      return reply.send({ ok: true });
    });

  app.delete("/task-step-checks/:id", { preHandler: [requireAuth, requirePermission("procedures.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select ck.label, ck.ticked_at, s.status from office_task_step_checks ck
             join office_task_steps s on s.id = ck.step_id
            where ck.id = $1 and ck.tenant_id = $2`,
          [id, req.user.tid]);
        if (!prev.rowCount) return prev;
        if (prev.rows[0].status === "done" || prev.rows[0].ticked_at) {
          // A ticked item is evidence; it does not disappear because somebody
          // changed their mind about the wording.
          throw new ApiError("CONFLICT",
            "A ticked checklist item cannot be deleted. Reopen the step and untick it.", 409);
        }
        const res = await c.query(
          "delete from office_task_step_checks where id = $1 and tenant_id = $2",
          [id, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_task_step_checks", entityId: id,
          action: "task_check.deleted", before: { label: prev.rows[0].label }
        });
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Checklist item not found", 404);
      return reply.send({ ok: true });
    });
}

/** The flow indicator walks 1..n without holes, so the numbering must be dense. */
function assertSequence(steps: { seq: number; name: string; isFinal: boolean }[]) {
  const seen = new Set<number>();
  steps.forEach((s, i) => {
    if (s.seq !== i + 1 || seen.has(s.seq)) {
      throw new ApiError("VALIDATION_FAILED",
        `Steps must be numbered from 1 in order — got ${s.seq} at position ${i + 1}.`,
        400, [{ field: "steps" }]);
    }
    seen.add(s.seq);
  });
  if (!steps.some((s) => s.isFinal)) {
    throw new ApiError("VALIDATION_FAILED",
      "A procedure needs its end: mark one step as the Final Sign-off.", 400, [{ field: "isFinal" }]);
  }
}

async function insertSteps(
  c: PoolClient, tenantId: string, procedureId: string,
  steps: z.infer<typeof stepSchema>[]
) {
  for (const s of steps) {
    await c.query(
      `insert into task_procedure_steps
         (tenant_id, procedure_id, seq, name, instructions, checklist, required_documents, is_final)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, procedureId, s.seq, s.name, s.instructions ?? null,
       s.checklist, s.requiredDocuments, s.isFinal]);
  }
}

function translate(e: unknown): ApiError | null {
  const err = e as { code?: string };
  if (err?.code === "23505") {
    return new ApiError("CONFLICT", "A procedure with that name already exists.", 409, [{ field: "name" }]);
  }
  return gateConflict(e);
}
