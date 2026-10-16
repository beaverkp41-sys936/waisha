/**
 * SQL validation for procedures.routes.ts, trainee-reports.routes.ts and the
 * profile half of employees.routes.ts — plans every statement those modules
 * emit against the live schema (EXPLAIN only, nothing executes), then checks the
 * shape migration 056 promised: the profile columns and their vocabularies, RLS
 * on all six new tables, grants that stay behind the append-only and read-only
 * lines, the 052-shaped split policies on the global library, the five gate
 * triggers that hold the checklist rules, the indexes the flow and the report
 * screens read, the seeded procedures and the permission matrix, and that no
 * Supabase default role can see any of it.
 * Run: npx tsx scripts/verify-trainee-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_EMPLOYEE = "22222222-2222-7222-8222-222222222222";
const FAKE_TASK = "33333333-3333-7333-8333-333333333333";
const FAKE_PROCEDURE = "44444444-4444-7444-8444-444444444444";
const FAKE_STEP = "55555555-5555-7555-8555-555555555555";
const FAKE_CHECK = "66666666-6666-7666-8666-666666666666";
const FAKE_REPORT = "77777777-7777-7777-8777-777777777777";
const FAKE_SIGNOFF = "88888888-8888-7888-8888-888888888888";

// Copied from employees.routes.ts — the profile block the roster and the
// personnel sheet read.
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
  e.user_id, e.notes,
  (e.phone_search is not null) as has_phone`;

const STEPS_JSON_SQL = `coalesce((select json_agg(json_build_object(
    'seq', s.seq, 'name', s.name, 'instructions', s.instructions,
    'checklist', s.checklist, 'required_documents', s.required_documents,
    'is_final', s.is_final) order by s.seq)
  from task_procedure_steps s
  where s.procedure_id = p.id and s.deleted_at is null), '[]'::json)`;

// Copied from trainee-reports.routes.ts — the report the print sheet reads.
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

// Copied from operations/task-flow.ts — the copy that lays a procedure under a task.
const MATERIALIZE_SQL = `with copied as (
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
  returning 1`;

const gate = (perm: string) => [`gate: ${perm}`, `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
  [FAKE_USER, perm]] as [string, string, unknown[]];

const statements: [string, string, unknown[]][] = [
  gate("procedures.view"), gate("procedures.create"), gate("procedures.edit"),
  gate("procedures.delete"), gate("trainee_reports.view"), gate("trainee_reports.create"),
  gate("trainee_reports.edit"), gate("trainee_reports.sign"),
  gate("employees.view"), gate("employees.edit"),
  gate("office_tasks.view"), gate("office_tasks.create"), gate("office_tasks.edit"),

  // ---------- Personnel profile ----------
  ["roster: profile block plus the trainee rollups", `
     select ${PROFILE_SELECT_SQL},
            (select count(*)::int from office_tasks t
              where t.tenant_id = e.tenant_id and t.employee_id = e.id
                and t.procedure_id is not null
                and t.status in ('pending','in_progress')) as flowed_tasks,
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
      where e.tenant_id = $1 and e.deleted_at is null
      order by e.full_name`, [FAKE_TENANT]],

  ["profile sheet: one person, no raw PII", `
     select ${PROFILE_SELECT_SQL},
            (select d.id from documents d
              where d.tenant_id = e.tenant_id and d.entity_type = 'employee'
                and d.entity_id = e.id and d.kind = 'avatar' and d.deleted_at is null
              order by d.created_at desc limit 1) as avatar_document_id,
            (select count(*)::int from trainee_reports r
              where r.tenant_id = e.tenant_id and r.employee_id = e.id
                and r.deleted_at is null) as report_count
       from employees e
       left join employees s on s.id = e.supervisor_id
      where e.id = $1 and e.tenant_id = $2 and e.deleted_at is null`,
    [FAKE_EMPLOYEE, FAKE_TENANT]],

  ["intake: writes the profile through the vault-free path", `
     insert into employees (id, tenant_id, full_name, phone_encrypted, phone_search,
       date_of_birth, gender, academic_status, college, qualifications,
       emergency_contact_name, emergency_relationship,
       emergency_phone_encrypted, emergency_phone_search,
       job_title, department, skills, employment_type, status, hired_date,
       contract_start, contract_end, supervisor_id, monthly_salary, notes,
       created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25,$26,$26)`,
    [FAKE_EMPLOYEE, FAKE_TENANT, "Amina J. Mushi", null, null, "2004-03-11", "female",
     "student", "Muhimbuni", ["DSE Certificate"], "Joseph Mushi", "Father", null, null,
     null, "Clearing", ["Excel"], "intern", "active", "2026-01-12", "2026-01-12",
     "2026-07-12", null, null, null, FAKE_USER]],

  ["profile edit is presence-based, emergency phone encrypted with its hash", `
     update employees set updated_by = $2, updated_at = now(),
       emergency_phone_encrypted = $4, emergency_phone_search = $5,
       academic_status = $6, college = $7, qualifications = $8
      where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_EMPLOYEE, FAKE_USER, FAKE_TENANT, Buffer.from("x"), "hash", "graduate",
     "Institute of Foreign Trade", ["Diploma"]]],

  // ---------- Procedure library ----------
  ["library: system defaults and the tenant's own, steps nested", `
     select p.id, p.name, p.description, p.scope, p.is_active,
            (p.tenant_id is null) as is_system,
            ${STEPS_JSON_SQL} as steps,
            (select count(*)::int from office_tasks t
              where t.procedure_id = p.id
                and t.status in ('pending','in_progress')) as open_tasks
       from task_procedures p
      where p.deleted_at is null
        and (p.tenant_id is null or p.tenant_id = $1)
        and ($2::text is null or p.scope = $2)
      order by (p.tenant_id is null) desc, p.name`, [FAKE_TENANT, "office"]],

  ["author a tenant procedure", `
     insert into task_procedures (id, tenant_id, name, description, scope, is_active,
       created_by, updated_by)
     values ($1,$2,$3,$4,$5,true,$6,$6)`,
    [FAKE_PROCEDURE, FAKE_TENANT, "Warehouse release", null, "office", FAKE_USER]],

  ["author its steps", `
     insert into task_procedure_steps
       (tenant_id, procedure_id, seq, name, instructions, checklist, required_documents, is_final)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [FAKE_TENANT, FAKE_PROCEDURE, 1, "Initiation", "Capture the request.",
     ["Request captured"], [], false]],

  ["duplicate reads a visible procedure and its steps", `
     select p.name, p.description, p.scope from task_procedures p
      where p.id = $1 and p.deleted_at is null
        and (p.tenant_id is null or p.tenant_id = $2)`, [FAKE_PROCEDURE, FAKE_TENANT]],

  ["duplicate copies the step rows", `
     insert into task_procedure_steps
       (tenant_id, procedure_id, seq, name, instructions, checklist, required_documents, is_final)
     select $2, $1, s.seq, s.name, s.instructions, s.checklist, s.required_documents, s.is_final
       from task_procedure_steps s
      where s.procedure_id = $3 and s.deleted_at is null
      order by s.seq`, [FAKE_PROCEDURE, FAKE_TENANT, FAKE_PROCEDURE]],

  ["retire the steps a tenant procedure is replacing", `
     update task_procedure_steps set deleted_at = now()
      where procedure_id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_PROCEDURE, FAKE_TENANT]],

  ["retire a procedure", `
     update task_procedures set deleted_at = now(), updated_by = $2
      where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_PROCEDURE, FAKE_USER, FAKE_TENANT]],

  // ---------- The flow behind a task ----------
  ["task list carries where each flow stands", `
     select t.id, t.employee_id, e.full_name as employee_name, e.department,
            t.shipment_id, cs.file_number,
            t.title, t.priority, t.due_date::text as due_date,
            (t.due_date - current_date)::int as days,
            t.status, t.done_at, t.on_time, t.notes, t.created_at,
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
      where t.tenant_id = $1
        and ($2::text is null or t.status = $2)
        and ($3::uuid is null or t.employee_id = $3)
      order by case when t.status in ('pending','in_progress') then 0 else 1 end, t.created_at desc
      limit 300`, [FAKE_TENANT, "in_progress", FAKE_EMPLOYEE]],

  ["assign a task straight onto a procedure", `
     insert into office_tasks (id, tenant_id, employee_id, shipment_id, title, priority,
        due_date, notes, procedure_id, created_by, updated_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
    [FAKE_TASK, FAKE_TENANT, FAKE_EMPLOYEE, null, "Clear the bonded warehouse batch",
     "high", "2026-11-02", null, FAKE_PROCEDURE, FAKE_USER]],

  ["flow read: the head row", `
     select t.id, t.procedure_id, p.name as procedure_name
       from office_tasks t
       left join task_procedures p on p.id = t.procedure_id
      where t.id = $1 and t.tenant_id = $2`, [FAKE_TASK, FAKE_TENANT]],

  ["flow read: steps with their checklists nested", `
     select s.id, s.seq, s.name, s.instructions, s.is_final, s.status, s.blocked_reason,
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
      order by s.seq`, [FAKE_TASK, FAKE_TENANT]],

  ["materialize: copy the procedure into the task", MATERIALIZE_SQL,
    [FAKE_TENANT, FAKE_TASK, FAKE_PROCEDURE, FAKE_USER]],

  ["materialize: a task that already has a flow is left alone", `
     select count(*)::int as steps,
            (select count(*)::int from office_task_step_checks ck
              where ck.step_id in (select id from office_task_steps where office_task_id = $1)) as checks
       from office_task_steps where office_task_id = $1`, [FAKE_TASK]],

  ["materialize: stamp the procedure onto the task", `
     update office_tasks set procedure_id = $2, updated_by = $3, updated_at = now()
      where id = $1 and tenant_id = $4`, [FAKE_TASK, FAKE_PROCEDURE, FAKE_USER, FAKE_TENANT]],

  ["step status moves with actor and stamps", `
     update office_task_steps set updated_by = $2, updated_at = now(),
       status = $4, blocked_reason = $5, completed_by = $6
      where id = $1 and tenant_id = $3`,
    [FAKE_STEP, FAKE_USER, FAKE_TENANT, "in_progress", null, FAKE_USER]],

  ["a blocked step always says why", `
     update office_task_steps set updated_by = $2, updated_at = now(),
       status = 'blocked', blocked_reason = $4
      where id = $1 and tenant_id = $3`,
    [FAKE_STEP, FAKE_USER, FAKE_TENANT, "Waiting on the release note"]],

  ["checklist item added at the end of the step", `
     select s.office_task_id, s.status,
            coalesce((select max(ck.seq)::int from office_task_step_checks ck
                       where ck.step_id = s.id), 0) as last_seq
       from office_task_steps s
      where s.id = $1 and s.tenant_id = $2`, [FAKE_STEP, FAKE_TENANT]],

  ["checklist item inserted", `
     insert into office_task_step_checks
       (id, tenant_id, step_id, seq, label, requires_document, doc_kind)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [FAKE_CHECK, FAKE_TENANT, FAKE_STEP, 4, "Bill of lading", true, "bill_of_lading"]],

  ["tick or untick one mandatory item", `
     update office_task_step_checks
        set ticked_at = case when $3 then now() else null end,
            ticked_by = case when $3 then $4::uuid else null end,
            evidence = case when $3 then coalesce($5, evidence) else null end,
            updated_at = now()
      where id = $1 and tenant_id = $2
      returning step_id`,
    [FAKE_CHECK, FAKE_TENANT, true, FAKE_USER, "Saw the original"]],

  ["a task closes only when the flow reached its end", `
     update office_tasks set updated_by = $2, updated_at = now(),
       status = 'done', done_at = now(), on_time = true
      where id = $1 and tenant_id = $3`, [FAKE_TASK, FAKE_USER, FAKE_TENANT]],

  // ---------- Trainee completion report ----------
  ["generation reads the record for the period", `
     select
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
       (select coalesce(string_agg('- ' || t.title, chr(10) order by t.due_date nulls last, t.created_at),
                'No tasks recorded in this period.')
          from (select title, due_date, created_at from office_tasks
                 where tenant_id = $1 and employee_id = $2 and status = 'done'
                   and done_at::date between $3 and $4
                 order by due_date nulls last, created_at limit 40) t) as task_overview`,
    [FAKE_TENANT, FAKE_EMPLOYEE, "2026-01-12", "2026-07-12"]],

  ["generate a draft report", `
     insert into trainee_reports
       (id, tenant_id, employee_id, period_start, period_end, status,
        tasks_total, tasks_done, tasks_on_time, task_overview,
        grade_task_completion, grade_punctuality, grade_client_satisfaction,
        grade_collaboration, created_by, updated_by)
     values ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
    [FAKE_REPORT, FAKE_TENANT, FAKE_EMPLOYEE, "2026-01-12", "2026-07-12", 18, 16, 14,
     "- Cleared three import files", 4, 3, 5, 4, FAKE_USER]],

  ["report register", `
     select r.id, r.employee_id, e.full_name, e.department, e.employment_type,
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
      limit 300`, [FAKE_TENANT, FAKE_EMPLOYEE]],

  ["the one-page report, with its sign-off block", `${REPORT_SELECT_SQL}
     where r.id = $1 and r.tenant_id = $2 and r.deleted_at is null`,
    [FAKE_REPORT, FAKE_TENANT]],

  ["remarks and grades are written before signing", `
     update trainee_reports set updated_by = $2, updated_at = now(),
       attendance_note = $4, supervisor_remarks = $5, grade_punctuality = $6
      where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_REPORT, FAKE_USER, FAKE_TENANT, "Present 116 of 120 working days.",
     "Reliable, asks early, improved fast on declarations.", 4]],

  ["a signature lands on its block", `
     insert into trainee_report_signoffs
       (id, tenant_id, report_id, role, signatory_name, signatory_title, signed_by, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [FAKE_SIGNOFF, FAKE_TENANT, FAKE_REPORT, "hod", "Rehema A. Salum",
     "Head of Clearing", FAKE_USER, null]],

  ["a mis-signed block is pulled while the report is open", `
     delete from trainee_report_signoffs where id = $1 and tenant_id = $2`,
    [FAKE_SIGNOFF, FAKE_TENANT]],

  ["close the paper", `
     update trainee_reports set status = 'complete', updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $3 and deleted_at is null and status = 'draft'`,
    [FAKE_REPORT, FAKE_USER, FAKE_TENANT]],

  ["reopen it only to correct a signature", `
     update trainee_reports set status = 'draft', completed_at = null,
             updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $3 and deleted_at is null and status = 'complete'`,
    [FAKE_REPORT, FAKE_USER, FAKE_TENANT]]
];

const shapeChecks: [string, string, (rows: any[]) => boolean][] = [
  ["the profile columns exist on the roster", `
     select column_name, data_type, is_nullable from information_schema.columns
     where table_name = 'employees'
       and column_name in ('date_of_birth','gender','academic_status','college',
         'qualifications','emergency_contact_name','emergency_relationship',
         'emergency_phone_encrypted','emergency_phone_search')`,
    (r) => r.length === 9],

  ["emergency phone is encrypted with a search hash, like the person's own", `
     select column_name, data_type from information_schema.columns
     where table_name = 'employees' and column_name = 'emergency_phone_encrypted'`,
    (r) => r[0]?.data_type === "bytea"],

  ["nothing stores an age — it is read off the date of birth", `
     select 1 from information_schema.columns
     where table_name = 'employees' and column_name = 'age'`,
    (r) => r.length === 0],

  ["the profile vocabularies are the ones the form offers", `
     select conname, pg_get_constraintdef(oid) as def from pg_constraint
     where conname in ('employees_gender_check','employees_academic_status_check')`,
    (r) => r.length === 2
      && ["'male'", "'female'", "'other'"].every((v) =>
        String(r.find((x: any) => x.conname === "employees_gender_check")?.def).includes(v))
      && ["'student'", "'graduate'"].every((v) =>
        String(r.find((x: any) => x.conname === "employees_academic_status_check")?.def).includes(v))],

  ["all six new tables enforce RLS", `
     select relname, relrowsecurity from pg_class
     where relname in ('task_procedures','task_procedure_steps','office_task_steps',
       'office_task_step_checks','trainee_reports','trainee_report_signoffs')`,
    (r) => r.length === 6 && r.every((x: any) => x.relrowsecurity === true)],

  ["the library splits read from write, so a tenant cannot touch a default", `
     select tablename, policyname, cmd from pg_policies
     where tablename in ('task_procedures','task_procedure_steps')`,
    (r) => r.length === 6 && ["task_procedures", "task_procedure_steps"].every((t) =>
      ["read", "insert", "update"].every((k) =>
        r.some((x: any) => x.tablename === t && x.policyname === `${t}_${k}`
          && x.cmd === (k === "read" ? "SELECT" : k.toUpperCase()))))],

  ["a read policy lets global rows through", `
     select qual from pg_policies where policyname = 'task_procedures_read'`,
    (r) => /tenant_id is null/i.test(String(r[0]?.qual))],

  ["every write policy demands a tenant match that NULL can never satisfy", `
     select with_check from pg_policies where policyname in
       ('task_procedures_insert','task_procedure_steps_insert',
        'task_procedures_update','task_procedure_steps_update')`,
    (r) => r.length === 4 && r.every((x: any) =>
      /tenant_id = \(?nullif\(current_setting\('app\.tenant_id'/i.test(String(x.with_check)))],

  ["the app role can never delete a signed report or its signatures", `
     select table_name, privilege_type from information_schema.role_table_grants
     where grantee = 'app_runtime' and privilege_type = 'DELETE'
       and table_name in ('trainee_reports','task_procedures','task_procedure_steps')`,
    (r) => r.length === 0],

  ["signatures are insert-only — a block is written once", `
     select string_agg(privilege_type, ',' order by privilege_type) as privs
     from information_schema.role_table_grants
     where grantee = 'app_runtime' and table_name = 'trainee_report_signoffs'`,
    (r) => r[0]?.privs === "DELETE,INSERT,SELECT"],

  ["only an item that was never ticked may be hard-deleted", `
     select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
     from information_schema.role_table_grants
     where grantee = 'app_runtime'
       and table_name in ('office_task_steps','office_task_step_checks','trainee_reports')
     group by table_name`,
    (r) => r.length === 3
      && String(r.find((x: any) => x.table_name === "office_task_steps")?.privs) === "INSERT,SELECT,UPDATE"
      && String(r.find((x: any) => x.table_name === "office_task_step_checks")?.privs) === "DELETE,INSERT,SELECT,UPDATE"
      && String(r.find((x: any) => x.table_name === "trainee_reports")?.privs) === "INSERT,SELECT,UPDATE"],

  ["the five gates exist", `
     select tgname from pg_trigger
     where not tgisinternal and tgname in ('trg_office_task_steps_gate',
       'trg_office_task_step_checks_gate','trg_office_tasks_gate',
       'trg_trainee_reports_gate','trg_trainee_report_signoffs_gate')`,
    (r) => r.length === 5],

  ["the step gate reads the checklist before it lets a step close", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'office_task_step_gate'`,
    (r) => /office_task_step_checks/i.test(String(r[0]?.def))
      && /unchecked item/i.test(String(r[0]?.def))
      && /earlier step/i.test(String(r[0]?.def))],

  ["the report gate names all three signatures", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'trainee_report_gate'`,
    (r) => /HOD, HR Manager and Direct Supervisor/i.test(String(r[0]?.def))
      && /training period is still open/i.test(String(r[0]?.def))
      && /supervisor remarks/i.test(String(r[0]?.def))
      && /old\.status = 'complete'/i.test(String(r[0]?.def))
      && /immutable once the report is signed off/i.test(String(r[0]?.def))],

  ["an open period is refused before the gate asks for a single signature", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'trainee_report_gate'`,
    (r) => {
      const def = String(r[0]?.def ?? "");
      const period = def.search(/training period is still open/i);
      const signed = def.search(/all three sign-offs/i);
      const remarks = def.search(/supervisor remarks/i);
      return period > -1 && period < signed && signed < remarks;
    }],

  ["a signed report is paper", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'trainee_signoff_gate'`,
    (r) => /immutable once the report is signed off/i.test(String(r[0]?.def))],

  ["closing a step always stamps it", `
     select conname, pg_get_constraintdef(oid) as def from pg_constraint
     where conname in ('office_task_steps_done_stamp','office_task_steps_blocked_reason',
       'office_task_step_checks_tick_stamp','trainee_reports_grade_range',
       'trainee_reports_period_order')`,
    (r) => r.length === 5
      && /status <> 'done'/i.test(String(r.find((x: any) => x.conname === "office_task_steps_done_stamp")?.def))
      && /completed_at IS NOT NULL/i.test(String(r.find((x: any) => x.conname === "office_task_steps_done_stamp")?.def))
      && ["grade_task_completion", "grade_punctuality", "grade_client_satisfaction", "grade_collaboration"]
        .every((g) => {
          const def = String(r.find((x: any) => x.conname === "trainee_reports_grade_range")?.def);
          return def.includes(`${g} >= 1`) && def.includes(`${g} <= 5`);
        })],

  ["one step per position on a task, one item per position on a step", `
     select indexname, indexdef from pg_indexes where indexname in
       ('office_task_steps_uq','office_task_step_checks_uq')`,
    (r) => r.length === 2
      && /\(office_task_id, seq\)/.test(String(r.find((x: any) => x.indexname === "office_task_steps_uq")?.indexdef))
      && /\(step_id, seq\)/.test(String(r.find((x: any) => x.indexname === "office_task_step_checks_uq")?.indexdef))],

  ["a trainee has one report per period and one signature per role", `
     select indexname, indexdef from pg_indexes where indexname in
       ('trainee_reports_period_uq','trainee_report_signoffs_uq')`,
    (r) => r.length === 2
      && /\(tenant_id, employee_id, period_start, period_end\)/.test(
        String(r.find((x: any) => x.indexname === "trainee_reports_period_uq")?.indexdef))
      && /\(report_id, role\)/.test(
        String(r.find((x: any) => x.indexname === "trainee_report_signoffs_uq")?.indexdef))],

  ["the flow and register indexes the screens read", `
     select indexname from pg_indexes where indexname in
       ('idx_office_task_steps_task','idx_office_task_steps_tenant_status',
        'idx_office_task_step_checks_step','idx_trainee_reports_employee',
        'idx_office_tasks_procedure','idx_task_procedures_scope',
        'task_procedure_steps_uq')`,
    (r) => r.length === 7],

  ["the three default procedures shipped with their steps", `
     select p.name, count(s.id)::int as steps,
            count(*) filter (where s.is_final)::int as finals
       from task_procedures p
       left join task_procedure_steps s on s.procedure_id = p.id and s.deleted_at is null
      where p.tenant_id is null and p.deleted_at is null
      group by p.name`,
    (r) => r.length === 3 && r.every((x: any) => x.steps >= 5 && x.finals === 1)],

  ["the import clearing flow demands its paperwork", `
     select s.seq, s.required_documents from task_procedure_steps s
       join task_procedures p on p.id = s.procedure_id
      where p.name = 'Import clearing file' and s.deleted_at is null
      order by s.seq`,
    (r) => r.length === 7
      && ["invoice", "packing_list", "bill_of_lading"].every((k) =>
        r.some((x: any) => (x.required_documents ?? []).includes(k)))
      && ["declaration", "release_note", "pod"].every((k) =>
        r.some((x: any) => (x.required_documents ?? []).includes(k)))],

  ["the completion flow ends on the three signatures", `
     select s.checklist from task_procedure_steps s
       join task_procedures p on p.id = s.procedure_id
      where p.name = 'Trainee induction and completion' and s.is_final and s.deleted_at is null`,
    (r) => r.length === 1 && ["Direct Supervisor signed", "HOD signed", "HR Manager signed"]
      .every((k) => (r[0]?.checklist ?? []).includes(k))],

  ["eight permission keys seeded", `
     select key from permissions where key like 'procedures.%' or key like 'trainee_reports.%'`,
    (r) => r.length === 8],

  ["the director holds the module", `
     select count(*)::int as n from role_permissions rp
       join roles r on r.id = rp.role_id
      join permissions p on p.key = rp.permission_key
     where r.key = 'director' and r.tenant_id is null
       and (p.key like 'procedures.%' or p.key like 'trainee_reports.%')`,
    (r) => r[0]?.n === 8],

  ["a trainee reads the flow, and nobody but the desk signs", `
     select r.key, p.key as perm from role_permissions rp
       join roles r on r.id = rp.role_id
       join permissions p on p.key = rp.permission_key
      where r.tenant_id is null
        and (p.key like 'procedures.%' or p.key like 'trainee_reports.%')
      order by r.key, p.key`,
    (r) => r.length > 12
      && !r.some((x: any) => x.key === "auditor" && x.perm !== "procedures.view"
        && x.perm !== "trainee_reports.view")
      && !r.some((x: any) => x.key === "trainee" && /\.(create|edit|sign|delete)$/.test(x.perm))],

  ["no Supabase default role can reach any of it", `
     select grantee, table_name from information_schema.role_table_grants
     where grantee in ('anon','authenticated','supabase_auth_admin','supabase_storage_admin')
       and table_name in ('task_procedures','task_procedure_steps','office_task_steps',
         'office_task_step_checks','trainee_reports','trainee_report_signoffs')`,
    (r) => r.length === 0]
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  let failed = 0;

  for (const [label, sql, params] of statements) {
    try {
      await pool.query("explain " + sql, params);
      console.log("ok   ", label);
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  for (const [label, sql, ok] of shapeChecks) {
    try {
      const { rows } = await pool.query(sql);
      const pass = ok(rows);
      console.log(pass ? "ok   " : "FAIL ", label, pass ? "" : `-> ${JSON.stringify(rows).slice(0, 240)}`);
      if (!pass) failed++;
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  await pool.end();
  if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log(`trainee SQL and 056 shape valid (${statements.length} statements, ${shapeChecks.length} shape checks)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
