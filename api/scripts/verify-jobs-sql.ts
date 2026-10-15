/**
 * Step 3 — SQL validation for jobs.routes.ts + util/jobs.ts.
 * Plans every statement against the live schema (EXPLAIN, no writes), then
 * checks the security shape of the six new tables: RLS on, tenant policy
 * present, grants as narrow as the routes need, job_activity and job_handovers
 * append-only for the app role, and the global template table readable but not
 * writable. Run: npx tsx scripts/verify-jobs-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const T = "00000000-0000-7000-8000-000000000000";  // tenant
const U = "11111111-1111-7111-8111-111111111111";  // actor
const J = "22222222-2222-7222-8222-222222222222";  // job
const S = "33333333-3333-7333-8333-333333333333";  // shipment
const G = "44444444-4444-7444-8444-444444444444";  // stage
const D = "55555555-5555-7555-8555-555555555555";  // job document
const K = "66666666-6666-7666-8666-666666666666";  // task
const F = "77777777-7777-7777-8777-777777777777";  // stored file
const H = "88888888-8888-7888-8888-888888888888";  // handover

const sql: [string, string, unknown[]][] = [
  // ---- util/jobs.ts ----
  ["openJob: existing lookup",
    `select id from jobs where tenant_id = $1 and shipment_id = $2 and deleted_at is null`, [T, S]],
  ["openJob: shipment type",
    `select shipment_type, file_number from cargo_shipments
      where id = $1 and tenant_id = $2 and deleted_at is null`, [S, T]],
  ["openJob: template precedence",
    `select stage_key, name, position, required_documents, default_tasks from (
       select distinct on (stage_key) stage_key, name, position, required_documents, default_tasks
         from job_stage_templates
        where deleted_at is null and shipment_type = $2
          and (tenant_id is null or tenant_id = $1)
        order by stage_key, (tenant_id = $1) desc nulls last) t order by position`, [T, "import"]],
  ["openJob: insert job",
    `insert into jobs (id, tenant_id, shipment_id, record_kind, status, transport_consent,
        created_by, updated_by) values ($1,$2,$3,'live','open','not_asked',$4,$4)`, [J, T, S, U]],
  ["openJob: insert stage",
    `insert into job_stages (id, tenant_id, job_id, shipment_id, stage_key, name, position,
        status, required_documents, created_by, updated_by)
      values ($1,$2,$3,$4,$5,$6,$7,'not_started',$8,$9,$9)`,
    [G, T, J, S, "job_opening", "Job opening", 1, ["invoice"], U]],
  ["openJob: insert checklist task",
    `insert into cargo_tasks (id, tenant_id, shipment_id, stage_id, title, status)
      values ($1,$2,$3,$4,$5,'pending')`, [K, T, S, G, "Collect documents"]],
  ["openJob: staff ids",
    `select id from users where tenant_id = $1 and deleted_at is null and status = 'active'`, [T]],
  ["missingVerifiedDocs",
    `select k.kind from unnest($2::text[]) as k(kind)
      where not exists (select 1 from job_documents d
        where d.tenant_id = $1 and d.job_id = $3 and d.kind = k.kind
          and d.status = 'verified' and d.deleted_at is null)`, [T, ["invoice", "permit"], J]],
  ["loadJob",
    `select j.*, s.file_number, s.shipment_type, s.status as shipment_status,
            s.eta, s.discharge_date, s.consignee_name, s.consignor_name
       from jobs j
       join cargo_shipments s on s.id = j.shipment_id
      where j.id = $1 and j.tenant_id = $2 and j.deleted_at is null
        and s.deleted_at is null`, [J, T]],
  ["loadStage",
    `select g.id, g.stage_key, g.name, g.position, g.status, g.blocked_reason, g.required_documents
       from job_stages g
      where g.id = $1 and g.job_id = $2 and g.tenant_id = $3 and g.deleted_at is null`, [G, J, T]],
  ["logActivity",
    `insert into job_activity (id, tenant_id, job_id, shipment_id, stage_id, actor_user_id,
        actor_role, action, summary, entity, entity_id, meta, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, now())`,
    [U, T, J, S, G, U, "director", "job.opened", "Checklist generated", "jobs", J, "{}"]],

  // ---- routes: list / open / templates ----
  ["jobs: list",
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
      limit 300`, [T, "open", "live", "job_opening", "%ISO%", U]],
  ["templates: legend",
    `select stage_key, name, position, required_documents, default_tasks
       from job_stage_templates
      where deleted_at is null and shipment_type = $1
        and (tenant_id is null or tenant_id = $2)
      order by position`, ["transit", T]],

  // ---- routes: dashboard ----
  ["dashboard: counts",
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
                  and d.status = 'rejected') as rejected_docs`, [T]],
  ["dashboard: blocked",
    `select j.id as job_id, j.shipment_id, s.file_number, s.consignee_name,
            g.name as stage, g.blocked_reason, g.updated_at as blocked_at
       from job_stages g
       join jobs j on j.id = g.job_id and j.status = 'open'
       join cargo_shipments s on s.id = j.shipment_id
      where g.tenant_id = $1 and g.deleted_at is null and g.status = 'blocked'
        and j.deleted_at is null and s.deleted_at is null
      order by g.updated_at desc limit 25`, [T]],
  ["dashboard: overdue",
    `select k.id, k.title, k.due_date, k.shipment_id, j.id as job_id,
            s.file_number, coalesce(u.full_name, 'Unassigned') as assignee
       from cargo_tasks k
       join jobs j on j.shipment_id = k.shipment_id and j.status = 'open'
       join cargo_shipments s on s.id = k.shipment_id
       left join users u on u.id = k.assigned_to
      where k.tenant_id = $1 and k.status = 'pending' and k.due_date < current_date
        and j.deleted_at is null and s.deleted_at is null
      order by k.due_date limit 25`, [T]],
  ["dashboard: deadline clocks",
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
     order by x.days_left asc limit 40`, [T]],
  ["dashboard: expiring licences",
    `select title, licence_number, expiry_date, (expiry_date - current_date) as days_left
       from regulatory_licences
      where tenant_id = $1 and deleted_at is null and expiry_date <= current_date + 30
      order by expiry_date limit 10`, [T]],

  // ---- routes: board / my-tasks ----
  ["board: jobs",
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
      order by s.file_number limit 300`, [T]],
  ["board: stage columns",
    `select stage_key, name, position from job_stage_templates
      where deleted_at is null and shipment_type = 'import' and tenant_id is null
      order by position`, []],
  ["my-tasks",
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
      order by k.due_date nulls last, s.file_number limit 200`, [T, U, "open"]],

  // ---- routes: detail ----
  ["detail: stages",
    `select g.id, g.stage_key, g.name, g.position, g.status, g.blocked_reason,
            g.required_documents, g.started_at, g.completed_at,
            (select count(*)::int from cargo_tasks k
              where k.stage_id = g.id and k.status = 'pending') as open_tasks,
            (select count(*)::int from job_documents d
              where d.job_id = g.job_id and d.stage_key = g.stage_key
                and d.deleted_at is null) as docs_in_stage
       from job_stages g
      where g.job_id = $1 and g.deleted_at is null
      order by g.position`, [J]],
  ["detail: tasks",
    `select k.id, k.title, k.stage_id, k.assigned_to, k.due_date, k.status,
            k.done_at, k.notes, k.created_at,
            coalesce(u.full_name, 'Unassigned') as assignee_name
       from cargo_tasks k left join users u on u.id = k.assigned_to
      where k.shipment_id = $1 and k.tenant_id = $2
      order by (k.status = 'pending') desc, k.due_date nulls last, k.created_at`, [S, T]],
  ["detail: documents",
    `select d.id, d.title, d.kind, d.direction, d.from_party, d.to_party,
            d.doc_date, d.status, d.stage_key, d.document_id, d.notes,
            d.verified_at, d.rejection_reason,
            f.file_name, f.mime_type, f.size_bytes
       from job_documents d left join documents f on f.id = d.document_id
      where d.job_id = $1 and d.tenant_id = $2 and d.deleted_at is null
      order by d.doc_date desc nulls last, d.created_at desc`, [J, T]],
  ["detail: handovers",
    `select h.id, h.received_by_name, h.received_by_id_number, h.method,
            h.document_id, h.notes, h.happened_at, h.created_by, f.file_name
       from job_handovers h left join documents f on f.id = h.document_id
      where h.job_id = $1 and h.tenant_id = $2
      order by h.happened_at desc`, [J, T]],
  ["detail: activity",
    `select a.id, a.action, a.summary, a.stage_id, a.entity, a.entity_id,
            a.meta, a.created_at, coalesce(u.full_name, 'System') as actor_name
       from job_activity a left join users u on u.id = a.actor_user_id
      where a.job_id = $1 and a.tenant_id = $2
      order by a.created_at desc limit 50`, [J, T]],
  ["detail: staff picklist",
    `select id, full_name from users
      where tenant_id = $1 and deleted_at is null and status = 'active'
        and user_type in ('director','staff') order by full_name`, [T]],
  ["timeline",
    `select a.id, a.action, a.summary, a.stage_id, a.entity, a.entity_id,
            a.meta, a.created_at, coalesce(u.full_name, 'System') as actor_name,
            g.stage_key, g.name as stage_name
       from job_activity a
       left join users u on u.id = a.actor_user_id
       left join job_stages g on g.id = a.stage_id
      where a.job_id = $1 and a.tenant_id = $2
        and ($3::timestamptz is null or a.created_at < $3)
      order by a.created_at desc limit $4`, [J, T, null, 80]],

  // ---- routes: writes ----
  ["job: patch header",
    `update jobs set updated_by = $2, updated_at = now(), free_days = $4, free_days_start = $5
     where id = $1 and tenant_id = $3`, [J, U, T, 14, "2026-10-01"]],
  ["stage: earlier-stage guard",
    `select name from job_stages
      where job_id = $1 and deleted_at is null and position < $2 and status <> 'done'
      order by position limit 1`, [J, 4]],
  ["stage: set status",
    `update job_stages set status = $2, blocked_reason = $3,
       started_at = case when $2 = 'not_started' then null
                         else coalesce(started_at, case when $2 = 'done' then now() else now() end) end,
       completed_at = case when $2 = 'done' then now() else null end,
       completed_by = case when $2 = 'done' then $4::uuid else null end,
       updated_by = $4, updated_at = now()
     where id = $1 and tenant_id = $5`, [G, "done", null, U, T]],
  ["task: insert",
    `insert into cargo_tasks (id, tenant_id, shipment_id, stage_id, title, assigned_to,
        due_date, notes, status)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`, [K, T, S, G, "Submit declaration", U, "2026-10-20", null]],
  ["task: patch",
    `update cargo_tasks set title = $4, assigned_to = $5, due_date = $6, notes = $7,
        stage_id = $8, status = $9,
        done_at = case when $9 = 'done' then now() else null end
      where id = $1 and tenant_id = $2 and shipment_id = $3`,
    [K, T, S, "Submit declaration", U, "2026-10-20", null, G, "done"]],
  ["task: fetch own",
    `select id, title, status from cargo_tasks
      where id = $1 and tenant_id = $2 and shipment_id = $3`, [K, T, S]],
  ["document: stored file check",
    `select id from documents where id = $1 and tenant_id = $2 and deleted_at is null`, [F, T]],
  ["document: register insert",
    `insert into job_documents (id, tenant_id, job_id, shipment_id, stage_key, title, kind,
        direction, from_party, to_party, doc_date, document_id, status, notes,
        created_by, updated_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'received',$13,$14,$14)`,
    [D, T, J, S, "pre_arrival_docs", "Bill of Lading", "bill_of_lading", "received",
     "Maersk", "Alpha Ltd", "2026-10-01", F, null, U]],
  ["document: status set",
    `update job_documents set status = $2,
       verified_by = case when $2 in ('verified','rejected') then $4 else verified_by end,
       verified_at = case when $2 in ('verified','rejected') then now() else null end,
       rejection_reason = case when $2 = 'rejected' then $3 else null end,
       updated_by = $4, updated_at = now()
     where id = $1 and tenant_id = $5`, [D, "verified", null, U, T]],
  ["document: fetch own",
    `select id, title from job_documents
      where id = $1 and job_id = $2 and tenant_id = $3 and deleted_at is null`, [D, J, T]],
  ["document: soft delete",
    `update job_documents set deleted_at = now(), updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $3`, [D, U, T]],
  ["decision: write",
    `update jobs set record_kind = $2, transport_needed = $3, transport_consent = $4,
        notes = coalesce($5, notes), updated_by = $6, updated_at = now()
      where id = $1 and tenant_id = $7`, [J, "live", true, "granted", null, U, T]],
  ["handover: insert",
    `insert into job_handovers (id, tenant_id, job_id, shipment_id, received_by_name,
        received_by_id_number, method, document_id, notes, happened_at, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::timestamptz, now()), $11)`,
    [H, T, J, S, "Juma Mwanza", "19800412XXXX", "signature", F, null, null, U]],
  ["close: guard on stages",
    `select count(*)::int as n from job_stages
      where job_id = $1 and deleted_at is null and status <> 'done'`, [J]],
  ["close: guard on proof",
    `select exists (select 1 from job_documents d
        where d.job_id = $1 and d.tenant_id = $2 and d.kind = 'pod'
          and d.status = 'verified' and d.deleted_at is null) as pod,
       exists (select 1 from job_handovers h
        where h.job_id = $1 and h.tenant_id = $2) as handover`, [J, T]],
  ["close: job closed",
    `update jobs set status = 'closed', closed_at = now(), updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $3`, [J, U, T]],
  ["close: shipment completed",
    `update cargo_shipments set status = 'completed', completed_at = now(),
        updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $3 and deleted_at is null`, [S, U, T]],
  ["permission gate: assign check",
    `select 1 from user_roles ur
      join role_permissions rp on rp.role_id = ur.role_id
      where ur.user_id = $1 and rp.permission_key = 'jobs.assign'
        and (ur.expires_at is null or ur.expires_at > now()) limit 1`, [U]],
  ["assignee must be in tenant",
    `select id, full_name from users
      where id = $1 and tenant_id = $2 and deleted_at is null and status = 'active'`, [U, T]]
];

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  const pool = new pg.Pool({ connectionString: url, max: 1,
    ssl: { rejectUnauthorized: false } });

  let failed = 0;
  for (const [label, stmt, params] of sql) {
    try {
      await pool.query("explain " + stmt, params);
      console.log("ok   ", label);
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  console.log("\n--- security shape of the job tables ---");
  const TABLES = ["jobs", "job_stage_templates", "job_stages", "job_documents",
    "job_handovers", "job_activity"];
  // Append-only for the runtime role: activity feed and handover evidence.
  const APPEND_ONLY = new Set(["job_activity", "job_handovers"]);
  const READ_ONLY = new Set(["job_stage_templates"]);

  const shape = await pool.query(
    `select c.relname as t, c.relrowsecurity as rls,
            (select count(*) from pg_policies p
              where p.tablename = c.relname and p.schemaname = 'public') as policies,
            (select string_agg(distinct privilege_type, ',' order by privilege_type)
               from information_schema.table_privileges
              where table_name = c.relname and grantee = 'app_runtime') as app_grants,
            (select count(*) from pg_trigger tg
              join pg_class k on k.oid = tg.tgrelid
             where k.relname = c.relname and not tg.tgisinternal
               and tg.tgtype::int & 3 > 0) as delete_or_update_triggers
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1::text[])
      order by c.relname`, [TABLES]);

  for (const r of shape.rows) {
    const want: string[] = [];
    if (!r.rls) want.push("RLS off");
    if (Number(r.policies) === 0) want.push("no tenant policy");
    const grants: string[] = (r.app_grants ?? "").split(",").filter(Boolean);
    const expected = APPEND_ONLY.has(r.t) ? ["INSERT", "SELECT"]
      : READ_ONLY.has(r.t) ? ["SELECT"] : ["INSERT", "SELECT", "UPDATE"];
    if (grants.slice().sort().join(",") !== expected.slice().sort().join(","))
      want.push(`grants are "${r.app_grants ?? "none"}", want ${expected.join("/")}`);
    if (APPEND_ONLY.has(r.t) && Number(r.delete_or_update_triggers) === 0)
      want.push("no append-only guard trigger");
    console.log(want.length ? `FAIL  ${r.t} - ${want.join("; ")}` : `ok    ${r.t}`,
      `(rls=${r.rls} policies=${r.policies} grants=${r.app_grants ?? "none"})`);
    if (want.length) failed++;
  }
  if (shape.rowCount !== TABLES.length) {
    console.log(`FAIL  only ${shape.rowCount}/${TABLES.length} job tables found`);
    failed++;
  }

  await pool.end();
  if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
  console.log("\nall job SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
