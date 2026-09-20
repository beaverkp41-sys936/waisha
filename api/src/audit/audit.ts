import type { PoolClient } from "pg";
import { uuidv7 } from "../util/uuid.js";

export interface AuditEntry {
  tenantId?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  entity: string;
  entityId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
}

/** Append-only audit write; runs on the caller's transaction. */
export async function writeAudit(c: PoolClient, e: AuditEntry): Promise<void> {
  await c.query(
    `insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, user_agent, request_id,
       entity, entity_id, action, before, after)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
    [uuidv7(), e.tenantId ?? null, e.actorUserId ?? null, e.actorRole ?? null,
     e.ip ?? null, e.userAgent ?? null, e.requestId ?? null,
     e.entity, e.entityId ?? null, e.action,
     e.before === undefined ? null : JSON.stringify(e.before),
     e.after === undefined ? null : JSON.stringify(e.after)]
  );
}