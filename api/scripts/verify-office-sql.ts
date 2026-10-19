/**
 * SQL validation for employees.routes.ts + the employee branch of documents.routes.ts
 * + the office blocks in notifications.routes.ts / calendar.routes.ts —
 * plans every statement against the live schema without executing writes (EXPLAIN only).
 * Run: npx tsx scripts/verify-office-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_EMP = "22222222-2222-7222-8222-222222222222";
const FAKE_SUP = "33333333-3333-7333-8333-333333333333";
const FAKE_TASK = "44444444-4444-7444-8444-444444444444";
const FAKE_EVAL = "55555555-5555-7555-8555-555555555555";
const FAKE_SHIPMENT = "66666666-6666-7666-8666-666666666666";
const FAKE_DOC = "77777777-7777-7777-8777-777777777777";

const checks: [string, string, unknown[]][] = [
  ["permission gate", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "employees.view"]],

  ["employees: list with computed columns", `select e.id, e.full_name, e.job_title, e.department, e.skills,
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
    [FAKE_TENANT]],

  ["employees: supervisor check", `select id from employees
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_SUP, FAKE_TENANT]],

  ["employees: insert", `insert into employees (id, tenant_id, full_name, phone_encrypted, phone_search,
       job_title, department, skills, employment_type, status, hired_date,
       contract_start, contract_end, supervisor_id, monthly_salary, notes,
       created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
    [FAKE_EMP, FAKE_TENANT, "Asha Mwinyi", "enc", "hash", "Ops clerk", "Operations",
     ["dispatch"], "permanent", "active", "2025-01-01", "2025-01-01", "2027-01-01",
     FAKE_SUP, 850000, null, FAKE_USER]],

  ["employees: prev fetch", `select full_name, employment_type, status from employees
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_EMP, FAKE_TENANT]],

  ["employees: update (representative set)", `update employees set updated_by = $2, updated_at = now(),
       full_name = $4, phone_encrypted = $5, phone_search = $6, department = $7,
       status = $8, contract_end = $9, supervisor_id = $10, intern_absorbed = $11
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_EMP, FAKE_USER, FAKE_TENANT, "Asha Mwinyi", null, null, "Operations",
     "active", "2027-01-01", null, true]],

  ["employees: soft delete", `update employees set deleted_at = now(), updated_by = $2
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_EMP, FAKE_USER, FAKE_TENANT]],

  ["employees: delete cascade documents", `update documents set deleted_at = now()
     where tenant_id = $1 and entity_type = 'employee' and entity_id = $2 and deleted_at is null`,
    [FAKE_TENANT, FAKE_EMP]],

  ["employees: delete cascade open tasks", `update office_tasks set status = 'cancelled', updated_by = $2, updated_at = now()
     where tenant_id = $1 and employee_id = $3 and status in ('pending','in_progress')`,
    [FAKE_TENANT, FAKE_USER, FAKE_EMP]],

  ["office tasks: list with filters, file state and requester", `select t.id, t.employee_id, e.full_name as employee_name, e.department,
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
    [FAKE_TENANT, "pending", FAKE_EMP, FAKE_SHIPMENT]],

  // What a desk picks from when it hands a job over. The roster columns this
  // statement must NOT carry are the point of it: no pay, no phone, no account.
  ["office tasks: assignee shortlist", `select e.id, e.full_name, e.job_title, e.department, e.employment_type,
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
         limit 200`,
    [FAKE_TENANT]],

  ["auth: the seat reads its own duties", `select distinct rp.permission_key as key
         from user_roles ur
         join role_permissions rp on rp.role_id = ur.role_id
         where ur.user_id = $1
           and (ur.expires_at is null or ur.expires_at > now())
         order by 1`,
    [FAKE_USER]],

  ["office tasks: employee guard", `select id from employees
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_EMP, FAKE_TENANT]],

  ["office tasks: shipment guard", `select id from cargo_shipments
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_SHIPMENT, FAKE_TENANT]],

  ["office tasks: insert", `insert into office_tasks (id, tenant_id, employee_id, shipment_id, title, priority,
       due_date, notes, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [FAKE_TASK, FAKE_TENANT, FAKE_EMP, FAKE_SHIPMENT, "Chase TRA receipt", "high",
     "2026-10-20", null, FAKE_USER]],

  ["office tasks: prev fetch", `select employee_id, title, status, due_date::text as due_date from office_tasks
     where id = $1 and tenant_id = $2`,
    [FAKE_TASK, FAKE_TENANT]],

  ["office tasks: update (done with on_time)", `update office_tasks set updated_by = $2, updated_at = now(),
       status = $4, done_at = $5, on_time = $6
     where id = $1 and tenant_id = $3`,
    [FAKE_TASK, FAKE_USER, FAKE_TENANT, "done", "2026-10-14T09:00:00.000Z", true]],

  ["office tasks: update (details)", `update office_tasks set updated_by = $2, updated_at = now(),
       employee_id = $4, shipment_id = $5, title = $6, priority = $7, due_date = $8, notes = $9
     where id = $1 and tenant_id = $3`,
    [FAKE_TASK, FAKE_USER, FAKE_TENANT, FAKE_EMP, null, "Chase TRA receipt", "urgent",
     "2026-10-25", null]],

  ["office tasks: delete", `delete from office_tasks where id = $1 and tenant_id = $2`,
    [FAKE_TASK, FAKE_TENANT]],

  ["evaluations: list with filters", `select ev.id, ev.employee_id, e.full_name as employee_name, e.department,
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
    [FAKE_TENANT, FAKE_EMP]],

  ["evaluations: insert", `insert into employee_evaluations (id, tenant_id, employee_id, period,
       task_completion, punctuality, client_satisfaction, collaboration,
       notes, evaluated_by, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10)`,
    [FAKE_EVAL, FAKE_TENANT, FAKE_EMP, "2026-10-01", 4, 5, 4, 5, null, FAKE_USER]],

  ["evaluations: prev fetch", `select employee_id, period::text as period from employee_evaluations
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_EVAL, FAKE_TENANT]],

  ["evaluations: update", `update employee_evaluations set updated_by = $2, updated_at = now(),
       period = $4, task_completion = $5, punctuality = $6, client_satisfaction = $7,
       collaboration = $8, notes = $9
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_EVAL, FAKE_USER, FAKE_TENANT, "2026-10-01", 5, 5, 4, 4, null]],

  ["evaluations: soft delete", `update employee_evaluations set deleted_at = now(), updated_by = $2
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_EVAL, FAKE_USER, FAKE_TENANT]],

  ["notifications: contract sweep", `select id, full_name, employment_type, contract_end from employees
     where tenant_id = $1 and deleted_at is null and status = 'active'
       and contract_end is not null`,
    [FAKE_TENANT]],

  ["notifications: office task sweep", `select t.id, t.title, t.due_date, e.full_name from office_tasks t
     join employees e on e.id = t.employee_id
     where t.tenant_id = $1 and t.status in ('pending','in_progress') and t.due_date is not null
       and t.due_date <= current_date + 2`,
    [FAKE_TENANT]],

  ["calendar: contract expiries", `select full_name, employment_type, contract_end from employees
     where tenant_id = $1 and deleted_at is null and status = 'active'
       and contract_end is not null`,
    [FAKE_TENANT]],

  ["calendar: office task due dates", `select t.title, t.due_date, e.full_name from office_tasks t
     join employees e on e.id = t.employee_id
     where t.tenant_id = $1 and t.status in ('pending','in_progress') and t.due_date is not null`,
    [FAKE_TENANT]],

  ["documents: employee guard", `select id from employees where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_EMP, FAKE_TENANT]],

  ["documents: employee insert", `insert into documents (id, tenant_id, entity_type, entity_id, kind,
       file_name, mime_type, size_bytes, storage_path, uploaded_by, created_by, updated_by)
     values ($1,$2,'employee',$3,'contract','a.pdf','application/pdf',1,'p',$4,$4,$4)`,
    [FAKE_DOC, FAKE_TENANT, FAKE_EMP, FAKE_USER]],

  ["vault: labeled list", `select d.id, d.entity_type, d.entity_id, d.kind, d.file_name, d.mime_type,
              d.size_bytes, d.created_at,
              case d.entity_type
                when 'tenant' then (select name from tenants t where t.id = d.entity_id)
                when 'user' then (select full_name from users u where u.id = d.entity_id)
                when 'vessel' then (select name from vessels v where v.id = d.entity_id)
                when 'driver' then (select full_name from drivers dr where dr.id = d.entity_id)
                when 'trip' then (select coalesce(reference, 'Trip') from trips tr where tr.id = d.entity_id)
                when 'shipment' then (select file_number from cargo_shipments cs where cs.id = d.entity_id)
                when 'message' then (select coalesce(
                  (select cs.file_number from cargo_shipments cs where cs.id = m.shipment_id),
                  'Team channel')
                  from messages m where m.id = d.entity_id)
                when 'licence' then (select title from regulatory_licences rl where rl.id = d.entity_id)
                when 'employee' then (select full_name from employees emp where emp.id = d.entity_id)
              end as entity_label
       from documents d
       where d.tenant_id = $1 and d.deleted_at is null
         and ($2::text is null or d.entity_type = $2)
         and ($3::text is null or d.kind = $3)
       order by d.created_at desc
       limit 300`,
    [FAKE_TENANT, "employee", "contract"]]
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  const pool = new pg.Pool({ connectionString: url, max: 1 });

  let failed = 0;
  for (const [label, sql, params] of checks) {
    try {
      await pool.query("explain " + sql, params);
      console.log("ok   ", label);
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  await pool.end();
  if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log("all office SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
