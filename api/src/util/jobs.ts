import type { PoolClient } from "pg";
import { ApiError } from "./errors.js";
import { uuidv7 } from "./uuid.js";

export const STAGE_STATUS = ["not_started", "in_progress", "blocked", "done"] as const;
export type StageStatus = (typeof STAGE_STATUS)[number];

export const DOC_STATUS = ["pending", "received", "verified", "rejected"] as const;
export type DocStatus = (typeof DOC_STATUS)[number];

export interface ShipmentRef {
  shipment_type: string;
  file_number: string;
  status: string;
}

/**
 * Open (or re-open) the pipeline for a cargo file: job header, the ten stages
 * copied from the global template for the shipment type, and the checklist
 * tasks. Idempotent — an existing live job is returned untouched.
 */
export async function openJob(
  c: PoolClient,
  tenantId: string,
  shipmentId: string,
  actorUserId: string | null
): Promise<{ jobId: string; stages: number; tasks: number; existing: boolean }> {
  const found = await c.query(
    `select id from jobs where tenant_id = $1 and shipment_id = $2 and deleted_at is null`,
    [tenantId, shipmentId]);
  if (found.rowCount) {
    return { jobId: found.rows[0].id, stages: 0, tasks: 0, existing: true };
  }

  const ship = await c.query(
    `select shipment_type, file_number from cargo_shipments
      where id = $1 and tenant_id = $2 and deleted_at is null`,
    [shipmentId, tenantId]);
  if (!ship.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);

  const tpl = await c.query(
    `select stage_key, name, position, required_documents, default_tasks
       from (
         select distinct on (stage_key)
                stage_key, name, position, required_documents, default_tasks
           from job_stage_templates
          where deleted_at is null and shipment_type = $2
            and (tenant_id is null or tenant_id = $1)
          order by stage_key, (tenant_id = $1) desc nulls last
       ) t
      order by position`,
    [tenantId, ship.rows[0].shipment_type]);
  if (!tpl.rowCount) {
    throw new ApiError("VALIDATION_FAILED",
      `No stage template is configured for shipment type "${ship.rows[0].shipment_type}".`, 400);
  }

  const jobId = uuidv7();
  await c.query(
    `insert into jobs (id, tenant_id, shipment_id, created_by, updated_by)
     values ($1,$2,$3,$4,$4)`,
    [jobId, tenantId, shipmentId, actorUserId]);

  let stages = 0;
  let tasks = 0;
  for (const t of tpl.rows) {
    const stageId = uuidv7();
    await c.query(
      `insert into job_stages (id, tenant_id, job_id, shipment_id, stage_key, name, position,
         required_documents, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [stageId, tenantId, jobId, shipmentId, t.stage_key, t.name, t.position,
       t.required_documents, actorUserId]);
    stages++;
    for (const title of (t.default_tasks as string[])) {
      await c.query(
        `insert into cargo_tasks (id, tenant_id, shipment_id, stage_id, title, status, created_by, updated_by)
         values ($1,$2,$3,$4,$5,'pending',$6,$6)`,
        [uuidv7(), tenantId, shipmentId, stageId, title, actorUserId]);
      tasks++;
    }
  }

  await logActivity(c, {
    tenantId, jobId, shipmentId, actorUserId,
    action: "job.opened",
    summary: `Checklist generated for ${ship.rows[0].file_number} — ${stages} stages, ${tasks} tasks`,
    entity: "jobs", entityId: jobId,
    meta: { stages, tasks }
  });
  return { jobId, stages, tasks, existing: false };
}

/** Tasks may only point at live people in the caller's own tenant. */
export async function assertAssignable(
  c: PoolClient, tenantId: string, userId: string
): Promise<void> {
  const r = await c.query(
    `select 1 from users
      where id = $1 and tenant_id = $2 and deleted_at is null and status = 'active'
      limit 1`,
    [userId, tenantId]);
  if (!r.rowCount) {
    throw new ApiError("VALIDATION_FAILED",
      "Assignee must be an active member of your company.", 400, [{ field: "assignedTo" }]);
  }
}

export interface ActivityInput {
  tenantId: string;
  jobId?: string | null;
  shipmentId?: string | null;
  stageId?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  summary: string;
  entity?: string;
  entityId?: string | null;
  meta?: unknown;
}

/** Timeline row for the job feed. Mirrors writeAudit, but is scoped per job. */
export async function logActivity(c: PoolClient, e: ActivityInput): Promise<void> {
  await c.query(
    `insert into job_activity (id, tenant_id, job_id, shipment_id, stage_id,
       actor_user_id, actor_role, action, summary, entity, entity_id, meta)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [uuidv7(), e.tenantId, e.jobId ?? null, e.shipmentId ?? null, e.stageId ?? null,
     e.actorUserId ?? null, e.actorRole ?? null, e.action, e.summary,
     e.entity ?? null, e.entityId ?? null,
     e.meta === undefined ? null : JSON.stringify(e.meta)]);
}

/** Required document kinds still lacking a verified row for this job. */
export async function missingVerifiedDocs(
  c: PoolClient, tenantId: string, jobId: string, required: string[]
): Promise<string[]> {
  if (!required.length) return [];
  const r = await c.query(
    `select k.kind from unnest($2::text[]) as k(kind)
      where not exists (
        select 1 from job_documents d
         where d.tenant_id = $1 and d.job_id = $3 and d.kind = k.kind
           and d.status = 'verified' and d.deleted_at is null)`,
    [tenantId, required, jobId]);
  return r.rows.map((x: { kind: string }) => x.kind);
}

export interface StageRow {
  id: string;
  job_id: string;
  shipment_id: string;
  stage_key: string;
  name: string;
  position: number;
  status: StageStatus;
  blocked_reason: string | null;
  required_documents: string[];
}

export async function loadStage(
  c: PoolClient, tenantId: string, jobId: string, stageId: string
): Promise<StageRow> {
  const r = await c.query(
    `select id, job_id, shipment_id, stage_key, name, position, status,
            blocked_reason, required_documents
       from job_stages
      where id = $1 and job_id = $2 and tenant_id = $3 and deleted_at is null`,
    [stageId, jobId, tenantId]);
  if (!r.rowCount) throw new ApiError("NOT_FOUND", "Stage not found", 404);
  return r.rows[0];
}

export async function loadJob(c: PoolClient, tenantId: string, jobId: string) {
  const r = await c.query(
    `select j.id, j.tenant_id, j.shipment_id, j.record_kind, j.status,
            j.transport_needed, j.transport_consent, j.free_days,
            j.free_days_start::text as free_days_start,
            j.closed_at, j.notes, j.created_at, j.updated_at,
            s.file_number, s.shipment_type, s.status as shipment_status,
            s.eta, s.discharge_date, s.consignee_name, s.consignor_name
       from jobs j
       join cargo_shipments s on s.id = j.shipment_id
      where j.id = $1 and j.tenant_id = $2 and j.deleted_at is null
        and s.deleted_at is null`,
    [jobId, tenantId]);
  if (!r.rowCount) throw new ApiError("NOT_FOUND", "Job not found", 404);
  return r.rows[0];
}
