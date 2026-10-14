import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";
import { encryptField, searchHash } from "../util/crypto.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phoneValue = z.string().regex(/^\+[1-9]\d{7,14}$/);

const employeeSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  phone: phoneValue.nullable().optional(),
  jobTitle: z.string().trim().max(120).nullable().optional(),
  department: z.string().trim().max(120).nullable().optional(),
  skills: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  employmentType: z.enum(["permanent", "fixed_term", "intern"]).default("permanent"),
  status: z.enum(["active", "inactive", "left"]).default("active"),
  hiredDate: dateOnly.nullable().optional(),
  contractStart: dateOnly.nullable().optional(),
  contractEnd: dateOnly.nullable().optional(),
  supervisorId: z.string().uuid().nullable().optional(),
  monthlySalary: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional()
});

const employeeUpdateSchema = employeeSchema.partial().extend({
  absorbed: z.boolean().optional()
});

const taskSchema = z.object({
  employeeId: z.string().uuid(),
  shipmentId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(2).max(200),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  dueDate: dateOnly.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional()
});

const taskUpdateSchema = taskSchema.partial().extend({
  status: z.enum(["pending", "in_progress", "done", "cancelled"]).optional()
});

const scoreValue = z.number().int().min(1).max(5);
const evaluationSchema = z.object({
  employeeId: z.string().uuid(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  taskCompletion: scoreValue,
  punctuality: scoreValue,
  clientSatisfaction: scoreValue,
  collaboration: scoreValue,
  notes: z.string().trim().max(1000).nullable().optional()
});

const evaluationUpdateSchema = evaluationSchema.partial();

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "23505";
}

export async function employeesRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Roster ----------

  app.get("/employees", { preHandler: [requireAuth, requirePermission("employees.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select e.id, e.full_name, e.job_title, e.department, e.skills,
                e.employment_type, e.status, e.intern_absorbed,
                e.hired_date::text as hired_date,
                e.contract_start::text as contract_start,
                e.contract_end::text as contract_end,
                (e.contract_end - current_date)::int as contract_days,
                e.monthly_salary::float8 as monthly_salary,
                e.supervisor_id, s.full_name as supervisor_name,
                e.user_id, e.notes,
                (e.phone_search is not null) as has_phone,
                (select count(*)::int from office_tasks t
                  where t.tenant_id = e.tenant_id and t.employee_id = e.id
                    and t.status in ('pending','in_progress')) as open_tasks,
                (select count(*)::int from office_tasks t
                  where t.tenant_id = e.tenant_id and t.employee_id = e.id
                    and t.status in ('pending','in_progress')
                    and t.due_date < current_date) as overdue_tasks,
                (select count(*)::int from office_tasks t
                  where t.tenant_id = e.tenant_id and t.employee_id = e.id
                    and t.status = 'done') as done_tasks,
                (select count(*)::int from office_tasks t
                  where t.tenant_id = e.tenant_id and t.employee_id = e.id
                    and t.status = 'done' and t.on_time = false) as late_tasks,
                (select count(*)::int from employee_evaluations ev
                  where ev.tenant_id = e.tenant_id and ev.employee_id = e.id
                    and ev.deleted_at is null) as evaluation_count,
                (select round(((ev.task_completion + ev.punctuality
                     + ev.client_satisfaction + ev.collaboration) / 4.0)::numeric, 1)::float8
                 from employee_evaluations ev
                 where ev.tenant_id = e.tenant_id and ev.employee_id = e.id
                   and ev.deleted_at is null
                 order by ev.period desc limit 1) as rating,
                (select ev.period::text from employee_evaluations ev
                 where ev.tenant_id = e.tenant_id and ev.employee_id = e.id
                   and ev.deleted_at is null
                 order by ev.period desc limit 1) as rating_period,
                (select count(*)::int from documents d
                  where d.tenant_id = e.tenant_id and d.entity_type = 'employee'
                    and d.entity_id = e.id and d.deleted_at is null) as document_count,
                (select d.id from documents d
                  where d.tenant_id = e.tenant_id and d.entity_type = 'employee'
                    and d.entity_id = e.id and d.deleted_at is null
                  order by d.created_at desc limit 1) as latest_document_id
         from employees e
         left join employees s on s.id = e.supervisor_id
         where e.tenant_id = $1 and e.deleted_at is null
         order by e.full_name`,
        [req.user.tid]));
      return rows;
    });

  app.post("/employees", { preHandler: [requireAuth, requirePermission("employees.create")] },
    async (req: any, reply) => {
      const body = employeeSchema.parse(req.body);
      const id = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        if (body.supervisorId) {
          const sup = await c.query(
            "select id from employees where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.supervisorId, req.user.tid]);
          if (!sup.rowCount) throw new ApiError("VALIDATION_FAILED", "Supervisor not found.", 400, [{ field: "supervisorId" }]);
        }
        await c.query(
          `insert into employees (id, tenant_id, full_name, phone_encrypted, phone_search,
             job_title, department, skills, employment_type, status, hired_date,
             contract_start, contract_end, supervisor_id, monthly_salary, notes,
             created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
          [id, req.user.tid, body.fullName,
           body.phone ? encryptField(body.phone) : null,
           body.phone ? searchHash(body.phone) : null,
           body.jobTitle ?? null, body.department ?? null, body.skills ?? [],
           body.employmentType, body.status, body.hiredDate ?? null,
           body.contractStart ?? null, body.contractEnd ?? null,
           body.supervisorId ?? null, body.monthlySalary ?? null, body.notes ?? null,
           req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "employees", entityId: id,
          action: "employee.created",
          after: { fullName: body.fullName, employmentType: body.employmentType, department: body.department ?? null }
        });
      });
      return reply.status(201).send({ id });
    });

  app.put("/employees/:id", { preHandler: [requireAuth, requirePermission("employees.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = employeeUpdateSchema.parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select full_name, employment_type, status from employees
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Employee not found", 404);

        if (body.supervisorId) {
          if (body.supervisorId === id) {
            throw new ApiError("VALIDATION_FAILED", "An employee cannot supervise themselves.", 400, [{ field: "supervisorId" }]);
          }
          const sup = await c.query(
            "select id from employees where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.supervisorId, req.user.tid]);
          if (!sup.rowCount) throw new ApiError("VALIDATION_FAILED", "Supervisor not found.", 400, [{ field: "supervisorId" }]);
        }

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid];
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("fullName" in body) set("full_name", body.fullName);
        if ("phone" in body) {
          // Absent keeps the stored value; explicit null clears it.
          set("phone_encrypted", body.phone ? encryptField(body.phone) : null);
          set("phone_search", body.phone ? searchHash(body.phone) : null);
        }
        if ("jobTitle" in body) set("job_title", body.jobTitle ?? null);
        if ("department" in body) set("department", body.department ?? null);
        if ("skills" in body) set("skills", body.skills ?? []);
        if ("employmentType" in body) set("employment_type", body.employmentType);
        if ("status" in body) set("status", body.status);
        if ("hiredDate" in body) set("hired_date", body.hiredDate ?? null);
        if ("contractStart" in body) set("contract_start", body.contractStart ?? null);
        if ("contractEnd" in body) set("contract_end", body.contractEnd ?? null);
        if ("supervisorId" in body) set("supervisor_id", body.supervisorId ?? null);
        if ("monthlySalary" in body) set("monthly_salary", body.monthlySalary ?? null);
        if ("notes" in body) set("notes", body.notes ?? null);
        if ("absorbed" in body) set("intern_absorbed", body.absorbed);

        if (sets.length) {
          await c.query(
            `update employees set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
             where id = $1 and tenant_id = $3 and deleted_at is null`, params);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "employees", entityId: id,
          action: "employee.updated",
          before: { fullName: prev.rows[0].full_name, employmentType: prev.rows[0].employment_type, status: prev.rows[0].status },
          after: { fullName: body.fullName ?? null, employmentType: body.employmentType ?? null, status: body.status ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/employees/:id", { preHandler: [requireAuth, requirePermission("employees.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update employees set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          // Contract scans leave with the employee; open assignments are
          // cancelled but kept so the task history still reads.
          await c.query(
            `update documents set deleted_at = now()
             where tenant_id = $1 and entity_type = 'employee' and entity_id = $2 and deleted_at is null`,
            [req.user.tid, id]);
          await c.query(
            `update office_tasks set status = 'cancelled', updated_by = $2, updated_at = now()
             where tenant_id = $1 and employee_id = $3 and status in ('pending','in_progress')`,
            [req.user.tid, req.user.sub, id]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "employees", entityId: id,
            action: "employee.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Employee not found", 404);
      return reply.send({ ok: true });
    });

  // ---------- Office tasks (daily assignments, often against a cargo file) ----------

  app.get("/office-tasks", { preHandler: [requireAuth, requirePermission("office_tasks.view")] },
    async (req: any) => {
      const q = z.object({
        status: z.enum(["pending", "in_progress", "done", "cancelled"]).optional(),
        employeeId: z.string().uuid().optional()
      }).parse(req.query);

      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select t.id, t.employee_id, e.full_name as employee_name, e.department,
                t.shipment_id, cs.file_number,
                t.title, t.priority, t.due_date::text as due_date,
                (t.due_date - current_date)::int as days,
                t.status, t.done_at, t.on_time, t.notes, t.created_at
         from office_tasks t
         join employees e on e.id = t.employee_id
         left join cargo_shipments cs on cs.id = t.shipment_id
         where t.tenant_id = $1
           and ($2::text is null or t.status = $2)
           and ($3::uuid is null or t.employee_id = $3)
         order by case when t.status in ('pending','in_progress') then 0 else 1 end,
                  case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
                  t.due_date asc nulls last,
                  t.created_at desc
         limit 300`,
        [req.user.tid, q.status ?? null, q.employeeId ?? null]));
      return rows;
    });

  app.post("/office-tasks", { preHandler: [requireAuth, requirePermission("office_tasks.create")] },
    async (req: any, reply) => {
      const body = taskSchema.parse(req.body);
      const id = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        const emp = await c.query(
          "select id from employees where id = $1 and tenant_id = $2 and deleted_at is null",
          [body.employeeId, req.user.tid]);
        if (!emp.rowCount) throw new ApiError("VALIDATION_FAILED", "Employee not found.", 400, [{ field: "employeeId" }]);
        if (body.shipmentId) {
          const sh = await c.query(
            "select id from cargo_shipments where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.shipmentId, req.user.tid]);
          if (!sh.rowCount) throw new ApiError("VALIDATION_FAILED", "Cargo file not found.", 400, [{ field: "shipmentId" }]);
        }
        await c.query(
          `insert into office_tasks (id, tenant_id, employee_id, shipment_id, title, priority,
             due_date, notes, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
          [id, req.user.tid, body.employeeId, body.shipmentId ?? null, body.title,
           body.priority, body.dueDate ?? null, body.notes ?? null, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_tasks", entityId: id,
          action: "office_task.created",
          after: { employeeId: body.employeeId, title: body.title, priority: body.priority, dueDate: body.dueDate ?? null }
        });
      });
      return reply.status(201).send({ id });
    });

  app.put("/office-tasks/:id", { preHandler: [requireAuth, requirePermission("office_tasks.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = taskUpdateSchema.parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select employee_id, title, status, due_date::text as due_date from office_tasks
           where id = $1 and tenant_id = $2`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Task not found", 404);

        if (body.employeeId) {
          const emp = await c.query(
            "select id from employees where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.employeeId, req.user.tid]);
          if (!emp.rowCount) throw new ApiError("VALIDATION_FAILED", "Employee not found.", 400, [{ field: "employeeId" }]);
        }
        if (body.shipmentId) {
          const sh = await c.query(
            "select id from cargo_shipments where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.shipmentId, req.user.tid]);
          if (!sh.rowCount) throw new ApiError("VALIDATION_FAILED", "Cargo file not found.", 400, [{ field: "shipmentId" }]);
        }

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid];
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("employeeId" in body) set("employee_id", body.employeeId);
        if ("shipmentId" in body) set("shipment_id", body.shipmentId ?? null);
        if ("title" in body) set("title", body.title);
        if ("priority" in body) set("priority", body.priority);
        if ("dueDate" in body) set("due_date", body.dueDate ?? null);
        if ("notes" in body) set("notes", body.notes ?? null);
        if ("status" in body) {
          set("status", body.status);
          if (body.status === "done") {
            // Punctuality is judged at completion against the deadline the
            // task carries after this update.
            const dueKey = "dueDate" in body ? body.dueDate ?? null : prev.rows[0].due_date;
            const today = new Date().toISOString().slice(0, 10);
            set("done_at", new Date().toISOString());
            set("on_time", dueKey ? today <= dueKey : null);
          } else {
            // Reopened or cancelled — the completion record goes with it.
            set("done_at", null);
            set("on_time", null);
          }
        }

        if (sets.length) {
          await c.query(
            `update office_tasks set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
             where id = $1 and tenant_id = $3`, params);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_tasks", entityId: id,
          action: "office_task.updated",
          before: { status: prev.rows[0].status, title: prev.rows[0].title },
          after: { status: body.status ?? null, title: body.title ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/office-tasks/:id", { preHandler: [requireAuth, requirePermission("office_tasks.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select title from office_tasks where id = $1 and tenant_id = $2",
          [id, req.user.tid]);
        if (!prev.rowCount) return prev;
        const res = await c.query(
          "delete from office_tasks where id = $1 and tenant_id = $2",
          [id, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_tasks", entityId: id,
          action: "office_task.deleted", before: { title: prev.rows[0].title }
        });
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Task not found", 404);
      return reply.send({ ok: true });
    });

  // ---------- Evaluations (monthly, four graded dimensions) ----------

  app.get("/evaluations", { preHandler: [requireAuth, requirePermission("evaluations.view")] },
    async (req: any) => {
      const q = z.object({
        employeeId: z.string().uuid().optional()
      }).parse(req.query);

      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select ev.id, ev.employee_id, e.full_name as employee_name, e.department,
                ev.period::text as period,
                ev.task_completion, ev.punctuality, ev.client_satisfaction, ev.collaboration,
                round(((ev.task_completion + ev.punctuality + ev.client_satisfaction
                  + ev.collaboration) / 4.0)::numeric, 1)::float8 as average,
                ev.notes, ev.evaluated_by, u.full_name as evaluated_by_name,
                ev.created_at
         from employee_evaluations ev
         join employees e on e.id = ev.employee_id
         left join users u on u.id = ev.evaluated_by
         where ev.tenant_id = $1 and ev.deleted_at is null
           and ($2::uuid is null or ev.employee_id = $2)
         order by ev.period desc, e.full_name
         limit 300`,
        [req.user.tid, q.employeeId ?? null]));
      return rows;
    });

  app.post("/evaluations", { preHandler: [requireAuth, requirePermission("evaluations.create")] },
    async (req: any, reply) => {
      const body = evaluationSchema.parse(req.body);
      const id = uuidv7();
      try {
        await withTenant(req.user.tid, async (c) => {
          const emp = await c.query(
            "select id from employees where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.employeeId, req.user.tid]);
          if (!emp.rowCount) throw new ApiError("VALIDATION_FAILED", "Employee not found.", 400, [{ field: "employeeId" }]);
          await c.query(
            `insert into employee_evaluations (id, tenant_id, employee_id, period,
               task_completion, punctuality, client_satisfaction, collaboration,
               notes, evaluated_by, created_by, updated_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10)`,
            [id, req.user.tid, body.employeeId, `${body.period}-01`,
             body.taskCompletion, body.punctuality, body.clientSatisfaction, body.collaboration,
             body.notes ?? null, req.user.sub]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "evaluations", entityId: id,
            action: "evaluation.created",
            after: { employeeId: body.employeeId, period: body.period }
          });
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ApiError("CONFLICT", "This employee already has an evaluation for that month.", 409);
        }
        throw e;
      }
      return reply.status(201).send({ id });
    });

  app.put("/evaluations/:id", { preHandler: [requireAuth, requirePermission("evaluations.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = evaluationUpdateSchema.parse(req.body);

      try {
        await withTenant(req.user.tid, async (c) => {
          const prev = await c.query(
            `select employee_id, period::text as period from employee_evaluations
             where id = $1 and tenant_id = $2 and deleted_at is null`,
            [id, req.user.tid]);
          if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Evaluation not found", 404);

          const sets: string[] = [];
          const params: unknown[] = [id, req.user.sub, req.user.tid];
          const set = (col: string, val: unknown) => {
            params.push(val);
            sets.push(`${col} = $${params.length}`);
          };
          if ("employeeId" in body) set("employee_id", body.employeeId);
          if ("period" in body) set("period", `${body.period}-01`);
          if ("taskCompletion" in body) set("task_completion", body.taskCompletion);
          if ("punctuality" in body) set("punctuality", body.punctuality);
          if ("clientSatisfaction" in body) set("client_satisfaction", body.clientSatisfaction);
          if ("collaboration" in body) set("collaboration", body.collaboration);
          if ("notes" in body) set("notes", body.notes ?? null);

          if (sets.length) {
            await c.query(
              `update employee_evaluations set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
               where id = $1 and tenant_id = $3 and deleted_at is null`, params);
          }
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "evaluations", entityId: id,
            action: "evaluation.updated",
            before: { employeeId: prev.rows[0].employee_id, period: prev.rows[0].period }
          });
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ApiError("CONFLICT", "This employee already has an evaluation for that month.", 409);
        }
        throw e;
      }
      return reply.send({ ok: true });
    });

  app.delete("/evaluations/:id", { preHandler: [requireAuth, requirePermission("evaluations.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update employee_evaluations set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "evaluations", entityId: id,
            action: "evaluation.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Evaluation not found", 404);
      return reply.send({ ok: true });
    });
}
