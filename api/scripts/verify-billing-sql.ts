/**
 * SQL validation for quotations.routes.ts — plans every statement against the
 * live schema without executing writes (EXPLAIN only), then checks the shape
 * migration 052 promised: RLS on each new table, grants that make it reachable,
 * the indexes the list screens need, and a seeded catalog that prints in the
 * three blocks the CFA bill is laid out in.
 * Run: npx tsx scripts/verify-billing-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_QUOTATION = "22222222-2222-7222-8222-222222222222";
const FAKE_ITEM = "33333333-3333-7333-8333-333333333333";
const FAKE_CATALOG = "44444444-4444-7444-8444-444444444444";
const FAKE_REF = "55555555-5555-7555-8555-555555555555";
const FAKE_DOC = "66666666-6666-7666-8666-666666666666";
const FAKE_SHIPMENT = "77777777-7777-7777-8777-777777777777";
const FAKE_INVOICE = "88888888-8888-7888-8888-888888888888";

const statements: [string, string, unknown[]][] = [
  ["gate: quotations.view", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "quotations.view"]],
  ["gate: quotations.convert", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "quotations.convert"]],
  ["gate: charge_catalog.manage", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "charge_catalog.manage"]],
  ["gate: billing_documents.upload", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "billing_documents.upload"]],

  ["catalog: tenant copy wins over the platform row", `
     select distinct on (c.code) c.id, c.code, c.label, c.section, c.basis, c.default_rate,
            c.rate_type, c.eac_exempt, c.sort, c.notes, c.tenant_id is not null as is_tenant_own
     from charge_catalog c
     where c.deleted_at is null and c.is_active
       and (c.tenant_id is null or c.tenant_id = $1)
     order by c.code, c.tenant_id nulls last`,
    [FAKE_TENANT]],

  ["catalog: insert tenant code", `insert into charge_catalog (id, tenant_id, code, label, section, basis,
       default_rate, rate_type, eac_exempt, sort, notes, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [FAKE_CATALOG, FAKE_TENANT, "REEFER_PLUG", "Reefer plug electricity", "port", "per_day",
     45000, "amount", false, 170, null, FAKE_USER]],

  ["catalog: update guard (own rows only)", `select code, label, tenant_id from charge_catalog
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_CATALOG, FAKE_TENANT]],

  ["catalog: update", `update charge_catalog set label = $4, default_rate = $5, updated_by = $2, updated_at = now()
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_CATALOG, FAKE_USER, FAKE_TENANT, "Reefer plug — reefer point", 47500]],

  ["catalog: soft delete", `update charge_catalog set deleted_at = now(), updated_by = $2
     where id = $1 and tenant_id = $3 and deleted_at is null returning code`,
    [FAKE_CATALOG, FAKE_USER, FAKE_TENANT]],

  ["quotations: list with filters", `
     select q.id, q.quotation_number, q.kind, q.status, q.customer_name, q.customer_email,
            q.customer_tin, q.customer_address, q.shipment_id, q.vessel_name, q.voyage,
            q.bl_number, q.trade_type, q.currency, q.exchange_rate, q.vat_rate,
            q.issue_date::text as issue_date, q.valid_until::text as valid_until,
            q.statutory_total, q.port_total, q.transport_total, q.subtotal, q.vat_amount,
            q.total, q.payment_instructions, q.notes, q.converted_invoice_id,
            q.created_at, q.updated_at
     from quotations q
     where q.tenant_id = $1 and q.deleted_at is null
       and ($2::text is null or q.status = $2)
       and ($3::text is null or q.kind = $3)
       and ($4::text is null or q.customer_name ilike $4 or q.quotation_number ilike $4
            or q.bl_number ilike $4 or q.vessel_name ilike $4)
     order by q.created_at desc
     limit 300`,
    [FAKE_TENANT, "draft", "proforma", "%MSC%"]],

  ["quotations: kpis", `select count(*) filter (where status = 'draft')::int as drafts,
            count(*) filter (where status = 'issued')::int as awaiting,
            count(*) filter (where status = 'accepted')::int as accepted,
            coalesce(sum(total) filter (where status in ('issued','accepted')), 0)::float8 as open_value,
            count(*) filter (where valid_until is not null and valid_until < current_date
              and status = 'issued')::int as lapsed
     from quotations where tenant_id = $1 and deleted_at is null`,
    [FAKE_TENANT]],

  ["quotations: number sequence", `select coalesce(max(nullif(regexp_replace(quotation_number, '\\D', '', 'g'), '')::bigint), 0) + 1 as next
     from quotations where tenant_id = $1 and kind = $2 and deleted_at is null`,
    [FAKE_TENANT, "proforma"]],

  ["quotations: shipment guard", `select id from cargo_shipments
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_SHIPMENT, FAKE_TENANT]],

  ["quotations: payment defaults", `select pay_bank_name, pay_bank_account, pay_account_name, pay_mobile_money
     from company_profiles where tenant_id = $1`, [FAKE_TENANT]],

  ["quotations: insert", `insert into quotations (id, tenant_id, quotation_number, kind, status, customer_name,
       customer_phone_encrypted, customer_phone_search, customer_email, customer_tin,
       customer_address, shipment_id, vessel_name, voyage, bl_number, trade_type,
       currency, exchange_rate, vat_rate, issue_date, valid_until,
       statutory_total, port_total, transport_total, subtotal, vat_amount, total,
       payment_instructions, notes, created_by, updated_by)
     values ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
       $16,$17,$18, coalesce($19, current_date), $20,
       $21,$22,$23,$24,$25,$26,$27,$28,$29,$29)`,
    [FAKE_QUOTATION, FAKE_TENANT, "PF-0001", "proforma", "INDIANO PRODUCT LIMITED",
     Buffer.from("x"), "hash", "accounts@indiano.test", "188-698-778", "P O Box 123, Dar es Salaam",
     FAKE_SHIPMENT, "MSC SILVER II", "SILVER II / 26W", "TZDL261709619", "DOMESTIC_IMPORT",
     "TZS", 2648.68, 18, "2026-10-16", "2026-10-30",
     0, 1278149.67, 468816.36, 1746966.03, 266486.34, 1746966.03,
     "Bank: CRDB", null, FAKE_USER]],

  ["quotation items: insert", `insert into quotation_items (id, tenant_id, quotation_id, seq, section, catalog_code,
       description, basis, quantity, unit, unit_price, amount, tax_kind, tax_rate,
       tax_amount, total, source_document_id, verified, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [FAKE_ITEM, FAKE_TENANT, FAKE_QUOTATION, 1, "port", "WHARFAGE", "Wharfage", "cif",
     1, "TEU", 1083177.69, 1083177.69, "vat", 18, 194971.98, 1278149.67, FAKE_REF, true, null]],

  ["quotation detail: head", `
     select q.id, q.quotation_number, q.kind, q.status, q.customer_name, q.customer_email,
            q.customer_tin, q.customer_address, q.shipment_id, q.vessel_name, q.voyage,
            q.bl_number, q.trade_type, q.currency, q.exchange_rate, q.vat_rate,
            q.issue_date::text as issue_date, q.valid_until::text as valid_until,
            q.statutory_total, q.port_total, q.transport_total, q.subtotal, q.vat_amount,
            q.total, q.payment_instructions, q.notes, q.converted_invoice_id,
            q.created_at, q.updated_at
     from quotations q where q.id = $1 and q.tenant_id = $2 and q.deleted_at is null`,
    [FAKE_QUOTATION, FAKE_TENANT]],

  ["quotation detail: phone (never in the list)", `select customer_phone_encrypted from quotations
     where id = $1 and tenant_id = $2`, [FAKE_QUOTATION, FAKE_TENANT]],

  ["quotation detail: lines with provenance", `
     select qi.id, qi.seq, qi.section, qi.catalog_code, qi.description, qi.basis,
            qi.quantity, qi.unit, qi.unit_price, qi.amount, qi.tax_kind, qi.tax_rate,
            qi.tax_amount, qi.total, qi.source_document_id, qi.verified, qi.notes,
            bd.role as source_role, d.file_name as source_file
     from quotation_items qi
     left join billing_documents bd on bd.id = qi.source_document_id and bd.deleted_at is null
     left join documents d on d.id = bd.document_id and d.deleted_at is null
     where qi.quotation_id = $1 and qi.tenant_id = $2
     order by qi.seq`,
    [FAKE_QUOTATION, FAKE_TENANT]],

  ["reference files: list for a quotation", `
     select b.id, b.role, b.document_id, b.extract_status, b.extracted, b.extract_notes,
            b.created_at, d.file_name, d.mime_type, d.size_bytes
     from billing_documents b
     join documents d on d.id = b.document_id and d.deleted_at is null
     where b.quotation_id = $1 and b.tenant_id = $2 and b.deleted_at is null
     order by b.role, b.created_at desc`,
    [FAKE_QUOTATION, FAKE_TENANT]],

  ["letterhead", `select cp.company_name, cp.tin_display, cp.brela_number, cp.vat_number, cp.website,
          b.postal_address, b.street, b.email as branch_email,
          (select d.id from documents d
            where d.tenant_id = $1 and d.entity_type = 'tenant'
              and d.kind = 'logo' and d.deleted_at is null
            order by d.created_at desc limit 1) as logo_document_id
   from company_profiles cp
   left join branches b on b.tenant_id = cp.tenant_id and b.kind = 'hq' and b.deleted_at is null
   where cp.tenant_id = $1`,
    [FAKE_TENANT]],

  ["quotation: edit prev fetch", `select status, vat_rate, kind, quotation_number from quotations
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_QUOTATION, FAKE_TENANT]],

  ["quotation: edit update", `update quotations set updated_by = $2, updated_at = now(),
       customer_name = $4, vessel_name = $5, bl_number = $6, total = $7,
       statutory_total = $8, port_total = $9, transport_total = $10,
       subtotal = $11, vat_amount = $12, vat_rate = $13, exchange_rate = $14
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_QUOTATION, FAKE_USER, FAKE_TENANT, "INDIANO PRODUCT LIMITED", "MSC SILVER II",
     "TZDL261709619", 1746966.03, 0, 1278149.67, 468816.36, 1746966.03, 266486.34, 18, 2648.68]],

  ["quotation: lines replaced whole", `delete from quotation_items where quotation_id = $1 and tenant_id = $2`,
    [FAKE_QUOTATION, FAKE_TENANT]],

  ["quotation: status update", `update quotations set status = $4, updated_by = $2, updated_at = now()
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_QUOTATION, FAKE_USER, FAKE_TENANT, "issued"]],

  ["convert: source read", `select kind, status, customer_name, customer_phone_encrypted, customer_phone_search,
          customer_email, customer_tin, customer_address, shipment_id, currency,
          vat_rate, statutory_total, port_total, transport_total, subtotal, vat_amount,
          total, payment_instructions, notes
     from quotations where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_QUOTATION, FAKE_TENANT]],

  ["convert: source lines", `select section, catalog_code, description, basis, quantity, unit, unit_price,
          amount, tax_kind, tax_rate, tax_amount, total, notes
     from quotation_items where quotation_id = $1 and tenant_id = $2 order by seq`,
    [FAKE_QUOTATION, FAKE_TENANT]],

  ["convert: invoice number sequence", `select coalesce(max(nullif(regexp_replace(invoice_number, '\\D', '', 'g'), '')::bigint), 0) + 1 as next
     from freight_invoices where tenant_id = $1 and deleted_at is null`,
    [FAKE_TENANT]],

  ["convert: invoice insert", `insert into freight_invoices (id, tenant_id, invoice_number, customer_name,
       customer_phone_encrypted, customer_phone_search, customer_email, customer_tin,
       customer_address, issue_date, due_date, currency, vat_rate, subtotal, vat_amount,
       total, statutory_total, port_total, transport_total, related_trip_id,
       payment_instructions, notes, source_quotation_id, status, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9, current_date, null, $10,$11,$12,$13,$14,
       $15,$16,$17,null,$18,$19,$20,'draft',$21,$21)`,
    [FAKE_INVOICE, FAKE_TENANT, "INV-0001", "INDIANO PRODUCT LIMITED",
     Buffer.from("x"), "hash", "accounts@indiano.test", "188-698-778", "P O Box 123",
     "TZS", 18, 1746966.03, 266486.34, 1746966.03, 0, 1278149.67, 468816.36,
     "Bank: CRDB", null, FAKE_QUOTATION, FAKE_USER]],

  ["convert: invoice line with statutory block", `insert into freight_invoice_items (id, tenant_id, invoice_id, seq, description,
       quantity, unit, unit_price, amount, section, catalog_code, basis,
       tax_kind, tax_rate, tax_amount)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [FAKE_ITEM, FAKE_TENANT, FAKE_INVOICE, 1, "Wharfage", 1, "TEU", 1083177.69, 1083177.69,
     "port", "WHARFAGE", "cif", "vat", 18, 194971.98]],

  ["convert: quotation marked", `update quotations set status = 'converted', converted_invoice_id = $2,
       updated_by = $3, updated_at = now()
     where id = $1 and tenant_id = $4 and deleted_at is null`,
    [FAKE_QUOTATION, FAKE_INVOICE, FAKE_USER, FAKE_TENANT]],

  ["quotation: soft delete", `update quotations set deleted_at = now(), updated_by = $2
     where id = $1 and tenant_id = $3 and deleted_at is null
     returning quotation_number, status`,
    [FAKE_QUOTATION, FAKE_USER, FAKE_TENANT]],

  ["quotation: delete cascades vault", `update documents set deleted_at = now()
     where tenant_id = $1 and entity_type = 'quotation' and entity_id = $2 and deleted_at is null`,
    [FAKE_TENANT, FAKE_QUOTATION]],

  ["quotation: delete cascades reference rows", `update billing_documents set deleted_at = now(), updated_by = $2
     where quotation_id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_QUOTATION, FAKE_USER, FAKE_TENANT]],

  ["reference: attach guard (draft only)", `select id, status from quotations
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_QUOTATION, FAKE_TENANT]],

  ["reference: document must belong to this quotation", `select id, file_name, mime_type, storage_path, entity_type, entity_id
     from documents
     where id = $1 and tenant_id = $2 and entity_type = 'quotation' and entity_id = $3
       and deleted_at is null`,
    [FAKE_DOC, FAKE_TENANT, FAKE_QUOTATION]],

  ["reference: role slot free", `select id from billing_documents
     where quotation_id = $1 and tenant_id = $2 and role = $3 and deleted_at is null`,
    [FAKE_QUOTATION, FAKE_TENANT, "primary"]],

  ["reference: insert with extraction", `insert into billing_documents (id, tenant_id, quotation_id, role, document_id,
       extract_status, extracted, extract_notes, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [FAKE_REF, FAKE_TENANT, FAKE_QUOTATION, "primary", FAKE_DOC, "extracted",
     JSON.stringify({ header: { document_no: "DAR2026" }, lines: [], unparsed: [], notes: "x" }),
     "3 charge rows read.", FAKE_USER]],

  ["reference: detach", `update billing_documents set deleted_at = now(), updated_by = $3
     where id = $1 and quotation_id = $2 and tenant_id = $4 and deleted_at is null returning role`,
    [FAKE_REF, FAKE_QUOTATION, FAKE_USER, FAKE_TENANT]],

  ["reference: lines lose their provenance", `update quotation_items set source_document_id = null, verified = false
     where source_document_id = $1 and tenant_id = $2`,
    [FAKE_REF, FAKE_TENANT]],

  ["suggest: read stored extractions", `select role, extract_status, extracted from billing_documents
     where quotation_id = $1 and tenant_id = $2 and deleted_at is null
     order by created_at desc`,
    [FAKE_QUOTATION, FAKE_TENANT]],

  // Statements the existing billing screens still depend on after 052.
  ["invoices: existing list still plans", `select i.id, i.invoice_number, i.customer_name, i.total, i.status
     from freight_invoices i where i.tenant_id = $1 and i.deleted_at is null
     order by i.created_at desc`,
    [FAKE_TENANT]],

  ["invoices: create still plans (no section columns required)", `insert into freight_invoice_items
       (id, tenant_id, invoice_id, seq, description, quantity, unit, unit_price, amount)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [FAKE_ITEM, FAKE_TENANT, FAKE_INVOICE, 1, "Cartage to warehouse", 1, "trip", 250000, 250000]]
];

const shapeChecks: [string, string, (rows: any[]) => boolean, string?][] = [
  ["quotations RLS on", `select relrowsecurity from pg_class where relname = 'quotations'`,
    (r) => r[0]?.relrowsecurity === true],
  ["quotation_items RLS on", `select relrowsecurity from pg_class where relname = 'quotation_items'`,
    (r) => r[0]?.relrowsecurity === true],
  ["billing_documents RLS on", `select relrowsecurity from pg_class where relname = 'billing_documents'`,
    (r) => r[0]?.relrowsecurity === true],
  ["charge_catalog RLS on", `select relrowsecurity from pg_class where relname = 'charge_catalog'`,
    (r) => r[0]?.relrowsecurity === true],
  ["charge_catalog has no tenant-bypassing write policy", `
     select cmd from pg_policies where tablename = 'charge_catalog' and permissive = 'PERMISSIVE'
       and cmd <> 'SELECT' and qual like '%tenant_id = nullif%'`,
    (r) => r.every((x: any) => String(x.qual).includes("tenant_id = nullif"))],
  ["every new table is granted to app_runtime", `
     select table_name from information_schema.tables
     where table_schema = 'public'
       and table_name in ('charge_catalog','quotations','quotation_items','billing_documents')
       and not exists (
         select 1 from information_schema.role_table_grants g
         where g.table_name = information_schema.tables.table_name
           and g.grantee = 'app_runtime' and g.privilege_type = 'SELECT')`,
    (r) => r.length === 0],
  ["catalog seeded in three sections", `
     select section, count(*)::int as n from charge_catalog
     where tenant_id is null and deleted_at is null group by section order by section`,
    (r) => r.length === 3 && r.every((x: any) => x.n > 0)],
  ["catalog carries the statutory charges the bill must print", `
     select code from charge_catalog where tenant_id is null and deleted_at is null
       and code in ('IMPORT_DUTY','EXCISE_DUTY','IDL','RDL','VAT_IMPORT','CPF_IDF',
                    'PORT_CLEARANCE','WHARFAGE','GREEN_PORT','PORT_INFRA_DEV','VERIFY_SCAN',
                    'AGENCY_CF','FREIGHT','CARTAGE','STORAGE','DEMURRAGE','INCIDENTAL')`,
    (r) => r.length === 17],
  ["only cited rates carry a default", `
     select code, default_rate from charge_catalog
     where tenant_id is null and deleted_at is null and default_rate is not null`,
    (r) => r.length === 3 && r.every((x: any) => ["VAT_IMPORT", "RDL", "CPF_IDF"].includes(x.code))],
  ["a flat TZS rate fits the catalogue", `
     select numeric_precision, numeric_scale from information_schema.columns
     where table_name = 'charge_catalog' and column_name = 'default_rate'`,
    (r) => r[0]?.numeric_precision === 14 && r[0]?.numeric_scale === 4],
  ["the indexes the list screens use exist", `
     select indexname from pg_indexes where tablename in ('quotations','quotation_items','billing_documents','charge_catalog')
       and indexname in ('quotations_tenant_number_uq','idx_quotations_tenant_status',
                         'idx_quotation_items_line','billing_documents_role_uq',
                         'idx_billing_documents_quotation','charge_catalog_global_uq',
                         'charge_catalog_tenant_uq')`,
    (r) => r.length === 7],
  ["one primary and one secondary per quotation", `
     select count(*)::int as n from pg_indexes
     where indexname = 'billing_documents_role_uq'
       and indexdef ilike '%(quotation_id, role)%' and indexdef ilike '%deleted_at is null%'`,
    (r) => r[0]?.n === 1],
  ["invoice items gained the statutory block columns", `
     select column_name from information_schema.columns
     where table_name = 'freight_invoice_items'
       and column_name in ('section','catalog_code','basis','tax_kind','tax_rate','tax_amount')`,
    (r) => r.length === 6],
  ["invoices carry section totals and provenance", `
     select column_name from information_schema.columns
     where table_name = 'freight_invoices'
       and column_name in ('statutory_total','port_total','transport_total','exchange_rate','source_quotation_id')`,
    (r) => r.length === 5],
  ["the vault accepts quotation documents", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conname = 'documents_entity_type_check'`,
    (r) => String(r[0]?.def).includes("'quotation'")],
  ["the vault labels a generated proforma", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conname = 'documents_kind_check'`,
    (r) => String(r[0]?.def).includes("'proforma'")],
  ["billing permissions seeded", `
     select count(*)::int as n from permissions
     where key like 'quotations.%' or key like 'charge_catalog.%' or key like 'billing_documents.%'`,
    (r) => r[0]?.n === 11],
  ["director holds every billing permission", `
     select count(*)::int as n from role_permissions rp
     join roles r on r.id = rp.role_id
     where r.key = 'director' and r.tenant_id is null
       and (rp.permission_key like 'quotations.%' or rp.permission_key like 'charge_catalog.%'
            or rp.permission_key like 'billing_documents.%')`,
    (r) => r[0]?.n === 11],
  ["auditor holds views only", `
     select count(*) filter (where permission_key not like '%.view'
       and permission_key <> 'quotations.export')::int as writes,
       count(*)::int as n
     from role_permissions rp join roles r on r.id = rp.role_id
     where r.key = 'auditor' and r.tenant_id is null
       and (rp.permission_key like 'quotations.%' or rp.permission_key like 'charge_catalog.%'
            or rp.permission_key like 'billing_documents.%')`,
    (r) => r[0]?.n === 4 && r[0]?.writes === 0]
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

  for (const [label, sql, ok, _] of shapeChecks) {
    try {
      const { rows } = await pool.query(sql);
      const pass = ok(rows);
      console.log(pass ? "ok   " : "FAIL ", label, pass ? "" : `-> ${JSON.stringify(rows).slice(0, 200)}`);
      if (!pass) failed++;
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  await pool.end();
  if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log(`billing SQL and 052 shape valid (${statements.length} statements, ${shapeChecks.length} shape checks)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
