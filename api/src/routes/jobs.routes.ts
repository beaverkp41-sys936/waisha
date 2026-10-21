import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { CARGO_PAPER_KINDS } from "../cargo/paper.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission, checkPermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";
import {
  assertAssignable, loadJob, loadStage, logActivity, missingVerifiedDocs, openJob
} from "../util/jobs.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STAGE_KEYS = ["job_opening", "pre_arrival_docs", "shipment_tracking", "declaration_prep",
  "customs_submission", "payment", "inspection", "release", "transport_decision", "closing_billing"] as const;

// Kinds the pipeline recognises — mirrors the documents.kind CHECK list in 042.
const DOC_KINDS = ["bill_of_lading", "packing_list", "invoice", "arrival_notice", "delivery_order",
  "declaration", "assessment", "receipt", "inspection", "release_note", "permit", "pod",
  "handover", "contract", "delivery_note", "licence", "insurance", "road_licence",
  "attachment", "other",
  // 117: a job's paper trail includes the prevision, the port release and the warehouse slips.
  ...CARGO_PAPER_KINDS] as const;

const actorRole = (req: any): string | null => req.user?.roles?.[0] ?? null;

const statusSchema = z.object({
  status: z.enum(["not_started", "in_progress", "blocked", "done"]),
  blockedReason: z.string().trim().min(3).max(300).nullable().optional()
});

const jobPatchSchema = z.object({
  freeDays: z.number().int().min(0).max(365).nullable().optional(),
  freeDaysStart: dateOnly.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional()
});

const taskSchema = z.object({
  title: z.string().trim().min(2).max(200),
  stageKey: z.enum(STAGE_KEYS).nullable().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  dueDate: dateOnly.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

const taskPatchSchema = taskSchema.partial().extend({
  status: z.enum(["pending", "done", "cancelled"]).optional()
});

const docSchema = z.object({
  title: z.string().trim().min(2).max(200),
  kind: z.enum(DOC_KINDS),
  direction: z.enum(["issued", "received"]).default("received"),
  fromParty: z.string().trim().max(160).nullable().optional(),
  toParty: z.string().trim().max(160).nullable().optional(),
  docDate: dateOnly.nullable().optional(),
  stageKey: z.enum(STAGE_KEYS).nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

const docStatusSchema = z.object({
  status: z.enum(["pending", "received", "verified", "rejected"]),
  reason: z.string().trim().min(3).max(300).nullable().optional()
});

const handoverSchema = z.object({
  receivedByName: z.string().trim().min(2).max(160),
  receivedByIdNumber: z.string().trim().max(60).nullable().optional(),
  method: z.enum(["signature", "photo"]),
  documentId: z.string().uuid().nullable().optional(),
  happenedAt: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

const decisionSchema = z.object({
  recordKind: z.enum(["live", "archive"]),
  transportNeeded: z.boolean().nullable().optional(),
  consent: z.enum(["granted", "declined", "deferred"]).nullable().optional(),
  handover: handoverSchema.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

export async function jobsRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- List with pipeline summary ----------
  app.get("/jobs", { preHandler: [requireAuth, requirePermission("jobs.view")] },
    async (req: any) => {
      const q = z.object({
        status: z.enum(["open", "closed", "cancelled"]).optional(),
        recordKind: z.enum(["live", "archive"]).optional(),
        stageKey: z.enum(STAGE_KEYS).optional(),
        mine: z.coerce.boolean().optional(),
        search: z.string().trim().max(60).optional()
      }).parse(req.query);
      const term = q.search ? `%${q.search}%` : null;

      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select j.id, j.shipment_id, j.record_kind, j.status, j.transport_needed,
                j.transport_consent, j.free_days, j.free_days_start, j.closed_at, j.created_at,
                s.file_number, s.shipment_type, s.consignee_name, s.consignor_name,
                s.status as shipment_status, s.eta, s.discharge_date,
                (select count(*)::int from job_stages g
                  where g.job_id = j.id and g.deleted_at is null and g.status = 'done') as stages_done,
                (select count(*)::int from job_stages g
                  where g.job_id = j.id and g.deleted_at is null) as stages_total,
                cur.name as current_stage, cur.stage_key as current_stage_key,
                cur.position as current_position, cur.blocked_reason,
                (select count(*)::int from cargo_tasks k
                  where k.shipment_id = j.shipment_id and k.status = 'pending') as open_tasks,
                (select count(*)::int from cargo_tasks k
                  where k.shipment_id = j.shipment_id and k.status = 'pending'
                    and k.due_date < current_date) as overdue_tasks
           from jobs j
           join cargo_shipments s on s.id = j.shipment_id and s.tenant_id = j.tenant_id
           left join lateral (
             select g.name, g.stage_key, g.position, g.blocked_reason
               from job_stages g
              where g.job_id = j.id and g.deleted_at is null and g.status <> 'done'
              order by g.position limit 1) cur on true
          where j.tenant_id = $1 and j.deleted_at is null and s.deleted_at is null
            and ($2::text is null or j.status = $2)
            and ($3::text is null or j.record_kind = $3)
            and ($4::text is null or cur.stage_key = $4)
            and ($5::text is null or s.file_number ilike $5 or s.consignee_name ilike $5
                 or s.consignor_name ilike $5 or s.reference_number ilike $5)
            and ($6::uuid is null or exists (
              select 1 from cargo_tasks k
               where k.shipment_id = j.shipment_id and k.status = 'pending' and k.assigned_to = $6))
          order by (cur.position is null) asc nulls last, coalesce(cur.position, 99), j.created_at desc
          limit 300`,
        [req.user.tid, q.status ?? null, q.recordKind ?? null, q.stageKey ?? null,
         term, q.mine ? req.user.sub : null]));
      return rows;
    });

  // ---------- Open a job (idempotent; used to backfill existing files) ----------
  app.post("/jobs", { preHandler: [requireAuth, requirePermission("jobs.create")] },
    async (req: any, reply) => {
      const body = z.object({ shipmentId: z.string().uuid() }).parse(req.body);
      const out = await withTenant(req.user.tid, async (c) => {
        const r = await openJob(c, req.user.tid, body.shipmentId, req.user.sub);
        if (!r.existing) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
            ip: req.ip, requestId: req.requestId, entity: "jobs", entityId: r.jobId,
            action: "job.opened", after: { shipmentId: body.shipmentId, stages: r.stages }
          });
        }
        return r;
      });
      return reply.status(out.existing ? 200 : 201).send(out);
    });

  // ---------- Templates (read-only legend) ----------
  app.get("/jobs/templates/:shipmentType",
    { preHandler: [requireAuth, requirePermission("jobs.view")] },
    async (req: any) => {
      const { shipmentType } = req.params as { shipmentType: string };
      const parsed = z.enum(["export", "import", "transhipment", "transit"]).parse(shipmentType);
      return withTenant(req.user.tid, async (c) => {
        const r = await c.query(
          `select stage_key, name, position, required_documents, default_tasks
             from job_stage_templates
            where deleted_at is null and shipment_type = $1
              and (tenant_id is null or tenant_id = $2)
            order by position`, [parsed, req.user.tid]);
        return r.rows;
      });
    });

  // ---------- Dashboard: overdue and blocked ----------
  app.get("/jobs/dashboard", { preHandler: [requireAuth, requirePermission("jobs.view")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        const counts = await c.query(
          `select (select count(*)::int from jobs j join cargo_shipments s on s.id = j.shipment_id
                   where j.tenant_id = $1 and j.deleted_at is null and j.status = 'open'
                     and j.record_kind = 'live' and s.deleted_at is null) as open_live,
                  (select count(*)::int from jobs j join cargo_shipments s on s.id = j.shipment_id
                   where j.tenant_id = $1 and j.deleted_at is null and j.status = 'open'
                     and j.record_kind = 'archive' and s.deleted_at is null) as open_archive,
                  (select count(*)::int from jobs j join cargo_shipments s on s.id = j.shipment_id
                   where j.tenant_id = $1 and j.deleted_at is null and j.status = 'closed'
                     and s.deleted_at is null) as closed,
                  (select count(*)::int from job_stages g join jobs j on j.id = g.job_id
                    where g.tenant_id = $1 and g.deleted_at is null and g.status = 'blocked'
                      and j.status = 'open') as blocked_stages,
                  (select count(*)::int from cargo_tasks k join jobs j on j.shipment_id = k.shipment_id
                    where k.tenant_id = $1 and j.deleted_at is null and j.status = 'open'
                      and k.status = 'pending' and k.due_date < current_date) as overdue_tasks,
                  (select count(*)::int from job_documents d join jobs j on j.id = d.job_id
                    where d.tenant_id = $1 and d.deleted_at is null and j.status = 'open'
                      and d.status = 'rejected') as rejected_docs`,
          [req.user.tid]);

        const blocked = await c.query(
          `select j.id as job_id, j.shipment_id, s.file_number, s.consignee_name,
                  g.name as stage, g.blocked_reason, g.updated_at as blocked_at
             from job_stages g
             join jobs j on j.id = g.job_id and j.status = 'open'
             join cargo_shipments s on s.id = j.shipment_id
            where g.tenant_id = $1 and g.deleted_at is null and g.status = 'blocked'
              and j.deleted_at is null and s.deleted_at is null
            order by g.updated_at desc limit 25`, [req.user.tid]);

        const overdue = await c.query(
          `select k.id, k.title, k.due_date, k.shipment_id, j.id as job_id,
                  s.file_number, coalesce(u.full_name, 'Unassigned') as assignee
             from cargo_tasks k
             join jobs j on j.shipment_id = k.shipment_id and j.status = 'open'
             join cargo_shipments s on s.id = k.shipment_id
             left join users u on u.id = k.assigned_to
            where k.tenant_id = $1 and k.status = 'pending' and k.due_date < current_date
              and j.deleted_at is null and s.deleted_at is null
            order by k.due_date limit 25`, [req.user.tid]);

        // Real deadlines: free days run out, ETA lands, transit permits expire.
        const deadlines = await c.query(
          `select * from (
             select j.id as job_id, j.shipment_id, s.file_number,
                    'free_days'::text as kind,
                    (j.free_days_start + j.free_days) as due_on,
                    ((j.free_days_start + j.free_days) - current_date) as days_left,
                    'Free days on the container run out'::text as label
               from jobs j join cargo_shipments s on s.id = j.shipment_id
              where j.tenant_id = $1 and j.deleted_at is null and j.status = 'open'
                and s.deleted_at is null and j.free_days is not null and j.free_days_start is not null
            union all
             select j.id, j.shipment_id, s.file_number, 'eta', s.eta,
                    (s.eta - current_date), 'Vessel / flight ETA'
               from jobs j join cargo_shipments s on s.id = j.shipment_id
              where j.tenant_id = $1 and j.deleted_at is null and j.status = 'open'
                and s.deleted_at is null and s.eta is not null
            union all
             select j.id, j.shipment_id, s.file_number, 'permit', d.doc_date,
                    (d.doc_date - current_date), coalesce(d.title, 'Transit permit')
               from job_documents d join jobs j on j.id = d.job_id
               join cargo_shipments s on s.id = j.shipment_id
              where d.tenant_id = $1 and d.deleted_at is null and d.kind = 'permit'
                and d.doc_date is not null and j.status = 'open' and j.deleted_at is null
                and s.deleted_at is null
            union all
             select j.id, j.shipment_id, s.file_number, 'task_due', k.due_date,
                    (k.due_date - current_date), k.title
               from cargo_tasks k join jobs j on j.shipment_id = k.shipment_id
               join cargo_shipments s on s.id = k.shipment_id
              where k.tenant_id = $1 and j.deleted_at is null and j.status = 'open'
                and s.deleted_at is null
                and k.status = 'pending' and k.due_date is not null
           ) x
           where x.days_left <= 5
           order by x.days_left asc limit 40`, [req.user.tid]);

        const permits = await c.query(
          `select title, licence_number, expiry_date, (expiry_date - current_date) as days_left
             from regulatory_licences
            where tenant_id = $1 and deleted_at is null and expiry_date <= current_date + 30
            order by expiry_date limit 10`, [req.user.tid]);

        return {
          counts: counts.rows[0],
          blocked: blocked.rows,
          overdue: overdue.rows,
          deadlines: deadlines.rows,
          expiringLicences: permits.rows
        };
      });
    });

  // ---------- Kanban by stage ----------
  app.get("/jobs/board", { preHandler: [requireAuth, requirePermission("jobs.view")] },
    async (req: any) => {
      const jobs = await withTenant(req.user.tid, (c) => c.query(
        `select j.id, j.shipment_id, s.file_number, s.consignee_name, j.record_kind,
                (select g.stage_key from job_stages g
                  where g.job_id = j.id and g.deleted_at is null and g.status <> 'done'
                  order by g.position limit 1) as current_stage_key,
                (select count(*)::int from job_stages g
                  where g.job_id = j.id and g.deleted_at is null and g.status = 'done') as stages_done,
                (select count(*)::int from cargo_tasks k
                  where k.shipment_id = j.shipment_id and k.status = 'pending') as open_tasks,
                (select count(*)::int from cargo_tasks k
                  where k.shipment_id = j.shipment_id and k.status = 'pending'
                    and k.due_date < current_date) as overdue_tasks,
                exists (select 1 from job_stages g where g.job_id = j.id and g.deleted_at is null
                  and g.status = 'blocked') as blocked
           from jobs j join cargo_shipments s on s.id = j.shipment_id
          where j.tenant_id = $1 and j.deleted_at is null and j.status = 'open'
            and s.deleted_at is null
          order by s.file_number limit 300`, [req.user.tid]));

      const stages = await withTenant(req.user.tid, (c) => c.query(
        `select stage_key, name, position from job_stage_templates
          where deleted_at is null and shipment_type = 'import' and tenant_id is null
          order by position`));

      const columns = stages.rows.map((s: any) => ({
        stageKey: s.stage_key, name: s.name, position: s.position,
        jobs: jobs.rows.filter((j: any) =>
          j.current_stage_key === s.stage_key || (!j.current_stage_key && s.position === 10))
      }));
      return { columns, total: jobs.rows.length };
    });

  // ---------- My tasks ----------
  app.get("/jobs/my-tasks", { preHandler: [requireAuth, requirePermission("jobs.view")] },
    async (req: any) => {
      const q = z.object({
        scope: z.enum(["open", "overdue", "all"]).default("open")
      }).parse(req.query);
      return withTenant(req.user.tid, async (c) => {
        const r = await c.query(
          `select k.id, k.title, k.status, k.due_date, k.done_at, k.notes, k.stage_id,
                  j.id as job_id, j.shipment_id, s.file_number, s.consignee_name,
                  g.stage_key, g.name as stage_name, g.status as stage_status
             from cargo_tasks k
             join jobs j on j.shipment_id = k.shipment_id and j.deleted_at is null
             join cargo_shipments s on s.id = j.shipment_id and s.deleted_at is null
             left join job_stages g on g.id = k.stage_id
            where k.tenant_id = $1 and k.assigned_to = $2
              and ($3::text = 'all'
                   or ($3::text = 'open' and k.status = 'pending')
                   or ($3::text = 'overdue' and k.status = 'pending' and k.due_date < current_date))
            order by k.due_date nulls last, s.file_number limit 200`,
          [req.user.tid, req.user.sub, q.scope]);
        return r.rows;
      });
    });

  // ---------- Detail ----------
  app.get("/jobs/:id", { preHandler: [requireAuth, requirePermission("jobs.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);

        const [stages, tasks, docs, handovers, activity, staff] = await Promise.all([
          c.query(
            `select g.id, g.stage_key, g.name, g.position, g.status, g.blocked_reason,
                    g.required_documents, g.started_at, g.completed_at,
                    (select count(*)::int from cargo_tasks k
                      where k.stage_id = g.id and k.status = 'pending') as open_tasks,
                    (select count(*)::int from job_documents d
                      where d.job_id = g.job_id and d.stage_key = g.stage_key
                        and d.deleted_at is null) as docs_in_stage
               from job_stages g
              where g.job_id = $1 and g.deleted_at is null
              order by g.position`, [id]),
          c.query(
            `select k.id, k.title, k.stage_id, k.assigned_to, k.due_date, k.status,
                    k.done_at, k.notes, k.created_at,
                    coalesce(u.full_name, 'Unassigned') as assignee_name
               from cargo_tasks k left join users u on u.id = k.assigned_to
              where k.shipment_id = $1 and k.tenant_id = $2
              order by (k.status = 'pending') desc, k.due_date nulls last, k.created_at`,
            [job.shipment_id, req.user.tid]),
          c.query(
            `select d.id, d.title, d.kind, d.direction, d.from_party, d.to_party,
                    d.doc_date, d.status, d.stage_key, d.document_id, d.notes,
                    d.verified_at, d.rejection_reason,
                    f.file_name, f.mime_type, f.size_bytes
               from job_documents d left join documents f on f.id = d.document_id
              where d.job_id = $1 and d.tenant_id = $2 and d.deleted_at is null
              order by d.doc_date desc nulls last, d.created_at desc`, [id, req.user.tid]),
          c.query(
            `select h.id, h.received_by_name, h.received_by_id_number, h.method,
                    h.document_id, h.notes, h.happened_at, h.created_by,
                    f.file_name
               from job_handovers h left join documents f on f.id = h.document_id
              where h.job_id = $1 and h.tenant_id = $2
              order by h.happened_at desc`, [id, req.user.tid]),
          c.query(
            `select a.id, a.action, a.summary, a.stage_id, a.entity, a.entity_id,
                    a.meta, a.created_at, coalesce(u.full_name, 'System') as actor_name
               from job_activity a left join users u on u.id = a.actor_user_id
              where a.job_id = $1 and a.tenant_id = $2
              order by a.created_at desc limit 50`, [id, req.user.tid]),
          c.query(
            `select id, full_name from users
              where tenant_id = $1 and deleted_at is null and status = 'active'
                and user_type in ('director','staff') order by full_name`, [req.user.tid])
        ]);

        return { ...job, stages: stages.rows, tasks: tasks.rows, documents: docs.rows,
          handovers: handovers.rows, activity: activity.rows, staff: staff.rows };
      });
    });

  // ---------- Timeline ----------
  app.get("/jobs/:id/timeline", { preHandler: [requireAuth, requirePermission("jobs.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const q = z.object({ before: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(80) }).parse(req.query);
      return withTenant(req.user.tid, async (c) => {
        await loadJob(c, req.user.tid, id);
        const r = await c.query(
          `select a.id, a.action, a.summary, a.stage_id, a.entity, a.entity_id,
                  a.meta, a.created_at, coalesce(u.full_name, 'System') as actor_name,
                  g.stage_key, g.name as stage_name
             from job_activity a
             left join users u on u.id = a.actor_user_id
             left join job_stages g on g.id = a.stage_id
            where a.job_id = $1 and a.tenant_id = $2
              and ($3::timestamptz is null or a.created_at < $3)
            order by a.created_at desc limit $4`,
          [id, req.user.tid, q.before ?? null, q.limit]);
        return r.rows;
      });
    });

  // ---------- Job header ----------
  app.patch("/jobs/:id", { preHandler: [requireAuth, requirePermission("jobs.manage")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = jobPatchSchema.parse(req.body);
      await withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);
        if (job.status !== "open") throw new ApiError("CONFLICT", "Only an open job can be edited.", 409);
        const sets: string[] = ["updated_by = $2", "updated_at = now()"];
        const params: unknown[] = [id, req.user.sub, req.user.tid];
        const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
        if ("freeDays" in body) set("free_days", body.freeDays ?? null);
        if ("freeDaysStart" in body) set("free_days_start", body.freeDaysStart ?? null);
        if ("notes" in body) set("notes", body.notes ?? null);
        await c.query(
          `update jobs set ${sets.join(", ")} where id = $1 and tenant_id = $3`, params);
        await logActivity(c, {
          tenantId: req.user.tid, jobId: id, shipmentId: job.shipment_id,
          actorUserId: req.user.sub, actorRole: actorRole(req),
          action: "job.updated", summary: `Job ${job.file_number} updated`,
          entity: "jobs", entityId: id, meta: body
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
          ip: req.ip, requestId: req.requestId, entity: "jobs", entityId: id,
          action: "job.updated", after: body
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Stage status ----------
  app.put("/jobs/:id/stages/:stageId/status",
    { preHandler: [requireAuth, requirePermission("jobs.manage")] },
    async (req: any, reply) => {
      const { id, stageId } = req.params as { id: string; stageId: string };
      const body = statusSchema.parse(req.body);
      await withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);
        if (job.status !== "open") {
          throw new ApiError("CONFLICT", `A ${job.status} job can no longer be worked on.`, 409);
        }
        const stage = await loadStage(c, req.user.tid, id, stageId);
        if (stage.status === body.status) return;

        if (body.status === "blocked" && !body.blockedReason) {
          throw new ApiError("VALIDATION_FAILED", "A blocked stage needs a reason.", 400,
            [{ field: "blockedReason" }]);
        }
        if (body.status === "done") {
          const ahead = await c.query(
            `select name from job_stages
              where job_id = $1 and deleted_at is null and position < $2 and status <> 'done'
              order by position limit 1`, [id, stage.position]);
          if (ahead.rowCount && job.record_kind !== "archive") {
            throw new ApiError("CONFLICT",
              `Complete "${ahead.rows[0].name}" first — stages run in order.`, 409,
              [{ earlierStage: ahead.rows[0].name }]);
          }
          const missing = await missingVerifiedDocs(c, req.user.tid, id, stage.required_documents);
          if (missing.length) {
            throw new ApiError("CONFLICT",
              `Cannot complete "${stage.name}" — these documents are not verified yet: ${missing.join(", ")}.`,
              409, missing.map((k) => ({ missingDocument: k })));
          }
        }

        await c.query(
          `update job_stages set status = $2, blocked_reason = $3,
             started_at = case when $2 = 'not_started' then null
                               else coalesce(started_at, case when $2 = 'done' then now() else now() end) end,
             completed_at = case when $2 = 'done' then now() else null end,
             completed_by = case when $2 = 'done' then $4::uuid else null end,
             updated_by = $4, updated_at = now()
           where id = $1 and tenant_id = $5`,
          [stageId, body.status, body.status === "blocked" ? body.blockedReason : null,
           req.user.sub, req.user.tid]);

        const verb = body.status === "done" ? "completed"
          : body.status === "blocked" ? `blocked: ${body.blockedReason}`
          : body.status === "in_progress" ? "started" : "reset";
        await logActivity(c, {
          tenantId: req.user.tid, jobId: id, shipmentId: job.shipment_id, stageId,
          actorUserId: req.user.sub, actorRole: actorRole(req),
          action: `stage.${body.status}`,
          summary: `${stage.name} — ${verb}`,
          entity: "job_stages", entityId: stageId, meta: { status: body.status, reason: body.blockedReason ?? null }
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
          ip: req.ip, requestId: req.requestId, entity: "job_stages", entityId: stageId,
          action: `stage.${body.status}`,
          before: { status: stage.status }, after: { status: body.status, reason: body.blockedReason ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Checklist tasks (cargo_tasks + stage_id) ----------
  app.post("/jobs/:id/tasks", { preHandler: [requireAuth, requirePermission("jobs.manage")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = taskSchema.parse(req.body);
      const taskId = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);
        if (job.status !== "open") throw new ApiError("CONFLICT", "Only an open job takes tasks.", 409);
        if (body.assignedTo && body.assignedTo !== req.user.sub &&
          !(await checkPermission(c, req.user.sub, "jobs.assign"))) {
          throw new ApiError("FORBIDDEN", "Assigning work to others needs the assign permission.", 403);
        }
        if (body.assignedTo) await assertAssignable(c, req.user.tid, body.assignedTo);
        let stageId: string | null = null;
        if (body.stageKey) {
          const s = await c.query(
            `select id from job_stages where job_id = $1 and stage_key = $2 and deleted_at is null`,
            [id, body.stageKey]);
          if (!s.rowCount) throw new ApiError("NOT_FOUND", "Stage not found on this job", 404);
          stageId = s.rows[0].id;
        }
        await c.query(
          `insert into cargo_tasks (id, tenant_id, shipment_id, stage_id, title, assigned_to,
             due_date, notes, status, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$9)`,
          [taskId, req.user.tid, job.shipment_id, stageId, body.title,
           body.assignedTo ?? null, body.dueDate ?? null, body.notes ?? null, req.user.sub]);
        await logActivity(c, {
          tenantId: req.user.tid, jobId: id, shipmentId: job.shipment_id, stageId,
          actorUserId: req.user.sub, actorRole: actorRole(req),
          action: "task.added", summary: `Task added: ${body.title}`,
          entity: "cargo_tasks", entityId: taskId,
          meta: { assignedTo: body.assignedTo ?? null, dueDate: body.dueDate ?? null }
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
          ip: req.ip, requestId: req.requestId, entity: "cargo_tasks", entityId: taskId,
          action: "task.assigned", after: { jobId: id, title: body.title, assignedTo: body.assignedTo ?? null }
        });
      });
      return reply.status(201).send({ id: taskId });
    });

  app.patch("/jobs/:id/tasks/:taskId",
    { preHandler: [requireAuth, requirePermission("jobs.manage")] },
    async (req: any, reply) => {
      const { id, taskId } = req.params as { id: string; taskId: string };
      const body = taskPatchSchema.parse(req.body);
      await withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);
        const t = await c.query(
          `select id, assigned_to, status from cargo_tasks
            where id = $1 and shipment_id = $2 and tenant_id = $3`,
          [taskId, job.shipment_id, req.user.tid]);
        if (!t.rowCount) throw new ApiError("NOT_FOUND", "Task not found", 404);
        const assigneeChanged = "assignedTo" in body &&
          (body.assignedTo ?? null) !== t.rows[0].assigned_to;
        if (assigneeChanged && body.assignedTo && body.assignedTo !== req.user.sub &&
          !(await checkPermission(c, req.user.sub, "jobs.assign"))) {
          throw new ApiError("FORBIDDEN", "Assigning work to others needs the assign permission.", 403);
        }
        if (body.assignedTo) await assertAssignable(c, req.user.tid, body.assignedTo);

        const sets: string[] = ["updated_by = $2", "updated_at = now()"];
        const params: unknown[] = [taskId, req.user.sub];
        const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
        if ("title" in body) set("title", body.title);
        if ("stageKey" in body) {
          let stageId: string | null = null;
          if (body.stageKey) {
            const s = await c.query(
              `select id from job_stages where job_id = $1 and stage_key = $2 and deleted_at is null`,
              [id, body.stageKey]);
            if (!s.rowCount) throw new ApiError("NOT_FOUND", "Stage not found on this job", 404);
            stageId = s.rows[0].id;
          }
          set("stage_id", stageId);
        }
        if ("assignedTo" in body) set("assigned_to", body.assignedTo ?? null);
        if ("dueDate" in body) set("due_date", body.dueDate ?? null);
        if ("notes" in body) set("notes", body.notes ?? null);
        if ("status" in body) {
          set("status", body.status);
          set("done_at", body.status === "done" ? new Date() : null);
        }
        await c.query(
          `update cargo_tasks set ${sets.join(", ")}
            where id = $1 and tenant_id = $${params.length + 1}`,
          [...params, req.user.tid]);

        await logActivity(c, {
          tenantId: req.user.tid, jobId: id, shipmentId: job.shipment_id,
          actorUserId: req.user.sub, actorRole: actorRole(req),
          action: body.status ? `task.${body.status}` : "task.updated",
          summary: body.status === "done" ? `Task done: ${body.title ?? ""}`.trim()
            : `Task updated: ${body.title ?? ""}`.trim(),
          entity: "cargo_tasks", entityId: taskId, meta: body
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
          ip: req.ip, requestId: req.requestId, entity: "cargo_tasks", entityId: taskId,
          action: "task.updated", before: { status: t.rows[0].status }, after: body
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Document register ----------
  app.post("/jobs/:id/documents", { preHandler: [requireAuth, requirePermission("jobs.manage")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = docSchema.parse(req.body);
      const docId = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);
        if (job.status === "cancelled") throw new ApiError("CONFLICT", "Job is cancelled.", 409);
        if (body.documentId) {
          const f = await c.query(
            `select id from documents where id = $1 and tenant_id = $2 and deleted_at is null`,
            [body.documentId, req.user.tid]);
          if (!f.rowCount) throw new ApiError("NOT_FOUND", "Stored file not found", 404);
        }
        await c.query(
          `insert into job_documents (id, tenant_id, job_id, shipment_id, stage_key, title, kind,
             direction, from_party, to_party, doc_date, document_id, status, notes,
             created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'received',$13,$14,$14)`,
          [docId, req.user.tid, id, job.shipment_id, body.stageKey ?? null, body.title,
           body.kind, body.direction, body.fromParty ?? null, body.toParty ?? null,
           body.docDate ?? null, body.documentId ?? null, body.notes ?? null, req.user.sub]);
        await logActivity(c, {
          tenantId: req.user.tid, jobId: id, shipmentId: job.shipment_id,
          actorUserId: req.user.sub, actorRole: actorRole(req),
          action: "document.logged",
          summary: `${body.direction === "issued" ? "Issued" : "Received"} ${body.title}`,
          entity: "job_documents", entityId: docId,
          meta: { kind: body.kind, stageKey: body.stageKey ?? null }
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
          ip: req.ip, requestId: req.requestId, entity: "job_documents", entityId: docId,
          action: "document.logged", after: { jobId: id, kind: body.kind, direction: body.direction }
        });
      });
      return reply.status(201).send({ id: docId });
    });

  app.put("/jobs/:id/documents/:docId/status",
    { preHandler: [requireAuth, requirePermission("jobs.verify")] },
    async (req: any, reply) => {
      const { id, docId } = req.params as { id: string; docId: string };
      const body = docStatusSchema.parse(req.body);
      await withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);
        const d = await c.query(
          `select id, title, kind, status from job_documents
            where id = $1 and job_id = $2 and tenant_id = $3 and deleted_at is null`,
          [docId, id, req.user.tid]);
        if (!d.rowCount) throw new ApiError("NOT_FOUND", "Document not found", 404);
        if (body.status === "rejected" && !body.reason) {
          throw new ApiError("VALIDATION_FAILED", "A rejected document needs a reason.", 400,
            [{ field: "reason" }]);
        }
        await c.query(
          `update job_documents set status = $2,
             verified_by = case when $2 in ('verified','rejected') then $4 else verified_by end,
             verified_at = case when $2 in ('verified','rejected') then now() else null end,
             rejection_reason = case when $2 = 'rejected' then $3 else null end,
             updated_by = $4, updated_at = now()
           where id = $1 and job_id = $5 and tenant_id = $6`,
          [docId, body.status, body.reason ?? null, req.user.sub, id, req.user.tid]);
        await logActivity(c, {
          tenantId: req.user.tid, jobId: id, shipmentId: job.shipment_id,
          actorUserId: req.user.sub, actorRole: actorRole(req),
          action: `document.${body.status}`,
          summary: `${d.rows[0].title} — ${body.status}` +
            (body.status === "rejected" ? `: ${body.reason}` : ""),
          entity: "job_documents", entityId: docId,
          meta: { kind: d.rows[0].kind, reason: body.reason ?? null }
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
          ip: req.ip, requestId: req.requestId, entity: "job_documents", entityId: docId,
          action: `document.${body.status}`,
          before: { status: d.rows[0].status }, after: { status: body.status, reason: body.reason ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/jobs/:id/documents/:docId",
    { preHandler: [requireAuth, requirePermission("jobs.manage")] },
    async (req: any, reply) => {
      const { id, docId } = req.params as { id: string; docId: string };
      await withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);
        const d = await c.query(
          `select id, title from job_documents
            where id = $1 and job_id = $2 and tenant_id = $3 and deleted_at is null`,
          [docId, id, req.user.tid]);
        if (!d.rowCount) throw new ApiError("NOT_FOUND", "Document not found", 404);
        await c.query(
          `update job_documents set deleted_at = now(), updated_by = $2, updated_at = now()
            where id = $1 and tenant_id = $3`, [docId, req.user.sub, req.user.tid]);
        await logActivity(c, {
          tenantId: req.user.tid, jobId: id, shipmentId: job.shipment_id,
          actorUserId: req.user.sub, actorRole: actorRole(req),
          action: "document.removed", summary: `Removed from register: ${d.rows[0].title}`,
          entity: "job_documents", entityId: docId
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
          ip: req.ip, requestId: req.requestId, entity: "job_documents", entityId: docId,
          action: "document.removed"
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Stage 9: transport decision ----------
  app.post("/jobs/:id/decision", { preHandler: [requireAuth, requirePermission("jobs.decide")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = decisionSchema.parse(req.body);
      const handoverId = uuidv7();
      const out = await withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);
        if (job.status !== "open") throw new ApiError("CONFLICT", `A ${job.status} job is settled.`, 409);
        const stage = await c.query(
          `select id, status from job_stages where job_id = $1 and stage_key = 'transport_decision'
             and deleted_at is null`, [id]);
        if (!stage.rowCount) throw new ApiError("NOT_FOUND", "Stage 9 is missing on this job", 404);

        // Archive = a record of a shipment already finished. Information only:
        // no transport prompt, nothing on the notice board, no further action.
        const transportNeeded = body.recordKind === "archive" ? false : (body.transportNeeded ?? false);
        const consent = body.recordKind === "archive" ? "not_asked" : (body.consent ?? "not_asked");

        if (transportNeeded && consent === "not_asked") {
          throw new ApiError("VALIDATION_FAILED",
            "The client must be asked before shipment properties and route are used.", 400,
            [{ field: "consent" }]);
        }
        if (!transportNeeded && body.recordKind === "live" && !body.handover) {
          throw new ApiError("VALIDATION_FAILED",
            "Record who collected the cargo — name, date and signature or photo.", 400,
            [{ field: "handover" }]);
        }

        let handover: { receivedByName: string; method: string; documentId: string | null } | null = null;
        if (body.handover) {
          if (body.handover.documentId) {
            const f = await c.query(
              `select id from documents where id = $1 and tenant_id = $2 and deleted_at is null`,
              [body.handover.documentId, req.user.tid]);
            if (!f.rowCount) throw new ApiError("NOT_FOUND", "Stored file not found", 404);
          }
          await c.query(
            `insert into job_handovers (id, tenant_id, job_id, shipment_id, received_by_name,
               received_by_id_number, method, document_id, notes, happened_at, created_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz, now()),$11)`,
            [handoverId, req.user.tid, id, job.shipment_id, body.handover.receivedByName,
             body.handover.receivedByIdNumber ?? null, body.handover.method,
             body.handover.documentId ?? null, body.handover.notes ?? null,
             body.handover.happenedAt ?? null, req.user.sub]);
          handover = {
            receivedByName: body.handover.receivedByName, method: body.handover.method,
            documentId: body.handover.documentId ?? null
          };
        }

        await c.query(
          `update jobs set record_kind = $2, transport_needed = $3, transport_consent = $4,
             notes = coalesce($5, notes), updated_by = $6, updated_at = now()
           where id = $1 and tenant_id = $7`,
          [id, body.recordKind, transportNeeded, consent, body.notes ?? null,
           req.user.sub, req.user.tid]);

        await c.query(
          `update job_stages set status = 'done', blocked_reason = null,
             started_at = coalesce(started_at, now()), completed_at = now(),
             completed_by = $2, updated_by = $2, updated_at = now()
           where id = $1 and tenant_id = $3`,
          [stage.rows[0].id, req.user.sub, req.user.tid]);

        const summary = body.recordKind === "archive"
          ? `Record of a completed shipment saved — ${job.file_number} (no transport, no notice board)`
          : transportNeeded
            ? `Transport requested by client — consent ${consent}`
            : `Client collects the cargo — handover recorded`;
        await logActivity(c, {
          tenantId: req.user.tid, jobId: id, shipmentId: job.shipment_id,
          stageId: stage.rows[0].id, actorUserId: req.user.sub, actorRole: actorRole(req),
          action: "stage9.decided", summary,
          entity: "jobs", entityId: id,
          meta: { recordKind: body.recordKind, transportNeeded, consent, handover }
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
          ip: req.ip, requestId: req.requestId, entity: "jobs", entityId: id,
          action: "stage9.decided",
          before: { record_kind: job.record_kind, transport_consent: job.transport_consent },
          after: { recordKind: body.recordKind, transportNeeded, consent, handoverId }
        });
        return { recordKind: body.recordKind, transportNeeded, consent, handoverId };
      });
      return reply.send(out);
    });

  app.post("/jobs/:id/handovers", { preHandler: [requireAuth, requirePermission("jobs.decide")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = handoverSchema.parse(req.body);
      const handoverId = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);
        if (body.documentId) {
          const f = await c.query(
            `select id from documents where id = $1 and tenant_id = $2 and deleted_at is null`,
            [body.documentId, req.user.tid]);
          if (!f.rowCount) throw new ApiError("NOT_FOUND", "Stored file not found", 404);
        }
        await c.query(
          `insert into job_handovers (id, tenant_id, job_id, shipment_id, received_by_name,
             received_by_id_number, method, document_id, notes, happened_at, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz, now()),$11)`,
          [handoverId, req.user.tid, id, job.shipment_id, body.receivedByName,
           body.receivedByIdNumber ?? null, body.method, body.documentId ?? null,
           body.notes ?? null, body.happenedAt ?? null, req.user.sub]);
        await logActivity(c, {
          tenantId: req.user.tid, jobId: id, shipmentId: job.shipment_id,
          actorUserId: req.user.sub, actorRole: actorRole(req),
          action: "handover.recorded",
          summary: `Handover to ${body.receivedByName} recorded (${body.method})`,
          entity: "job_handovers", entityId: handoverId,
          meta: { method: body.method, document: body.documentId ?? null }
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
          ip: req.ip, requestId: req.requestId, entity: "job_handovers", entityId: handoverId,
          action: "handover.recorded", after: { jobId: id, method: body.method }
        });
      });
      return reply.status(201).send({ id: handoverId });
    });

  // ---------- Close and archive ----------
  app.post("/jobs/:id/close", { preHandler: [requireAuth, requirePermission("jobs.close")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      await withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);
        if (job.status === "closed") return;
        if (job.status === "cancelled") {
          throw new ApiError("CONFLICT", "A cancelled job cannot be closed.", 409);
        }
        const open = await c.query(
          `select name from job_stages where job_id = $1 and deleted_at is null and status <> 'done'
           order by position limit 1`, [id]);
        if (open.rowCount) {
          throw new ApiError("CONFLICT",
            `Cannot close — "${open.rows[0].name}" is not finished.`, 409,
            [{ openStage: open.rows[0].name }]);
        }
        // Cargo must be provably out of our hands: a verified POD when we
        // moved it, or a recorded handover when the client collected it.
        if (job.transport_needed) {
          const pod = await c.query(
            `select 1 from job_documents where job_id = $1 and kind = 'pod'
              and status = 'verified' and deleted_at is null limit 1`, [id]);
          if (!pod.rowCount) {
            throw new ApiError("CONFLICT",
              "Cannot close — every delivery needs a verified proof of delivery.", 409,
              [{ missingDocument: "pod" }]);
          }
        } else {
          const hv = await c.query(`select 1 from job_handovers where job_id = $1 limit 1`, [id]);
          if (!hv.rowCount && job.record_kind === "live") {
            throw new ApiError("CONFLICT",
              "Cannot close — record who collected the cargo first.", 409, [{ missing: "handover" }]);
          }
        }

        await c.query(
          `update jobs set status = 'closed', closed_at = now(), updated_by = $2, updated_at = now()
           where id = $1 and tenant_id = $3`, [id, req.user.sub, req.user.tid]);
        await c.query(
          `update cargo_shipments set status = 'completed', completed_at = now(),
             updated_by = $2, updated_at = now()
           where id = $1 and tenant_id = $3 and deleted_at is null and status <> 'completed'`,
          [job.shipment_id, req.user.sub, req.user.tid]);
        await logActivity(c, {
          tenantId: req.user.tid, jobId: id, shipmentId: job.shipment_id,
          actorUserId: req.user.sub, actorRole: actorRole(req),
          action: "job.closed", summary: `Job ${job.file_number} closed and archived`,
          entity: "jobs", entityId: id
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
          ip: req.ip, requestId: req.requestId, entity: "jobs", entityId: id,
          action: "job.closed", after: { shipmentId: job.shipment_id }
        });
      });
      return reply.send({ ok: true });
    });
}
