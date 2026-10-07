/**
 * SQL validation for invoices.routes.ts — plans every statement against the
 * live schema without executing writes (EXPLAIN only).
 * Run: npx tsx scripts/verify-invoices-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_ID = "11111111-1111-7111-8111-111111111111";

const EFFECTIVE = `case
  when i.status = 'cancelled' then 'cancelled'
  when i.status = 'draft' then 'draft'
  when i.amount_paid >= i.total and i.total > 0 then 'paid'
  when i.amount_paid > 0 then 'partial'
  when i.due_date is not null and i.due_date < current_date then 'overdue'
  else 'sent'
end`;

const checks: [string, string, unknown[]][] = [
  ["permission gate", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_ID, "invoices.view"]],
  ["register list", `select i.id, i.invoice_number, i.customer_name, i.issue_date,
      i.due_date, i.total, i.amount_paid, i.status, ${EFFECTIVE} as effective_status
     from freight_invoices i
     where i.tenant_id = $1 and i.deleted_at is null order by i.created_at desc`,
    [FAKE_TENANT]],
  ["kpis", `select coalesce(sum(total), 0)::float8 as invoiced,
      coalesce(sum(amount_paid), 0)::float8 as received,
      coalesce(sum(case when status <> 'cancelled' then total - amount_paid else 0 end), 0)::float8 as outstanding,
      count(*) filter (where status <> 'cancelled' and amount_paid < total
        and due_date is not null and due_date < current_date)::int as overdue
     from freight_invoices where tenant_id = $1 and deleted_at is null`,
    [FAKE_TENANT]],
  ["number sequence", `select coalesce(max(nullif(regexp_replace(invoice_number, '\\D', '', 'g'), '')::bigint), 0) + 1 as next
     from freight_invoices where tenant_id = $1 and deleted_at is null`,
    [FAKE_TENANT]],
  ["create invoice", `insert into freight_invoices (id, tenant_id, invoice_number, customer_name,
     customer_phone_encrypted, customer_phone_search, customer_email, customer_tin,
     customer_address, issue_date, due_date, payment_terms, vat_rate, subtotal,
     vat_amount, total, related_trip_id, notes, status, created_by, updated_by)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10, current_date), $11,$12,$13,$14,$15,$16,$17,$18,'draft',$19,$19)`,
    [FAKE_ID, FAKE_TENANT, "INV-0001", "C", null, null, null, null, null, null, null, null, 18, 0, 0, 0, null, null, FAKE_ID]],
  ["create item", `insert into freight_invoice_items (id, tenant_id, invoice_id, seq, description, quantity, unit_price, amount)
   values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [FAKE_ID, FAKE_TENANT, FAKE_ID, 1, "Freight", 1, 0, 0]],
  ["detail", `select i.*, ${EFFECTIVE} as effective_status from freight_invoices i
     where i.id = $1 and i.tenant_id = $2 and i.deleted_at is null`,
    [FAKE_ID, FAKE_TENANT]],
  ["detail items", `select id, seq, description, quantity, unit_price, amount
     from freight_invoice_items where invoice_id = $1 and tenant_id = $2 order by seq`,
    [FAKE_ID, FAKE_TENANT]],
  ["detail payments", `select id, amount, method, reference, paid_at, notes, created_at
     from freight_invoice_payments where invoice_id = $1 and tenant_id = $2 order by paid_at, created_at`,
    [FAKE_ID, FAKE_TENANT]],
  ["letterhead", `select cp.company_name, cp.tin_display, cp.brela_number, cp.vat_number, cp.website,
      b.postal_address, b.street, b.email as branch_email,
      (select d.id from documents d where d.tenant_id = $1 and d.entity_type = 'tenant'
        and d.kind = 'logo' and d.deleted_at is null order by d.created_at desc limit 1) as logo_document_id
     from company_profiles cp
     left join branches b on b.tenant_id = cp.tenant_id and b.kind = 'hq' and b.deleted_at is null
     where cp.tenant_id = $1`,
    [FAKE_TENANT]],
  ["edit status", `update freight_invoices set status = $2, updated_by = $3, updated_at = now()
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_ID, "sent", FAKE_ID]],
  ["record payment", `insert into freight_invoice_payments (id, tenant_id, invoice_id, amount, method, reference, paid_at, notes, recorded_by)
   values ($1,$2,$3,$4,$5,$6, coalesce($7, current_date), $8, $9)`,
    [FAKE_ID, FAKE_TENANT, FAKE_ID, 1000, "cash", null, null, null, FAKE_ID]],
  ["add to amount_paid", `update freight_invoices set amount_paid = amount_paid + $2, updated_by = $3, updated_at = now()
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_ID, 1000, FAKE_ID]],
  ["replace items", `delete from freight_invoice_items where invoice_id = $1 and tenant_id = $2`,
    [FAKE_ID, FAKE_TENANT]],
  ["soft delete", `update freight_invoices set deleted_at = now(), updated_by = $2
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_ID, FAKE_ID, FAKE_TENANT]]
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
  console.log("all invoice SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
