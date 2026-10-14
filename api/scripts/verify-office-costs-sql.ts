/**
 * SQL validation for office-costs.routes.ts + the office_cost branch of
 * documents.routes.ts + the office cost blocks in notifications.routes.ts —
 * plans every statement against the live schema without executing writes (EXPLAIN only).
 * Run: npx tsx scripts/verify-office-costs-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_COST = "22222222-2222-7222-8222-222222222222";
const FAKE_EMP = "33333333-3333-7333-8333-333333333333";
const FAKE_SHIPMENT = "44444444-4444-7444-8444-444444444444";
const FAKE_BUDGET = "55555555-5555-7555-8555-555555555555";
const FAKE_DOC = "66666666-6666-7666-8666-666666666666";

const checks: [string, string, unknown[]][] = [
  ["permission gate: view", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "office_costs.view"]],

  ["permission gate: approve", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "office_costs.approve"]],

  ["permission gate: budgets manage", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "office_budgets.manage"]],

  ["costs: list with filters", `select oc.id, oc.cost_date::text as cost_date, oc.category, oc.description,
                oc.amount::float8 as amount, oc.payee, oc.payment_method, oc.receipt_no,
                oc.status, oc.review_note, oc.notes, oc.created_at,
                oc.employee_id, e.full_name as employee_name,
                oc.shipment_id, cs.file_number,
                oc.approved_by, u.full_name as approved_by_name, oc.approved_at,
                (select count(*)::int from documents d
                  where d.tenant_id = oc.tenant_id and d.entity_type = 'office_cost'
                    and d.entity_id = oc.id and d.deleted_at is null) as document_count,
                (select d.id from documents d
                  where d.tenant_id = oc.tenant_id and d.entity_type = 'office_cost'
                    and d.entity_id = oc.id and d.deleted_at is null
                  order by d.created_at desc limit 1) as latest_document_id
         from office_costs oc
         left join employees e on e.id = oc.employee_id
         left join cargo_shipments cs on cs.id = oc.shipment_id
         left join users u on u.id = oc.approved_by
         where oc.tenant_id = $1 and oc.deleted_at is null
           and ($2::date is null or (oc.cost_date >= $2 and oc.cost_date < ($2::date + interval '1 month')))
           and ($3::text is null or oc.category = $3)
           and ($4::text is null or oc.status = $4)
           and ($5::uuid is null or oc.shipment_id = $5)
           and ($6::uuid is null or oc.employee_id = $6)
           and ($7::text is null or oc.description ilike $7 or oc.payee ilike $7 or oc.receipt_no ilike $7)
         order by case when oc.status = 'pending' then 0 else 1 end,
                  oc.cost_date desc, oc.created_at desc
         limit 400`,
    [FAKE_TENANT, "2026-10-01", "meals", "pending", FAKE_SHIPMENT, FAKE_EMP, "%fuel%", ]],

  ["costs: employee guard", `select id from employees
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_EMP, FAKE_TENANT]],

  ["costs: shipment guard", `select id from cargo_shipments
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_SHIPMENT, FAKE_TENANT]],

  ["costs: insert", `insert into office_costs (id, tenant_id, cost_date, category, description, amount,
             payee, employee_id, shipment_id, payment_method, receipt_no, notes,
             created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
    [FAKE_COST, FAKE_TENANT, "2026-10-14", "allowance", "Site allowance for dispatch team", 120000,
     null, FAKE_EMP, null, "mobile_money", "R-1042", null, FAKE_USER]],

  ["costs: prev fetch", `select description, status, amount::float8 as amount from office_costs
           where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_COST, FAKE_TENANT]],

  ["costs: update (edit reset)", `update office_costs set updated_by = $2, updated_at = now(),
       cost_date = $4, category = $5, description = $6, amount = $7, payee = $8,
       employee_id = $9, shipment_id = $10, payment_method = $11, receipt_no = $12, notes = $13,
       status = $14, approved_by = $15, approved_at = $16, review_note = $17
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_COST, FAKE_USER, FAKE_TENANT, "2026-10-15", "meals", "Lunch for clearing team", 90000,
     "Mama Asha Cafe", null, FAKE_SHIPMENT, "cash", null, null, "pending", null, null, null]],

  ["costs: decision prev fetch", `select description, status from office_costs
           where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_COST, FAKE_TENANT]],

  ["costs: decision update", `update office_costs set status = $4, approved_by = $2, approved_at = now(),
             review_note = $5, updated_by = $2, updated_at = now()
           where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_COST, FAKE_USER, FAKE_TENANT, "approved", "Looks right — receipt filed."]],

  ["costs: soft delete", `update office_costs set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_COST, FAKE_USER, FAKE_TENANT]],

  ["costs: delete cascade documents", `update documents set deleted_at = now()
             where tenant_id = $1 and entity_type = 'office_cost' and entity_id = $2 and deleted_at is null`,
    [FAKE_TENANT, FAKE_COST]],

  ["summary: spend by category", `select category,
                  coalesce(sum(amount) filter (where status = 'approved'), 0)::float8 as spent,
                  coalesce(sum(amount) filter (where status = 'pending'), 0)::float8 as pending,
                  count(*) filter (where status = 'pending')::int as pending_count,
                  count(*) filter (where status = 'approved')::int as approved_count
           from office_costs
           where tenant_id = $1 and deleted_at is null
             and cost_date >= $2 and cost_date < ($2::date + interval '1 month')
           group by category`,
    [FAKE_TENANT, "2026-10-01"]],

  ["summary: month budgets", `select category, amount::float8 as amount from office_budgets
           where tenant_id = $1 and period = $2 and deleted_at is null`,
    [FAKE_TENANT, "2026-10-01"]],

  ["summary: 6-month trend", `select to_char(date_trunc('month', cost_date), 'YYYY-MM') as month,
                  coalesce(sum(amount) filter (where status = 'approved'), 0)::float8 as value,
                  count(*) filter (where status = 'approved')::int as count
           from office_costs
           where tenant_id = $1 and deleted_at is null
             and cost_date >= ($2::date - interval '5 months')
             and cost_date < ($2::date + interval '1 month')
           group by 1`,
    [FAKE_TENANT, "2026-10-01"]],

  ["file costs: totals", `select count(distinct oc.shipment_id)::int as files,
                  coalesce(sum(oc.amount) filter (where oc.status = 'approved'), 0)::float8 as allocated,
                  coalesce(sum(oc.amount) filter (where oc.status = 'pending'), 0)::float8 as pending
           from office_costs oc
           where oc.tenant_id = $1 and oc.deleted_at is null and oc.shipment_id is not null`,
    [FAKE_TENANT]],

  ["file costs: rows", `select s.id, s.file_number, s.shipment_type, s.stage, s.status, s.consignee_name,
                  s.payment_status,
                  s.payment_amount::float8 as payment_amount,
                  s.processing_cost::float8 as processing_cost,
                  c.allocated::float8 as allocated,
                  c.pending_amount::float8 as pending_amount,
                  c.entries::int as entries
           from cargo_shipments s
           join (select shipment_id,
                        coalesce(sum(amount) filter (where status = 'approved'), 0) as allocated,
                        coalesce(sum(amount) filter (where status = 'pending'), 0) as pending_amount,
                        count(*) as entries
                 from office_costs
                 where tenant_id = $1 and deleted_at is null and shipment_id is not null
                 group by shipment_id) c on c.shipment_id = s.id
           where s.tenant_id = $1 and s.deleted_at is null
           order by c.allocated desc, s.file_number
           limit 200`,
    [FAKE_TENANT]],

  ["budgets: list", `select id, period::text as period, category, amount::float8 as amount, notes, created_at
         from office_budgets
         where tenant_id = $1 and period = $2 and deleted_at is null
         order by category`,
    [FAKE_TENANT, "2026-10-01"]],

  ["budgets: upsert", `insert into office_budgets (id, tenant_id, period, category, amount, notes, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, $7)
           on conflict (tenant_id, period, category) where deleted_at is null
           do update set amount = excluded.amount, notes = excluded.notes,
                         updated_by = excluded.updated_by, updated_at = now()
           returning id`,
    [FAKE_BUDGET, FAKE_TENANT, "2026-10-01", "meals", 500000, null, FAKE_USER]],

  ["budgets: soft delete", `update office_budgets set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_BUDGET, FAKE_USER, FAKE_TENANT]],

  ["notifications: pending costs sweep", `select count(*)::int as n,
                coalesce(sum(amount), 0)::float8 as total,
                count(*) filter (where created_at < now() - interval '7 days')::int as stale
         from office_costs
         where tenant_id = $1 and deleted_at is null and status = 'pending'`,
    [FAKE_TENANT]],

  ["notifications: budget vs spend sweep", `select b.category, b.amount::float8 as budget,
                coalesce(sum(c.amount) filter (where c.status = 'approved'), 0)::float8 as spent
         from office_budgets b
         left join office_costs c
           on c.tenant_id = b.tenant_id and c.category = b.category and c.deleted_at is null
           and c.cost_date >= b.period and c.cost_date < (b.period + interval '1 month')
         where b.tenant_id = $1 and b.deleted_at is null
           and b.period = date_trunc('month', current_date)::date
         group by b.id`,
    [FAKE_TENANT]],

  ["documents: office_cost guard", `select id from office_costs where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_COST, FAKE_TENANT]],

  ["documents: office_cost receipt insert", `insert into documents (id, tenant_id, entity_type, entity_id, kind,
       file_name, mime_type, size_bytes, storage_path, uploaded_by, created_by, updated_by)
     values ($1,$2,'office_cost',$3,'receipt','r.pdf','application/pdf',1,'p',$4,$4,$4)`,
    [FAKE_DOC, FAKE_TENANT, FAKE_COST, FAKE_USER]],

  ["vault: labeled list with office_cost", `select d.id, d.entity_type, d.entity_id, d.kind, d.file_name, d.mime_type,
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
                when 'office_cost' then (select oc.description from office_costs oc where oc.id = d.entity_id)
              end as entity_label
       from documents d
       where d.tenant_id = $1 and d.deleted_at is null
         and ($2::text is null or d.entity_type = $2)
         and ($3::text is null or d.kind = $3)
       order by d.created_at desc
       limit 300`,
    [FAKE_TENANT, "office_cost", "receipt"]]
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
  console.log("all office cost SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
