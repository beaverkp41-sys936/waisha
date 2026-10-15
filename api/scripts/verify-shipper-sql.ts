/**
 * SQL validation for shipper-accounts.routes.ts + portal.routes.ts —
 * plans every statement against the live schema without executing writes (EXPLAIN only).
 * Run: npx tsx scripts/verify-shipper-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_ACCOUNT = "22222222-2222-7222-8222-222222222222";
const FAKE_SHIPMENT = "33333333-3333-7333-8333-333333333333";
const FAKE_SHARE = "44444444-4444-7444-8444-444444444444";
const FAKE_DOC = "55555555-5555-7555-8555-555555555555";
const FAKE_CLIENT = "66666666-6666-7666-8666-666666666666";
const FAKE_INVOICE = "77777777-7777-7777-8777-777777777777";
const FAKE_HASH = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

const SHIPMENT_VISIBLE_SQL = `exists (
    select 1 from shipper_accounts sa
    join clients c on c.id = sa.client_id and c.deleted_at is null
    where sa.tenant_id = $1 and sa.user_id = $2
      and sa.status = 'active' and sa.deleted_at is null
      and (lower(trim(cs.consignee_name)) = lower(trim(c.name))
        or lower(trim(cs.consignor_name)) = lower(trim(c.name)))
  )
  or exists (
    select 1 from shipper_file_shares sfs
    join shipper_accounts sa2 on sa2.id = sfs.shipper_account_id
    where sfs.tenant_id = $1 and sfs.shipment_id = cs.id and sfs.deleted_at is null
      and sa2.user_id = $2 and sa2.status = 'active' and sa2.deleted_at is null
  )`;

const INVOICE_VISIBLE_SQL = `exists (
    select 1 from shipper_accounts sa
    join clients c on c.id = sa.client_id and c.deleted_at is null
    where sa.tenant_id = $1 and sa.user_id = $2
      and sa.status = 'active' and sa.deleted_at is null
      and lower(trim(i.customer_name)) = lower(trim(c.name))
  )`;

const EFFECTIVE_STATUS_SQL = `case
  when i.status = 'cancelled' then 'cancelled'
  when i.status = 'draft' then 'draft'
  when i.amount_paid >= i.total and i.total > 0 then 'paid'
  when i.amount_paid > 0 then 'partial'
  when i.due_date is not null and i.due_date < current_date then 'overdue'
  else 'sent'
end`;

const checks: [string, string, unknown[]][] = [
  ["permission gate: portal.view", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "portal.view"]],

  ["permission gate: portal.upload", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "portal.upload"]],

  ["permission gate: shipper_accounts.view", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "shipper_accounts.view"]],

  ["accounts: list with counts", `select sa.id, sa.client_id, c.name as client_name, sa.user_id,
                u.full_name, u.email, u.status as user_status, sa.status, sa.notes,
                sa.invited_at, ib.full_name as invited_by_name,
                (u.phone_search is not null) as has_phone,
                (select count(*)::int from cargo_shipments cs
                  where cs.tenant_id = sa.tenant_id and cs.deleted_at is null
                    and (lower(trim(cs.consignee_name)) = lower(trim(c.name))
                      or lower(trim(cs.consignor_name)) = lower(trim(c.name)))) as matched_files,
                (select count(*)::int from shipper_file_shares sfs
                  where sfs.shipper_account_id = sa.id and sfs.deleted_at is null) as shared_files,
                (select count(*)::int from freight_invoices i
                  where i.tenant_id = sa.tenant_id and i.deleted_at is null
                    and lower(trim(i.customer_name)) = lower(trim(c.name))) as invoice_count
         from shipper_accounts sa
         join clients c on c.id = sa.client_id
         join users u on u.id = sa.user_id
         left join users ib on ib.id = sa.invited_by
         where sa.tenant_id = $1 and sa.deleted_at is null
         order by c.name, u.full_name`,
    [FAKE_TENANT]],

  ["accounts: client guard", `select id, name from clients where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_CLIENT, FAKE_TENANT]],

  ["accounts: email dupe guard", `select id from users where email_normalized_search = $1`,
    [FAKE_HASH]],

  ["accounts: users insert (shipper)", `insert into users (id, tenant_id, user_type, email, email_normalized_search,
               phone_encrypted, phone_search, password_hash, status, full_name, created_by, updated_by)
             values ($1,$2,'shipper',$3,$4,$5,$6,$7,'active',$8,$9,$9)`,
    [FAKE_USER, FAKE_TENANT, "shipper@example.com", FAKE_HASH, null, null, "argon2hash", "Test Shipper", FAKE_USER]],

  ["accounts: role grant", `insert into user_roles (user_id, role_id, granted_by)
             select $1, id, $2 from roles where tenant_id is null and key = 'shipper_portal'
             on conflict do nothing`,
    [FAKE_USER, FAKE_USER]],

  ["accounts: shipper_accounts insert", `insert into shipper_accounts (id, tenant_id, client_id, user_id, status,
               invited_by, notes, created_by, updated_by)
             values ($1,$2,$3,$4,'active',$5,$6,$7,$7)`,
    [FAKE_ACCOUNT, FAKE_TENANT, FAKE_CLIENT, FAKE_USER, FAKE_USER, null, FAKE_USER]],

  ["accounts: detail fetch", `select sa.id, sa.client_id, c.name as client_name, sa.user_id, u.full_name, u.email,
                  u.status as user_status, sa.status, sa.notes, sa.invited_at,
                  (u.phone_search is not null) as has_phone
           from shipper_accounts sa
           join clients c on c.id = sa.client_id
           join users u on u.id = sa.user_id
           where sa.id = $1 and sa.tenant_id = $2 and sa.deleted_at is null`,
    [FAKE_ACCOUNT, FAKE_TENANT]],

  ["accounts: matched files", `select cs.id, cs.file_number, cs.shipment_type, cs.stage, cs.status,
                  cs.eta::text as eta, cs.consignee_name, cs.consignor_name, cs.payment_status
           from cargo_shipments cs
           where cs.tenant_id = $1 and cs.deleted_at is null
             and exists (
               select 1 from shipper_accounts sa
               join clients c on c.id = sa.client_id and c.deleted_at is null
               where sa.id = $2 and sa.tenant_id = $1 and sa.deleted_at is null
                 and (lower(trim(cs.consignee_name)) = lower(trim(c.name))
                   or lower(trim(cs.consignor_name)) = lower(trim(c.name))))
           order by cs.file_number`,
    [FAKE_TENANT, FAKE_ACCOUNT]],

  ["accounts: shared files", `select cs.id, cs.file_number, cs.stage, cs.status, sfs.created_at as shared_at
           from shipper_file_shares sfs
           join cargo_shipments cs on cs.id = sfs.shipment_id
           where sfs.tenant_id = $1 and sfs.shipper_account_id = $2 and sfs.deleted_at is null
           order by sfs.created_at desc`,
    [FAKE_TENANT, FAKE_ACCOUNT]],

  ["accounts: update prev fetch", `select sa.user_id, sa.status, sa.notes, u.full_name, u.status as user_status
           from shipper_accounts sa join users u on u.id = sa.user_id
           where sa.id = $1 and sa.tenant_id = $2 and sa.deleted_at is null`,
    [FAKE_ACCOUNT, FAKE_TENANT]],

  ["accounts: users update (full edit)", `update users set updated_by = $2, full_name = $3,
               phone_encrypted = $4, phone_search = $5, password_hash = $6, status = $7
             where id = $1`,
    [FAKE_USER, FAKE_USER, "Test Shipper", null, null, "argon2hash", "active"]],

  ["accounts: shipper_accounts update", `update shipper_accounts set updated_by = $2, updated_at = now(),
               notes = $4, status = $5
             where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_ACCOUNT, FAKE_USER, FAKE_TENANT, null, "suspended"]],

  ["accounts: sessions revoke", `update sessions set revoked_at = now(), revoked_reason = 'password_reset'
             where user_id = $1 and revoked_at is null`,
    [FAKE_USER]],

  ["accounts: delete account", `update shipper_accounts set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_ACCOUNT, FAKE_USER, FAKE_TENANT]],

  ["accounts: delete user", `update users set deleted_at = now(), updated_by = $2 where id = $1`,
    [FAKE_USER, FAKE_USER]],

  ["accounts: delete revoke sessions", `update sessions set revoked_at = now(), revoked_reason = 'account_removed'
             where user_id = $1 and revoked_at is null`,
    [FAKE_USER]],

  ["shares: insert", `insert into shipper_file_shares (id, tenant_id, shipper_account_id, shipment_id, shared_by)
           values ($1,$2,$3,$4,$5)`,
    [FAKE_SHARE, FAKE_TENANT, FAKE_ACCOUNT, FAKE_SHIPMENT, FAKE_USER]],

  ["shares: file guard", `select id, file_number from cargo_shipments
           where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_SHIPMENT, FAKE_TENANT]],

  ["shares: remove", `update shipper_file_shares set deleted_at = now()
           where shipper_account_id = $1 and shipment_id = $2 and tenant_id = $3 and deleted_at is null`,
    [FAKE_ACCOUNT, FAKE_SHIPMENT, FAKE_TENANT]],

  ["portal: account guard", `select sa.id, sa.client_id, c.name as client_name, u.full_name
     from shipper_accounts sa
     join clients c on c.id = sa.client_id and c.deleted_at is null
     join users u on u.id = sa.user_id
     where sa.tenant_id = $1 and sa.user_id = $2
       and sa.status = 'active' and sa.deleted_at is null`,
    [FAKE_TENANT, FAKE_USER]],

  ["portal: overview counts", `select count(*)::int as total,
                  count(*) filter (where cs.status = 'open')::int as open,
                  count(*) filter (where cs.status = 'on_hold')::int as on_hold,
                  count(*) filter (where cs.stage = 'customs')::int as in_customs,
                  count(*) filter (where cs.eta is not null and cs.eta between current_date and current_date + 7)::int as arriving_soon,
                  count(*) filter (where cs.status = 'completed')::int as completed
           from cargo_shipments cs
           where cs.tenant_id = $1 and cs.deleted_at is null and ${SHIPMENT_VISIBLE_SQL}`,
    [FAKE_TENANT, FAKE_USER]],

  ["portal: overview outstanding", `select count(*)::int as count,
                  coalesce(sum(i.total - i.amount_paid), 0)::float8 as amount
           from freight_invoices i
           where i.tenant_id = $1 and i.deleted_at is null and i.status <> 'cancelled'
             and i.amount_paid < i.total and ${INVOICE_VISIBLE_SQL}`,
    [FAKE_TENANT, FAKE_USER]],

  ["portal: overview recent files", `select cs.id, cs.file_number, cs.shipment_type, cs.stage, cs.status,
                  cs.eta::text as eta, (cs.eta - current_date)::int as eta_days,
                  cs.payment_status, cs.updated_at
           from cargo_shipments cs
           where cs.tenant_id = $1 and cs.deleted_at is null and ${SHIPMENT_VISIBLE_SQL}
           order by cs.updated_at desc
           limit 5`,
    [FAKE_TENANT, FAKE_USER]],

  ["portal: overview recent documents", `select d.id, d.kind, d.file_name, d.size_bytes, d.created_at, cs.file_number
           from documents d
           join cargo_shipments cs on cs.id = d.entity_id
           where d.tenant_id = $1 and d.entity_type = 'shipment' and d.deleted_at is null
             and ${SHIPMENT_VISIBLE_SQL}
           order by d.created_at desc
           limit 5`,
    [FAKE_TENANT, FAKE_USER]],

  ["portal: files list", `select cs.id, cs.file_number, cs.shipment_type, cs.stage, cs.status,
                cs.eta::text as eta, (cs.eta - current_date)::int as eta_days,
                cs.shipping_line, cs.bill_number, cs.container_type, cs.container_count,
                cs.consignee_name, cs.consignor_name,
                cs.payment_amount::float8 as payment_amount, cs.payment_status,
                cs.updated_at
         from cargo_shipments cs
         where cs.tenant_id = $1 and cs.deleted_at is null and ${SHIPMENT_VISIBLE_SQL}
         order by case cs.status when 'open' then 0 when 'on_hold' then 1 else 2 end,
                  cs.eta asc nulls last, cs.updated_at desc
         limit 200`,
    [FAKE_TENANT, FAKE_USER]],

  ["portal: file detail", `select cs.id, cs.file_number, cs.shipment_type, cs.stage, cs.status,
                  cs.hs_code, cs.cargo_description,
                  cs.container_type, cs.container_count, cs.container_numbers,
                  cs.cbm::float8 as cbm, cs.weight_tonnes::float8 as weight_tonnes,
                  cs.consignee_name, cs.consignor_name, cs.shipping_line, cs.bill_number,
                  cs.order_date::text as order_date,
                  cs.document_receipt_date::text as document_receipt_date,
                  cs.eta::text as eta, cs.discharge_date::text as discharge_date,
                  cs.carry_in_date::text as carry_in_date,
                  cs.terms_delivery, cs.tansad_number, cs.rcn_number, cs.reference_number,
                  cs.payment_amount::float8 as payment_amount, cs.payment_status,
                  cs.completed_at, cs.created_at, cs.updated_at
           from cargo_shipments cs
           where cs.id = $3 and cs.tenant_id = $1 and cs.deleted_at is null
             and ${SHIPMENT_VISIBLE_SQL}`,
    [FAKE_TENANT, FAKE_USER, FAKE_SHIPMENT]],

  ["portal: file documents", `select id, kind, file_name, mime_type, size_bytes, created_at
           from documents
           where tenant_id = $1 and entity_type = 'shipment' and entity_id = $2
             and deleted_at is null
           order by created_at desc`,
    [FAKE_TENANT, FAKE_SHIPMENT]],

  ["portal: invoices list", `select i.id, i.invoice_number, i.issue_date::text as issue_date,
                  i.due_date::text as due_date, i.currency, i.vat_rate,
                  i.subtotal::float8 as subtotal, i.vat_amount::float8 as vat_amount,
                  i.total::float8 as total, i.amount_paid::float8 as amount_paid,
                  ${EFFECTIVE_STATUS_SQL} as effective_status, i.created_at
           from freight_invoices i
           where i.tenant_id = $1 and i.deleted_at is null and ${INVOICE_VISIBLE_SQL}
           order by i.created_at desc
           limit 200`,
    [FAKE_TENANT, FAKE_USER]],

  ["portal: invoice detail", `select i.id, i.invoice_number, i.issue_date::text as issue_date,
                  i.due_date::text as due_date, i.currency, i.vat_rate,
                  i.subtotal::float8 as subtotal, i.vat_amount::float8 as vat_amount,
                  i.total::float8 as total, i.amount_paid::float8 as amount_paid,
                  i.payment_terms, i.payment_instructions, i.notes,
                  ${EFFECTIVE_STATUS_SQL} as effective_status, i.created_at
           from freight_invoices i
           where i.id = $3 and i.tenant_id = $1 and i.deleted_at is null and ${INVOICE_VISIBLE_SQL}`,
    [FAKE_TENANT, FAKE_USER, FAKE_INVOICE]],

  ["portal: invoice items", `select seq, description, quantity, unit, unit_price::float8 as unit_price, amount::float8 as amount
           from freight_invoice_items where invoice_id = $1 order by seq`,
    [FAKE_INVOICE]],

  ["portal: invoice payments", `select amount::float8 as amount, method, reference, paid_at::text as paid_at
           from freight_invoice_payments where invoice_id = $1 order by paid_at desc`,
    [FAKE_INVOICE]],

  ["portal: documents list", `select d.id, d.kind, d.file_name, d.mime_type, d.size_bytes, d.created_at,
                cs.file_number, d.uploaded_by
         from documents d
         join cargo_shipments cs on cs.id = d.entity_id
         where d.tenant_id = $1 and d.entity_type = 'shipment' and d.deleted_at is null
           and ${SHIPMENT_VISIBLE_SQL}
         order by d.created_at desc
         limit 200`,
    [FAKE_TENANT, FAKE_USER]],

  ["portal: upload visibility guard", `select cs.id from cargo_shipments cs
           where cs.id = $3 and cs.tenant_id = $1 and cs.deleted_at is null
             and ${SHIPMENT_VISIBLE_SQL}`,
    [FAKE_TENANT, FAKE_USER, FAKE_SHIPMENT]],

  ["portal: upload insert", `insert into documents (id, tenant_id, entity_type, entity_id, kind,
             file_name, mime_type, size_bytes, storage_path, uploaded_by, created_by, updated_by)
           values ($1,$2,'shipment',$3,'shipper_upload',$4,$5,$6,$7,$8,$8,$8)`,
    [FAKE_DOC, FAKE_TENANT, FAKE_SHIPMENT, "doc.pdf", "application/pdf", 1024, "path", FAKE_USER]],

  ["portal: signed-url doc fetch", `select d.id, d.storage_path, d.entity_id
           from documents d
           where d.id = $2 and d.tenant_id = $1 and d.deleted_at is null
             and d.entity_type = 'shipment'`,
    [FAKE_TENANT, FAKE_DOC]],

  ["portal: signed-url visibility", `select cs.id from cargo_shipments cs
           where cs.id = $3 and cs.tenant_id = $1 and cs.deleted_at is null
             and ${SHIPMENT_VISIBLE_SQL}`,
    [FAKE_TENANT, FAKE_USER, FAKE_SHIPMENT]]
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
  console.log("all shipper portal SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
