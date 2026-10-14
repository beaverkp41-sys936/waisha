/**
 * SQL validation for compliance.routes.ts + the licence branch of documents.routes.ts —
 * plans every statement against the live schema without executing writes (EXPLAIN only).
 * Run: npx tsx scripts/verify-compliance-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_ENTRY = "22222222-2222-7222-8222-222222222222";
const FAKE_CHECK = "33333333-3333-7333-8333-333333333333";
const FAKE_LICENCE = "44444444-4444-7444-8444-444444444444";
const FAKE_SHIPMENT = "55555555-5555-7555-8555-555555555555";
const FAKE_CLIENT = "66666666-6666-7666-8666-666666666666";
const FAKE_DOC = "77777777-7777-7777-8777-777777777777";

const checks: [string, string, unknown[]][] = [
  ["permission gate", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "screening.view"]],

  ["entries: list", `select id, party_name, tin, reason, source, severity, status, notes, created_at
       from screening_entries
       where tenant_id = $1 and deleted_at is null
       order by status, case severity when 'high' then 0 when 'medium' then 1 else 2 end, party_name`,
    [FAKE_TENANT]],

  ["entries: insert", `insert into screening_entries (id, tenant_id, party_name, tin, reason, source, severity, notes, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [FAKE_ENTRY, FAKE_TENANT, "Acme Ltd", null, "reason", "tra", "high", null, FAKE_USER]],

  ["entries: prev fetch", `select party_name, status from screening_entries
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_ENTRY, FAKE_TENANT]],

  ["entries: update", `update screening_entries set updated_by = $2, updated_at = now(),
       party_name = $4, tin = $5, reason = $6, source = $7, severity = $8, status = $9, notes = $10
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_ENTRY, FAKE_USER, FAKE_TENANT, "Acme Ltd", null, "reason", "internal", "low", "active", null]],

  ["entries: soft delete", `update screening_entries set deleted_at = now(), updated_by = $2
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_ENTRY, FAKE_USER, FAKE_TENANT]],

  ["matches: active entries", `select id, party_name, severity, reason from screening_entries
     where tenant_id = $1 and deleted_at is null and status = 'active'`,
    [FAKE_TENANT]],

  ["matches: open files", `select id, file_number, consignee_name, consignor_name from cargo_shipments
     where tenant_id = $1 and deleted_at is null and status = 'open'`,
    [FAKE_TENANT]],

  ["matches: clients", `select id, name from clients where tenant_id = $1 and deleted_at is null`,
    [FAKE_TENANT]],

  ["run: shipment fetch", `select file_number, consignee_name, consignor_name from cargo_shipments
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_SHIPMENT, FAKE_TENANT]],

  ["run: client fetch", `select name from clients where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_CLIENT, FAKE_TENANT]],

  ["run: check insert", `insert into screening_checks (id, tenant_id, subject_type, subject_id, subject_label, result, matches, checked_by)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [FAKE_CHECK, FAKE_TENANT, "shipment", FAKE_SHIPMENT, "FILE-1", "hit", "[]", FAKE_USER]],

  ["checks: log list", `select k.id, k.subject_type, k.subject_id, k.subject_label, k.result, k.matches,
              k.checked_at, u.full_name as checked_by_name
       from screening_checks k
       left join users u on u.id = k.checked_by
       where k.tenant_id = $1
       order by k.checked_at desc
       limit 25`,
    [FAKE_TENANT]],

  ["licences: list with status + docs", `select l.id, l.authority, l.title, l.licence_number,
              l.issued_date::text as issued_date, l.expiry_date::text as expiry_date, l.notes,
              (l.expiry_date - current_date)::int as days,
              case when l.expiry_date < current_date then 'expired'
                   when l.expiry_date <= current_date + 30 then 'expiring'
                   else 'valid' end as status,
              (select count(*)::int from documents d
                where d.tenant_id = l.tenant_id and d.entity_type = 'licence'
                  and d.entity_id = l.id and d.deleted_at is null) as document_count,
              (select d.id from documents d
                where d.tenant_id = l.tenant_id and d.entity_type = 'licence'
                  and d.entity_id = l.id and d.deleted_at is null
                order by d.created_at desc limit 1) as latest_document_id
       from regulatory_licences l
       where l.tenant_id = $1 and l.deleted_at is null
       order by l.expiry_date asc`,
    [FAKE_TENANT]],

  ["licences: insert", `insert into regulatory_licences (id, tenant_id, authority, title, licence_number,
       issued_date, expiry_date, notes, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [FAKE_LICENCE, FAKE_TENANT, "tra", "TRA clearing licence", null, null, "2027-01-01", null, FAKE_USER]],

  ["licences: prev fetch", `select title, expiry_date from regulatory_licences
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_LICENCE, FAKE_TENANT]],

  ["licences: update", `update regulatory_licences set updated_by = $2, updated_at = now(),
       authority = $4, title = $5, licence_number = $6, issued_date = $7, expiry_date = $8, notes = $9
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_LICENCE, FAKE_USER, FAKE_TENANT, "brela", "BRELA licence", "123", null, "2027-01-01", null]],

  ["licences: soft delete", `update regulatory_licences set deleted_at = now(), updated_by = $2
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_LICENCE, FAKE_USER, FAKE_TENANT]],

  ["licences: scans cascade", `update documents set deleted_at = now()
     where tenant_id = $1 and entity_type = 'licence' and entity_id = $2 and deleted_at is null`,
    [FAKE_TENANT, FAKE_LICENCE]],

  ["notifications: licence sweep", `select id, authority, title, expiry_date from regulatory_licences
     where tenant_id = $1 and deleted_at is null`,
    [FAKE_TENANT]],

  ["notifications: watch sweep", `select id, party_name, severity from screening_entries
     where tenant_id = $1 and deleted_at is null and status = 'active'`,
    [FAKE_TENANT]],

  ["calendar: licence expiries", `select title, authority, licence_number, expiry_date
     from regulatory_licences where tenant_id = $1 and deleted_at is null`,
    [FAKE_TENANT]],

  ["documents: licence guard", `select id from regulatory_licences where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_LICENCE, FAKE_TENANT]],

  ["documents: licence cap", `select count(*)::int as n from documents
     where tenant_id = $1 and entity_type = 'licence' and entity_id = $2 and deleted_at is null`,
    [FAKE_TENANT, FAKE_LICENCE]],

  ["documents: licence insert", `insert into documents (id, tenant_id, entity_type, entity_id, kind,
       file_name, mime_type, size_bytes, storage_path, uploaded_by, created_by, updated_by)
     values ($1,$2,'licence',$3,'licence','a.pdf','application/pdf',1,'p',$4,$4,$4)`,
    [FAKE_DOC, FAKE_TENANT, FAKE_LICENCE, FAKE_USER]],

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
              end as entity_label
       from documents d
       where d.tenant_id = $1 and d.deleted_at is null
         and ($2::text is null or d.entity_type = $2)
         and ($3::text is null or d.kind = $3)
       order by d.created_at desc
       limit 300`,
    [FAKE_TENANT, "licence", "licence"]]
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
  console.log("all compliance SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
