import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const scoreValue = z.number().int().min(1).max(5);

const SIGNOFF_ROLES = ["hod", "hr_manager", "direct_supervisor"] as const;

const generateSchema = z.object({
  employeeId: z.string().uuid(),
  // A trainee's period defaults to the contract dates the register already
  // carries — the same pair the renewal alert reads.
  periodStart: dateOnly.optional(),
  periodEnd: dateOnly.optional()
});

const reportUpdateSchema = z.object({
  taskOverview: z.string().trim().max(6000).nullable().optional(),
  attendanceNote: z.string().trim().max(1000).nullable().optional(),
  supervisorRemarks: z.string().trim().max(4000).nullable().optional(),
  taskCompletion: scoreValue.nullable().optional(),
  punctuality: scoreValue.nullable().optional(),
  clientSatisfaction: scoreValue.nullable().optional(),
  collaboration: scoreValue.nullable().optional(),
  periodStart: dateOnly.optional(),
  periodEnd: dateOnly.optional()
});

const signoffSchema = z.object({
  role: z.enum(SIGNOFF_ROLES),
  signatoryName: z.string().trim().min(2).max(160),
  signatoryTitle: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional()
});

const LETTERHEAD_SQL = `
  select cp.company_name, cp.tin_display, cp.vat_number, cp.website,
         b.postal_address, b.street, b.email as branch_email,
         (select d.id from documents d
           where d.tenant_id = $1 and d.entity_type = 'tenant'
             and d.kind = 'logo' and d.deleted_at is null
           order by d.created_at desc limit 1) as logo_document_id
  from company_profiles cp
  left join branches b on b.tenant_id = cp.tenant_id and b.kind = 'hq' and b.deleted_at is null
  where cp.tenant_id = $1`;

const REPORT_SELECT_SQL = `
  select r.id, r.employee_id, r.status,
         r.period_start::text as period_start, r.period_end::text as period_end,
         r.tasks_total, r.tasks_done, r.tasks_on_time,
         r.grade_task_completion, r.grade_punctuality,
         r.grade_client_satisfaction, r.grade_collaboration,
         r.task_overview, r.attendance_note, r.supervisor_remarks,
         to_char(r.generated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as generated_at,
         to_char(r.completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as completed_at,
         e.full_name, e.job_title, e.department, e.college, e.academic_status, e.gender,
         e.qualifications,
         e.date_of_birth::text as date_of_birth,
         (case when e.date_of_birth is null then null
               else date_part('year', age(e.date_of_birth))::int end) as age,
         e.employment_type, e.intern_absorbed,
         e.contract_start::text as contract_start, e.contract_end::text as contract_end,
         s.full_name as supervisor_name, s.job_title as supervisor_title,
         (select d.id from documents d
           where d.tenant_id = r.tenant_id and d.entity_type = 'employee'
             and d.entity_id = r.employee_id and d.kind = 'avatar' and d.deleted_at is null
           order by d.created_at desc limit 1) as photo_document_id,
         coalesce((select json_agg(json_build_object(
                     'role', sg.role, 'id', sg.id,
                     'signatoryName', sg.signatory_name, 'signatoryTitle', sg.signatory_title,
                     'note', sg.note, 'signedBy', sg.signed_by,
                     'signedAt', to_char(sg.signed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                   order by case sg.role
                     when 'hod' then 1 when 'hr_manager' then 2 else 3 end)
                  from trainee_report_signoffs sg
                 where sg.report_id = r.id), '[]'::json) as signoffs
  from trainee_reports r
  join employees e on e.id = r.employee_id
  left join employees s on s.id = e.supervisor_id`;

const REPORT_ONE_SQL = `${REPORT_SELECT_SQL}
  where r.id = $1 and r.tenant_id = $2 and r.deleted_at is null`;

function conflictFrom(e: unknown): ApiError | null {
  const err = e as { code?: string; message?: string };
  if (err?.code === "P0001" && typeof err.message === "string") {
    // The three gates in 056 speak in full sentences: not enough signatures, no
    // remarks written, period still open. Pass the reason through.
    return new ApiError("CONFLICT", err.message.split("\n")[0], 409);
  }
  return null;
}

type Generated = {
  tasksTotal: number; tasksDone: number; tasksOnTime: number;
  overview: string; grades: Record<string, number | null>;
};

/**
 * Everything the paper reports is read off the record at the moment of
 * generation: tasks from office_tasks, competency grades from the evaluations
 * inside the period. Attendance is the one thing nothing in the system measures,
 * so it comes back empty for the supervisor to state.
 */
async function gatherReport(c: PoolClient, tenantId: string, employeeId: string,
  periodStart: string, periodEnd: string): Promise<Generated> {
  const { rows } = await c.query(
    `select
       (select count(*)::int from office_tasks t
         where t.tenant_id = $1 and t.employee_id = $2
           and t.created_at::date <= $4) as tasks_total,
       (select count(*)::int from office_tasks t
         where t.tenant_id = $1 and t.employee_id = $2 and t.status = 'done'
           and t.done_at::date between $3 and $4) as tasks_done,
       (select count(*)::int from office_tasks t
         where t.tenant_id = $1 and t.employee_id = $2 and t.status = 'done'
           and t.on_time = true and t.done_at::date between $3 and $4) as tasks_on_time,
       (select coalesce(round(avg(ev.task_completion))::int, null) from employee_evaluations ev
         where ev.tenant_id = $1 and ev.employee_id = $2 and ev.deleted_at is null
           and ev.period between $3 and $4) as grade_task_completion,
       (select coalesce(round(avg(ev.punctuality))::int, null) from employee_evaluations ev
         where ev.tenant_id = $1 and ev.employee_id = $2 and ev.deleted_at is null
           and ev.period between $3 and $4) as grade_punctuality,
       (select coalesce(round(avg(ev.client_satisfaction))::int, null) from employee_evaluations ev
         where ev.tenant_id = $1 and ev.employee_id = $2 and ev.deleted_at is null
           and ev.period between $3 and $4) as grade_client_satisfaction,
       (select coalesce(round(avg(ev.collaboration))::int, null) from employee_evaluations ev
         where ev.tenant_id = $1 and ev.employee_id = $2 and ev.deleted_at is null
           and ev.period between $3 and $4) as grade_collaboration,
       (select coalesce(string_agg('- ' || t.title, chr(10) order by t.due_date nulls last, t.created_at),
                'No tasks recorded in this period.')
          from (select title, due_date, created_at from office_tasks
                 where tenant_id = $1 and employee_id = $2 and status = 'done'
                   and done_at::date between $3 and $4
                 order by due_date nulls last, created_at limit 40) t) as task_overview`,
    [tenantId, employeeId, periodStart, periodEnd]);
  const r = rows[0];
  return {
    tasksTotal: r.tasks_total, tasksDone: r.tasks_done, tasksOnTime: r.tasks_on_time,
    overview: r.task_overview,
    grades: {
      taskCompletion: r.grade_task_completion, punctuality: r.grade_punctuality,
      clientSatisfaction: r.grade_client_satisfaction, collaboration: r.grade_collaboration
    }
  };
}

export async function traineeReportsRoutes(app: FastifyInstance, _opts: unknown) {

  app.get("/trainee-reports", { preHandler: [requireAuth, requirePermission("trainee_reports.view")] },
    async (req: any) => {
      const q = z.object({ employeeId: z.string().uuid().optional() }).parse(req.query);
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select r.id, r.employee_id, e.full_name, e.department, e.employment_type,
                r.status, r.period_start::text as period_start, r.period_end::text as period_end,
                r.tasks_total, r.tasks_done, r.tasks_on_time,
                (select count(*)::int from trainee_report_signoffs sg
                  where sg.report_id = r.id) as signed_count,
                round(((r.grade_task_completion + r.grade_punctuality
                  + r.grade_client_satisfaction + r.grade_collaboration) / 4.0)::numeric, 1)::float8
                  as rating
         from trainee_reports r
         join employees e on e.id = r.employee_id
         where r.tenant_id = $1 and r.deleted_at is null
           and ($2::uuid is null or r.employee_id = $2)
         order by r.period_start desc, e.full_name
         limit 300`,
        [req.user.tid, q.employeeId ?? null]));
      return rows;
    });

  app.get("/trainee-reports/:id", { preHandler: [requireAuth, requirePermission("trainee_reports.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const out = await withTenant(req.user.tid, async (c) => {
        const [report, letter] = await Promise.all([
          c.query(REPORT_ONE_SQL, [id, req.user.tid]),
          c.query(LETTERHEAD_SQL, [req.user.tid])
        ]);
        return { report: report.rows[0] ?? null, letterhead: letter.rows[0] ?? null };
      });
      if (!out.report) throw new ApiError("NOT_FOUND", "Report not found", 404);
      return out;
    });

  // Build the one-page report from the record. Draft, because a report is not
  // finished until three people have put their name to it.
  app.post("/trainee-reports/generate",
    { preHandler: [requireAuth, requirePermission("trainee_reports.create")] },
    async (req: any, reply) => {
      const body = generateSchema.parse(req.body);
      const id = uuidv7();
      try {
        await withTenant(req.user.tid, async (c) => {
          const emp = await c.query(
            `select full_name, employment_type, contract_start::text as contract_start,
                    contract_end::text as contract_end
               from employees where id = $1 and tenant_id = $2 and deleted_at is null`,
            [body.employeeId, req.user.tid]);
          if (!emp.rowCount) {
            throw new ApiError("VALIDATION_FAILED", "Employee not found.", 400, [{ field: "employeeId" }]);
          }
          const start = body.periodStart ?? emp.rows[0].contract_start;
          const end = body.periodEnd ?? emp.rows[0].contract_end;
          if (!start || !end) {
            throw new ApiError("VALIDATION_FAILED",
              "This record has no training period. Enter the start and end dates.",
              400, [{ field: "periodStart" }, { field: "periodEnd" }]);
          }
          if (start >= end) {
            throw new ApiError("VALIDATION_FAILED",
              "The period ends before it starts.", 400, [{ field: "periodEnd" }]);
          }
          const dupe = await c.query(
            `select id from trainee_reports
              where tenant_id = $1 and employee_id = $2
                and period_start = $3 and period_end = $4 and deleted_at is null`,
            [req.user.tid, body.employeeId, start, end]);
          if (dupe.rowCount) {
            throw new ApiError("CONFLICT",
              "A report for this trainee and period already exists.", 409,
              [{ field: "periodEnd", reportId: dupe.rows[0].id }]);
          }

          const g = await gatherReport(c, req.user.tid, body.employeeId, start, end);
          await c.query(
            `insert into trainee_reports
               (id, tenant_id, employee_id, period_start, period_end, status,
                tasks_total, tasks_done, tasks_on_time, task_overview,
                grade_task_completion, grade_punctuality, grade_client_satisfaction,
                grade_collaboration, created_by, updated_by)
             values ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
            [id, req.user.tid, body.employeeId, start, end,
             g.tasksTotal, g.tasksDone, g.tasksOnTime, g.overview,
             g.grades.taskCompletion, g.grades.punctuality,
             g.grades.clientSatisfaction, g.grades.collaboration, req.user.sub]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "trainee_reports", entityId: id,
            action: "trainee_report.generated",
            after: { employeeId: body.employeeId, periodStart: start, periodEnd: end, tasks: g.tasksTotal }
          });
        });
      } catch (e) {
        const conflict = conflictFrom(e);
        if (conflict) throw conflict;
        throw e;
      }
      return reply.status(201).send({ id });
    });

  app.put("/trainee-reports/:id", { preHandler: [requireAuth, requirePermission("trainee_reports.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = reportUpdateSchema.parse(req.body);
      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select status, supervisor_remarks from trainee_reports
            where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Report not found", 404);

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid];
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("taskOverview" in body) set("task_overview", body.taskOverview ?? null);
        if ("attendanceNote" in body) set("attendance_note", body.attendanceNote ?? null);
        if ("supervisorRemarks" in body) set("supervisor_remarks", body.supervisorRemarks ?? null);
        if ("taskCompletion" in body) set("grade_task_completion", body.taskCompletion ?? null);
        if ("punctuality" in body) set("grade_punctuality", body.punctuality ?? null);
        if ("clientSatisfaction" in body) set("grade_client_satisfaction", body.clientSatisfaction ?? null);
        if ("collaboration" in body) set("grade_collaboration", body.collaboration ?? null);
        if ("periodStart" in body) set("period_start", body.periodStart);
        if ("periodEnd" in body) set("period_end", body.periodEnd);

        if (sets.length) {
          try {
            await c.query(
              `update trainee_reports set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
                where id = $1 and tenant_id = $3 and deleted_at is null`, params);
          } catch (e) {
            const conflict = conflictFrom(e);
            if (conflict) throw conflict;
            throw e;
          }
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "trainee_reports", entityId: id,
          action: "trainee_report.updated",
          before: { supervisorRemarks: !!prev.rows[0].supervisor_remarks }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/trainee-reports/:id", { preHandler: [requireAuth, requirePermission("trainee_reports.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update trainee_reports set deleted_at = now(), updated_by = $2
            where id = $1 and tenant_id = $3 and deleted_at is null and status = 'draft'`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "trainee_reports", entityId: id,
            action: "trainee_report.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) {
        throw new ApiError("CONFLICT",
          "Nothing was removed. A signed-off report stays on the file.", 409);
      }
      return reply.send({ ok: true });
    });

  // ---------- The sign-off block ----------

  app.post("/trainee-reports/:id/signoffs",
    { preHandler: [requireAuth, requirePermission("trainee_reports.sign")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = signoffSchema.parse(req.body);
      const signoffId = uuidv7();
      try {
        await withTenant(req.user.tid, async (c) => {
          const report = await c.query(
            `select status from trainee_reports
              where id = $1 and tenant_id = $2 and deleted_at is null`,
            [id, req.user.tid]);
          if (!report.rowCount) throw new ApiError("NOT_FOUND", "Report not found", 404);
          await c.query(
            `insert into trainee_report_signoffs
               (id, tenant_id, report_id, role, signatory_name, signatory_title, signed_by, note)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [signoffId, req.user.tid, id, body.role, body.signatoryName,
             body.signatoryTitle ?? null, req.user.sub, body.note ?? null]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "trainee_report_signoffs", entityId: signoffId,
            action: "trainee_report.signed",
            after: { reportId: id, role: body.role, signatoryName: body.signatoryName }
          });
        });
      } catch (e) {
        const err = e as { code?: string };
        if (err?.code === "23505") {
          throw new ApiError("CONFLICT", "That block is already signed.", 409, [{ field: "role" }]);
        }
        const conflict = conflictFrom(e);
        if (conflict) throw conflict;
        throw e;
      }
      return reply.status(201).send({ id: signoffId });
    });

  app.delete("/trainee-report-signoffs/:id",
    { preHandler: [requireAuth, requirePermission("trainee_reports.sign")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      try {
        await withTenant(req.user.tid, async (c) => {
          const prev = await c.query(
            `select sg.role, sg.report_id from trainee_report_signoffs sg
              where sg.id = $1 and sg.tenant_id = $2`,
            [id, req.user.tid]);
          if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Signature block not found", 404);
          await c.query("delete from trainee_report_signoffs where id = $1 and tenant_id = $2",
            [id, req.user.tid]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "trainee_report_signoffs", entityId: id,
            action: "trainee_report.signoff_withdrawn",
            before: { role: prev.rows[0].role, reportId: prev.rows[0].report_id }
          });
        });
      } catch (e) {
        const conflict = conflictFrom(e);
        if (conflict) throw conflict;
        throw e;
      }
      return reply.send({ ok: true });
    });

  // Close the paper. The trigger demands all three signatures, remarks written
  // and the period past — which is why this is its own endpoint rather than a
  // field in the PUT above.
  app.post("/trainee-reports/:id/close",
    { preHandler: [requireAuth, requirePermission("trainee_reports.sign")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      try {
        await withTenant(req.user.tid, async (c) => {
          const r = await c.query(
            `update trainee_reports set status = 'complete', updated_by = $2, updated_at = now()
              where id = $1 and tenant_id = $3 and deleted_at is null and status = 'draft'`,
            [id, req.user.sub, req.user.tid]);
          if (!r.rowCount) throw new ApiError("NOT_FOUND", "Report not found or already closed", 404);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "trainee_reports", entityId: id,
            action: "trainee_report.closed", after: { status: "complete" }
          });
        });
      } catch (e) {
        const conflict = conflictFrom(e);
        if (conflict) throw conflict;
        throw e;
      }
      return reply.send({ ok: true });
    });

  app.post("/trainee-reports/:id/reopen",
    { preHandler: [requireAuth, requirePermission("trainee_reports.sign")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      await withTenant(req.user.tid, async (c) => {
        const r = await c.query(
          `update trainee_reports set status = 'draft', completed_at = null,
                  updated_by = $2, updated_at = now()
            where id = $1 and tenant_id = $3 and deleted_at is null and status = 'complete'`,
          [id, req.user.sub, req.user.tid]);
        if (!r.rowCount) throw new ApiError("NOT_FOUND", "Report is not closed", 404);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "trainee_reports", entityId: id,
          action: "trainee_report.reopened", before: { status: "complete" }
        });
      });
      return reply.send({ ok: true });
    });
}
