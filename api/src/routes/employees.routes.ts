import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";
import { encryptField, searchHash } from "../util/crypto.js";
import { materializeTaskFlow } from "../operations/task-flow.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phoneValue = z.string().regex(/^\+[1-9]\d{7,14}$/);

const employeeSchema = z.object({
  // The register carries one name: the legal name, taken exactly as NIDA has it.
  fullName: z.string().trim().min(2).max(160),
  phone: phoneValue.nullable().optional(),
  dateOfBirth: dateOnly.nullable().optional(),
  gender: z.enum(["male", "female", "other"]).nullable().optional(),
  academicStatus: z.enum(["student", "graduate"]).nullable().optional(),
  college: z.string().trim().max(200).nullable().optional(),
  qualifications: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  emergencyContactName: z.string().trim().max(160).nullable().optional(),
  emergencyRelationship: z.string().trim().max(80).nullable().optional(),
  emergencyPhone: phoneValue.nullable().optional(),
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
  absorbed: z.boolean().optional(),
  // Only the edit accepts it: a person is hired into a job, then the office says who
  // decides their leave. The intake form has no seat list to pick one from yet.
  leaveApproverUserId: z.string().uuid().nullable().optional()
});

const taskSchema = z.object({
  employeeId: z.string().uuid(),
  shipmentId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(2).max(200),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  dueDate: dateOnly.nullable().optional(),
  // Attaching a procedure lays its steps and mandatory checklist under the task.
  procedureId: z.string().uuid().nullable().optional(),
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

/**
 * A trigger raised the gate — the checklist is open, an earlier step is
 * unfinished, or a signed report is being rewritten. The database, not the
 * route, is what holds those invariants (056), so its message is the truth and
 * goes to the client as it stands.
 */
function isGateViolation(e: unknown): string | null {
  const err = e as { code?: string; message?: string };
  if (!err || err.code !== "P0001" || typeof err.message !== "string") return null;
  return err.message.replace(/^relation .*? failed: /, "");
}

const PROFILE_SELECT_SQL = `e.id, e.full_name, e.job_title, e.department, e.skills,
  e.employment_type, e.status, e.intern_absorbed,
  e.date_of_birth::text as date_of_birth,
  (case when e.date_of_birth is null then null
        else date_part('year', age(e.date_of_birth))::int end) as age,
  e.gender, e.academic_status, e.college, e.qualifications,
  e.emergency_contact_name, e.emergency_relationship,
  (e.emergency_phone_search is not null) as has_emergency_phone,
  e.hired_date::text as hired_date,
  e.contract_start::text as contract_start,
  e.contract_end::text as contract_end,
  (e.contract_end - current_date)::int as contract_days,
  e.monthly_salary::float8 as monthly_salary,
  e.supervisor_id, s.full_name as supervisor_name,
  e.leave_approver_user_id, ap.full_name as leave_approver_name,
  e.user_id, e.notes,
  (e.phone_search is not null) as has_phone`;

function assertProfile(body: { dateOfBirth?: string | null; fullName?: string }) {
  // A CHECK cannot call current_date, so the intake form's impossibilities are
  // caught here: nobody is born tomorrow, and the legal name is not optional.
  if (body.dateOfBirth && body.dateOfBirth >= new Date().toISOString().slice(0, 10)) {
    throw new ApiError("VALIDATION_FAILED", "Date of birth is in the future.", 400,
      [{ field: "dateOfBirth" }]);
  }
  if (body.fullName && !body.fullName.trim()) {
    throw new ApiError("VALIDATION_FAILED", "Enter the full legal name exactly as registered on NIDA.", 400,
      [{ field: "fullName" }]);
  }
}

export async function employeesRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Roster ----------

  app.get("/employees", { preHandler: [requireAuth, requirePermission("employees.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select ${PROFILE_SELECT_SQL},
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
                (select count(*)::int from office_tasks t
                  where t.tenant_id = e.tenant_id and t.employee_id = e.id
                    and t.procedure_id is not null
                    and t.status in ('pending','in_progress')) as flowed_tasks,
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
                    and d.entity_id = e.id and d.kind = 'avatar' and d.deleted_at is null
                  order by d.created_at desc limit 1) as avatar_document_id,
                (select d.id from documents d
                  where d.tenant_id = e.tenant_id and d.entity_type = 'employee'
                    and d.entity_id = e.id and d.deleted_at is null
                  order by d.created_at desc limit 1) as latest_document_id
         from employees e
         left join employees s on s.id = e.supervisor_id
         left join users ap on ap.id = e.leave_approver_user_id and ap.tenant_id = e.tenant_id
         where e.tenant_id = $1 and e.deleted_at is null
         order by e.full_name`,
        [req.user.tid]));
      return rows;
    });

  // One person, opened: the profile sheet the trainee register reads. The list
  // stays PII-free, and so does this — the encrypted values never leave the
  // database, only whether they are set.
  app.get("/employees/:id", { preHandler: [requireAuth, requirePermission("employees.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select ${PROFILE_SELECT_SQL},
                (select d.id from documents d
                  where d.tenant_id = e.tenant_id and d.entity_type = 'employee'
                    and d.entity_id = e.id and d.kind = 'avatar' and d.deleted_at is null
                  order by d.created_at desc limit 1) as avatar_document_id,
                (select d.id from documents d
                  where d.tenant_id = e.tenant_id and d.entity_type = 'employee'
                    and d.entity_id = e.id and d.deleted_at is null
                  order by d.created_at desc limit 1) as latest_document_id,
                (select count(*)::int from documents d
                  where d.tenant_id = e.tenant_id and d.entity_type = 'employee'
                    and d.entity_id = e.id and d.deleted_at is null) as document_count,
                (select round(((ev.task_completion + ev.punctuality
                     + ev.client_satisfaction + ev.collaboration) / 4.0)::numeric, 1)::float8
                 from employee_evaluations ev
                 where ev.tenant_id = e.tenant_id and ev.employee_id = e.id
                   and ev.deleted_at is null
                 order by ev.period desc limit 1) as rating,
                (select count(*)::int from trainee_reports r
                  where r.tenant_id = e.tenant_id and r.employee_id = e.id
                    and r.deleted_at is null) as report_count,
                (select count(*)::int from office_tasks t
                  where t.tenant_id = e.tenant_id and t.employee_id = e.id
                    and t.status in ('pending','in_progress')) as open_tasks,
                (select count(*)::int from office_tasks t
                  where t.tenant_id = e.tenant_id and t.employee_id = e.id
                    and t.status = 'done') as done_tasks,
                (select count(*)::int from office_tasks t
                  where t.tenant_id = e.tenant_id and t.employee_id = e.id
                    and t.status = 'done' and t.on_time = true) as on_time_tasks
         from employees e
         left join employees s on s.id = e.supervisor_id
         left join users ap on ap.id = e.leave_approver_user_id and ap.tenant_id = e.tenant_id
         where e.id = $1 and e.tenant_id = $2 and e.deleted_at is null`,
        [id, req.user.tid]));
      if (!rows.length) throw new ApiError("NOT_FOUND", "Employee not found", 404);
      return rows[0];
    });

  app.post("/employees", { preHandler: [requireAuth, requirePermission("employees.create")] },
    async (req: any, reply) => {
      const body = employeeSchema.parse(req.body);
      assertProfile(body);
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
             date_of_birth, gender, academic_status, college, qualifications,
             emergency_contact_name, emergency_relationship,
             emergency_phone_encrypted, emergency_phone_search,
             job_title, department, skills, employment_type, status, hired_date,
             contract_start, contract_end, supervisor_id, monthly_salary, notes,
             created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                   $21,$22,$23,$24,$25,$26,$26)`,
          [id, req.user.tid, body.fullName,
           body.phone ? encryptField(body.phone) : null,
           body.phone ? searchHash(body.phone) : null,
           body.dateOfBirth ?? null, body.gender ?? null, body.academicStatus ?? null,
           body.college ?? null, body.qualifications ?? [],
           body.emergencyContactName ?? null, body.emergencyRelationship ?? null,
           body.emergencyPhone ? encryptField(body.emergencyPhone) : null,
           body.emergencyPhone ? searchHash(body.emergencyPhone) : null,
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
      assertProfile(body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select full_name, employment_type, status, user_id, leave_approver_user_id from employees
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Employee not found", 404);

        if ("leaveApproverUserId" in body && body.leaveApproverUserId) {
          // Checked here so the office is told what is wrong with the person they picked, and
          // again by 108's trigger so a statement that skipped this route cannot land.
          if (prev.rows[0].user_id === body.leaveApproverUserId) {
            throw new ApiError("VALIDATION_FAILED",
              "That is the person's own seat — nobody decides their own leave.", 400,
              [{ field: "leaveApproverUserId" }]);
          }
          const seat = await c.query(
            `select status from users where id = $1 and tenant_id = $2 and deleted_at is null`,
            [body.leaveApproverUserId, req.user.tid]);
          if (!seat.rowCount) {
            throw new ApiError("VALIDATION_FAILED",
              "That seat belongs to another company, so it cannot decide this one's leave.", 400,
              [{ field: "leaveApproverUserId" }]);
          }
          if (seat.rows[0].status !== "active") {
            throw new ApiError("CONFLICT",
              "That seat is not active. An approver has to be able to sign in and answer.", 409,
              [{ field: "leaveApproverUserId" }]);
          }
        }

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
        if ("dateOfBirth" in body) set("date_of_birth", body.dateOfBirth ?? null);
        if ("gender" in body) set("gender", body.gender ?? null);
        if ("academicStatus" in body) set("academic_status", body.academicStatus ?? null);
        if ("college" in body) set("college", body.college ?? null);
        if ("qualifications" in body) set("qualifications", body.qualifications ?? []);
        if ("emergencyContactName" in body) set("emergency_contact_name", body.emergencyContactName ?? null);
        if ("emergencyRelationship" in body) set("emergency_relationship", body.emergencyRelationship ?? null);
        if ("emergencyPhone" in body) {
          // Same rule as the person's own phone: blank means keep what is stored,
          // an explicit null means take it off the record.
          set("emergency_phone_encrypted", body.emergencyPhone ? encryptField(body.emergencyPhone) : null);
          set("emergency_phone_search", body.emergencyPhone ? searchHash(body.emergencyPhone) : null);
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
        if ("leaveApproverUserId" in body) set("leave_approver_user_id", body.leaveApproverUserId ?? null);
        if ("monthlySalary" in body) set("monthly_salary", body.monthlySalary ?? null);
        if ("notes" in body) set("notes", body.notes ?? null);
        if ("absorbed" in body) set("intern_absorbed", body.absorbed);

        if (sets.length) {
          try {
            await c.query(
              `update employees set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
               where id = $1 and tenant_id = $3 and deleted_at is null`, params);
          } catch (e) {
            // 108's trigger is the floor under this column; its sentence is already the
            // sentence the office needs, so it is passed on rather than turned into a 500.
            const msg = String((e as any)?.message ?? "");
            if (msg.includes("approver")) {
              throw new ApiError("VALIDATION_FAILED", msg, 400, [{ field: "leaveApproverUserId" }]);
            }
            throw e;
          }
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "employees", entityId: id,
          action: "employee.updated",
          before: { fullName: prev.rows[0].full_name, employmentType: prev.rows[0].employment_type, status: prev.rows[0].status },
          after: { fullName: body.fullName ?? null, employmentType: body.employmentType ?? null, status: body.status ?? null }
        });
        if ("leaveApproverUserId" in body
            && (body.leaveApproverUserId ?? null) !== (prev.rows[0].leave_approver_user_id ?? null)) {
          // Its own line: "who was made the person who decides X's leave" is a question the
          // forensic register gets asked, and it is buried inside a name-and-salary edit
          // otherwise.
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "employees", entityId: id,
            action: body.leaveApproverUserId ? "employee.leave_approver_set" : "employee.leave_approver_cleared",
            before: { leaveApproverUserId: prev.rows[0].leave_approver_user_id ?? null },
            after: { leaveApproverUserId: body.leaveApproverUserId ?? null }
          });
        }
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
        employeeId: z.string().uuid().optional(),
        shipmentId: z.string().uuid().optional()
      }).parse(req.query);

      // The file columns are what makes an assignment about a cargo file usable
      // from the office end: the person holding the job sees how far the file
      // has got without needing the CFA page, and the desk that handed the job
      // over sees who asked for it.
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select t.id, t.employee_id, e.full_name as employee_name, e.department,
                t.shipment_id, cs.file_number, cs.stage as file_stage,
                cs.status as file_status, cs.shipment_type,
                cs.consignee_name as file_consignee, cs.eta::text as file_eta,
                (t.shipment_id is not null and cs.deleted_at is null) as file_live,
                (select count(*)::int from job_stages js
                  where js.shipment_id = t.shipment_id and js.deleted_at is null) as file_stages_total,
                (select count(*)::int from job_stages js
                  where js.shipment_id = t.shipment_id and js.deleted_at is null
                    and js.status = 'done') as file_stages_done,
                (select count(*)::int from cargo_tasks kt
                  where kt.shipment_id = t.shipment_id and kt.status = 'pending') as file_tasks_open,
                t.title, t.priority, t.due_date::text as due_date,
                (t.due_date - current_date)::int as days,
                t.status, t.done_at, t.on_time, t.notes, t.created_at,
                t.created_by, ru.full_name as requested_by_name,
                t.procedure_id, p.name as procedure_name,
                (select count(*)::int from office_task_steps s
                  where s.office_task_id = t.id) as steps_total,
                (select count(*)::int from office_task_steps s
                  where s.office_task_id = t.id and s.status = 'done') as steps_done,
                (select coalesce(max(s.seq), 0)::int from office_task_steps s
                  where s.office_task_id = t.id and s.status <> 'done') as current_step
         from office_tasks t
         join employees e on e.id = t.employee_id
         left join cargo_shipments cs on cs.id = t.shipment_id
         left join task_procedures p on p.id = t.procedure_id
         left join users ru on ru.id = t.created_by
         where t.tenant_id = $1
           and ($2::text is null or t.status = $2)
           and ($3::uuid is null or t.employee_id = $3)
           and ($4::uuid is null or t.shipment_id = $4)
         order by case when t.status in ('pending','in_progress') then 0 else 1 end,
                  case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
                  t.due_date asc nulls last,
                  t.created_at desc
         limit 300`,
        [req.user.tid, q.status ?? null, q.employeeId ?? null, q.shipmentId ?? null]));
      return rows;
    });

  // The shortlist a desk picks from when it hands a job to the back office.
  // This is not /employees under another name: the roster carries salaries,
  // dates of birth and somebody's emergency contact, and none of that belongs
  // on a cargo file. A name, what they do and how much is already on their
  // plate is everything the choice needs.
  app.get("/office-assignees", { preHandler: [requireAuth, requirePermission("office_tasks.create")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select e.id, e.full_name, e.job_title, e.department, e.employment_type,
                (e.user_id is not null) as has_account,
                (select count(*)::int from office_tasks t
                  where t.employee_id = e.id
                    and t.status in ('pending','in_progress')) as open_tasks,
                (select count(*)::int from office_tasks t
                  where t.employee_id = e.id and t.status in ('pending','in_progress')
                    and t.due_date < current_date) as overdue_tasks,
                (select count(distinct t.shipment_id)::int from office_tasks t
                  where t.employee_id = e.id and t.shipment_id is not null
                    and t.status in ('pending','in_progress')) as open_files
         from employees e
         where e.tenant_id = $1 and e.deleted_at is null and e.status = 'active'
         order by open_tasks asc, e.full_name asc
         limit 200`, [req.user.tid]));
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
             due_date, notes, procedure_id, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
          [id, req.user.tid, body.employeeId, body.shipmentId ?? null, body.title,
           body.priority, body.dueDate ?? null, body.notes ?? null, body.procedureId ?? null,
           req.user.sub]);
        // The flow is laid down with the task, so the assignee opens something
        // that already says what has to happen and what must be ticked off.
        const flow = body.procedureId
          ? await materializeTaskFlow(c, {
              tenantId: req.user.tid, taskId: id,
              procedureId: body.procedureId, userId: req.user.sub
            })
          : null;
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_tasks", entityId: id,
          action: "office_task.created",
          after: {
            employeeId: body.employeeId, title: body.title, priority: body.priority,
            dueDate: body.dueDate ?? null, procedureId: body.procedureId ?? null,
            steps: flow?.steps ?? 0
          }
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
        if ("procedureId" in body) {
          set("procedure_id", body.procedureId ?? null);
          // Attaching after the fact still lays the flow; detaching leaves the
          // steps that exist standing on their own, because somebody may have
          // already ticked them.
          if (body.procedureId) {
            await materializeTaskFlow(c, {
              tenantId: req.user.tid, taskId: id,
              procedureId: body.procedureId, userId: req.user.sub
            });
          }
        }
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
          try {
            await c.query(
              `update office_tasks set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
               where id = $1 and tenant_id = $3`, params);
          } catch (e) {
            // The 056 trigger is what says no to closing a task whose flow has
            // not reached Final Sign-off. Its reason is the useful one.
            const gate = isGateViolation(e);
            if (gate) throw new ApiError("CONFLICT", gate, 409);
            throw e;
          }
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
