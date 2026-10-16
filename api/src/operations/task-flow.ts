import type { PoolClient } from "pg";
import { ApiError } from "../util/errors.js";

/**
 * The procedural mapping engine (spec Part 3). A procedure is a library object;
 * a task's flow is a copy of it taken at the moment the task is assigned, the
 * same way 042 copies stage templates into job_stages. The copy is what keeps
 * half-finished work honest — editing the library afterwards must not rewrite a
 * flow that someone has already ticked three steps into.
 *
 * Which step may close, and what a task may be marked done on, is enforced by
 * the 056 triggers, not here. This module reads and writes; the database
 * refuses.
 */

export type FlowStep = {
  id: string;
  seq: number;
  name: string;
  instructions: string | null;
  is_final: boolean;
  status: string;
  blocked_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  checks: FlowCheck[];
};

export type FlowCheck = {
  id: string;
  seq: number;
  label: string;
  requires_document: boolean;
  doc_kind: string | null;
  ticked_at: string | null;
  ticked_by: string | null;
  evidence: string | null;
};

export type TaskFlow = {
  procedureId: string | null;
  procedureName: string | null;
  steps: FlowStep[];
  stepsTotal: number;
  stepsDone: number;
  checksTotal: number;
  checksOpen: number;
  /** Where the flow indicator points: the first step that is not done. */
  currentSeq: number | null;
};

async function requireProcedure(
  c: PoolClient, tenantId: string, procedureId: string
): Promise<{ name: string; scope: string }> {
  const r = await c.query(
    `select p.name, p.scope from task_procedures p
      where p.id = $1 and p.deleted_at is null and p.is_active
        and (p.tenant_id is null or p.tenant_id = $2)`,
    [procedureId, tenantId]);
  if (!r.rowCount) throw new ApiError("NOT_FOUND", "Procedure not found or retired.", 404, [{ field: "procedureId" }]);
  return r.rows[0];
}

/**
 * Attach a procedure to a task and lay its steps under it. Idempotent: a task
 * that already carries a flow keeps it, so re-attaching the same procedure is a
 * no-op rather than a second copy of the checklist.
 */
export async function materializeTaskFlow(
  c: PoolClient, opts: {
    tenantId: string; taskId: string; procedureId: string; userId: string;
  }
): Promise<{ steps: number; checks: number }> {
  const { tenantId, taskId, procedureId, userId } = opts;
  await requireProcedure(c, tenantId, procedureId);

  const existing = await c.query(
    `select count(*)::int as steps,
            (select count(*)::int from office_task_step_checks ck
              where ck.step_id in (select id from office_task_steps where office_task_id = $1)) as checks
       from office_task_steps where office_task_id = $1`, [taskId]);
  if (existing.rows[0].steps > 0) {
    await c.query(
      `update office_tasks set procedure_id = $2, updated_by = $3, updated_at = now()
        where id = $1 and tenant_id = $4 and procedure_id is distinct from $2`,
      [taskId, procedureId, userId, tenantId]);
    return { steps: existing.rows[0].steps, checks: existing.rows[0].checks };
  }

  const created = await c.query(
    `with copied as (
       insert into office_task_steps
         (tenant_id, office_task_id, seq, name, instructions, is_final, created_by, updated_by)
       select $1, $2, s.seq, s.name, s.instructions, s.is_final, $4, $4
         from task_procedure_steps s
        where s.procedure_id = $3 and s.deleted_at is null
        order by s.seq
         returning id, seq
     ), templ as (
       select s.seq, s.checklist, s.required_documents
         from task_procedure_steps s
        where s.procedure_id = $3 and s.deleted_at is null
     )
     insert into office_task_step_checks
       (tenant_id, step_id, seq, label, requires_document, doc_kind)
     select $1, n.id, item.ord, item.label, item.kind is not null, item.kind
       from copied n
       join templ t on t.seq = n.seq
       cross join lateral (
         select u.ord, u.lbl as label, null::text as kind
           from unnest(t.checklist) with ordinality as u(lbl, ord)
         union all
         select u2.ord + coalesce(array_length(t.checklist, 1), 0), u2.k, u2.k
           from unnest(t.required_documents) with ordinality as u2(k, ord)
       ) item
      where coalesce(trim(item.label), '') <> ''
      returning 1`,
    [tenantId, taskId, procedureId, userId]);

  await c.query(
    `update office_tasks set procedure_id = $2, updated_by = $3, updated_at = now()
      where id = $1 and tenant_id = $4`, [taskId, procedureId, userId, tenantId]);

  const total = await c.query(
    `select count(*)::int as steps from office_task_steps where office_task_id = $1`, [taskId]);
  return { steps: total.rows[0].steps, checks: created.rowCount ?? 0 };
}

/**
 * The whole flow for one task — the shape the web's step indicator and the
 * report both read. Task lookup is by id and tenant, so an out-of-tenant id
 * returns nothing rather than a foreign flow.
 */
export async function readTaskFlow(
  c: PoolClient, tenantId: string, taskId: string
): Promise<TaskFlow | null> {
  const head = await c.query(
    `select t.id, t.procedure_id, p.name as procedure_name
       from office_tasks t
       left join task_procedures p on p.id = t.procedure_id
      where t.id = $1 and t.tenant_id = $2`, [taskId, tenantId]);
  if (!head.rowCount) return null;

  const { rows } = await c.query(
    `select s.id, s.seq, s.name, s.instructions, s.is_final, s.status, s.blocked_reason,
            to_char(s.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as started_at,
            to_char(s.completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as completed_at,
            coalesce((select json_agg(json_build_object(
                        'id', ck.id, 'seq', ck.seq, 'label', ck.label,
                        'requires_document', ck.requires_document, 'doc_kind', ck.doc_kind,
                        'ticked_at', to_char(ck.ticked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                        'ticked_by', ck.ticked_by, 'evidence', ck.evidence)
                       order by ck.seq)
                    from office_task_step_checks ck
                   where ck.step_id = s.id), '[]'::json) as checks
       from office_task_steps s
       where s.office_task_id = $1 and s.tenant_id = $2
      order by s.seq`, [taskId, tenantId]);

  const steps = rows.map((r) => ({ ...r, checks: r.checks as FlowCheck[] })) as FlowStep[];
  const checksTotal = steps.reduce((n, s) => n + s.checks.length, 0);
  const checksOpen = steps.reduce((n, s) => n + s.checks.filter((ck) => !ck.ticked_at).length, 0);
  return {
    procedureId: head.rows[0].procedure_id,
    procedureName: head.rows[0].procedure_name,
    steps,
    stepsTotal: steps.length,
    stepsDone: steps.filter((s) => s.status === "done").length,
    checksTotal,
    checksOpen,
    currentSeq: steps.find((s) => s.status !== "done")?.seq ?? null
  };
}

/**
 * Tick or untick one mandatory item. The stamp is the actor, never a timestamp
 * someone typed in — a checklist that can be backdated is not evidence.
 */
export async function setCheckTick(
  c: PoolClient, opts: {
    tenantId: string; checkId: string; ticked: boolean; userId: string; evidence?: string | null;
  }
): Promise<{ stepId: string }> {
  const { tenantId, checkId, ticked, userId, evidence } = opts;
  const r = await c.query(
    `update office_task_step_checks
        set ticked_at = case when $3 then now() else null end,
            ticked_by = case when $3 then $4::uuid else null end,
            evidence = case when $3 then coalesce($5, evidence) else null end,
            updated_at = now()
      where id = $1 and tenant_id = $2
      returning step_id`,
    [checkId, tenantId, ticked, userId, evidence ?? null]);
  if (!r.rowCount) throw new ApiError("NOT_FOUND", "Checklist item not found", 404);
  return { stepId: r.rows[0].step_id };
}
