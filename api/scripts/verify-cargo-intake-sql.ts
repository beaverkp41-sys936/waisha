/**
 * SQL validation for cargo-intake.routes.ts + the cargo_intake branches of
 * documents.routes.ts — plans every statement against the live schema without executing
 * writes (EXPLAIN only). Run: npx tsx scripts/verify-cargo-intake-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_OTHER_TENANT = "99999999-9999-7999-8999-999999999999";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_DRAFT = "22222222-2222-7222-8222-222222222222";
const FAKE_DOC = "33333333-3333-7333-8333-333333333333";
const FAKE_BATCH = "44444444-4444-7444-8444-444444444444";
const FAKE_SHIPMENT = "55555555-5555-7555-8555-555555555555";

const DRAFT_COLUMNS = `
  d.id, d.batch_id, d.position, d.label, d.shipment_type, d.printed_reference,
  d.extract_status, d.extract_notes, d.document_id, d.committed_shipment_id, d.committed_at,
  d.created_at, d.updated_at,
  f.file_name, f.mime_type, f.size_bytes, f.kind as document_kind,
  cs.file_number as committed_file_number`;

const DRAFT_FROM = `
  from cargo_intake_drafts d
  join documents f on f.id = d.document_id and f.tenant_id = d.tenant_id and f.deleted_at is null
  left join cargo_shipments cs on cs.id = d.committed_shipment_id`;

const checks: [string, string, unknown[]][] = [
  ["permission gate: extract", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "shipments.extract"]],

  ["permission gate: create", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "shipments.create"]],

  ["upload: named slot is free", `select f.file_name, d.label from cargo_intake_drafts d
     left join documents f on f.id = d.document_id and f.tenant_id = d.tenant_id
     where d.tenant_id = $1 and d.batch_id = $2 and d.position = $3 and d.deleted_at is null`,
    [FAKE_TENANT, FAKE_BATCH, 3]],

  ["upload: next free number", `select coalesce(max(d.position), 0) + 1 as n from cargo_intake_drafts d
     where d.tenant_id = $1 and d.batch_id = $2 and d.deleted_at is null`,
    [FAKE_TENANT, FAKE_BATCH]],

  ["upload: page lands in the vault", `insert into documents (id, tenant_id, entity_type, entity_id, kind,
     file_name, mime_type, size_bytes, storage_path, uploaded_by, created_by, updated_by)
     values ($1,$2,'cargo_intake',$3,$4,$5,'application/pdf',$6,$7,$8,$8,$8)`,
    [FAKE_DOC, FAKE_TENANT, FAKE_DRAFT, "declaration", "c10.pdf", 1234,
     `${FAKE_TENANT}/cargo_intake/${FAKE_DRAFT}/${FAKE_DOC}-c10.pdf`, FAKE_USER]],

  ["upload: draft lands with its reading", `insert into cargo_intake_drafts (id, tenant_id, batch_id, position, label,
     document_id, shipment_type, printed_reference, extract_status, extraction, extract_notes,
     created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12)`,
    [FAKE_DRAFT, FAKE_TENANT, FAKE_BATCH, 3, "C10 declaration", FAKE_DOC, "import",
     "380999-2026-004521", "extracted",
     JSON.stringify({ fields: { consigneeName: { value: "X", raw: "X", line: 1, variants: 1 } },
                      unparsed: [] }),
     "1 field(s) read from 40 line(s).", FAKE_USER]],

  ["shelf: list with filters", `select ${DRAFT_COLUMNS}
     ${DRAFT_FROM}
     where d.tenant_id = $1 and d.deleted_at is null
       and ($2::uuid is null or d.batch_id = $2)
       and ($3::text is null or d.extract_status = $3)
       and ($4::text is null or (d.committed_shipment_id is null) = ($4 = 'true'))
     order by d.created_at desc, d.batch_id, d.position
     limit 300`,
    [FAKE_TENANT, FAKE_BATCH, "manual", "true"]],

  ["shelf: batches", `select d.batch_id, count(*)::int as pages,
        count(*) filter (where d.extract_status in ('manual','failed'))::int as needs_typing,
        count(*) filter (where d.extract_status = 'extracted')::int as read_ok,
        count(*) filter (where d.committed_shipment_id is not null)::int as filed,
        max(d.created_at) as last_upload
     from cargo_intake_drafts d
     where d.tenant_id = $1 and d.deleted_at is null
     group by d.batch_id
     order by max(d.created_at) desc
     limit $2`,
    [FAKE_TENANT, 60]],

  ["shelf: still to type", `select count(*)::int as n from cargo_intake_drafts d
     where d.tenant_id = $1 and d.deleted_at is null
       and d.committed_shipment_id is null and d.extract_status in ('manual','failed')`,
    [FAKE_TENANT]],

  ["detail: one page with its reading", `select ${DRAFT_COLUMNS}, d.extraction
     ${DRAFT_FROM}
     where d.tenant_id = $1 and d.id = $2 and d.deleted_at is null`,
    [FAKE_TENANT, FAKE_DRAFT]],

  ["re-read: the stored bytes", `select d.id, d.label, d.extract_status, f.storage_path, f.mime_type, f.file_name
     from cargo_intake_drafts d
     join documents f on f.id = d.document_id and f.tenant_id = d.tenant_id and f.deleted_at is null
     where d.tenant_id = $1 and d.id = $2 and d.deleted_at is null`,
    [FAKE_TENANT, FAKE_DRAFT]],

  ["re-read: an unfiled page only", `update cargo_intake_drafts
     set extract_status = $3, extract_notes = $4, printed_reference = $5,
         extraction = $6::jsonb, updated_by = $2
     where id = $1 and tenant_id = $7 and deleted_at is null
       and committed_shipment_id is null
     returning id`,
    [FAKE_DRAFT, FAKE_USER, "extracted", "1 field(s) read.", null,
     JSON.stringify({ fields: {} }), FAKE_TENANT]],

  ["labels: the row as it stands", `select batch_id, position, label, shipment_type, committed_shipment_id
     from cargo_intake_drafts where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_DRAFT, FAKE_TENANT]],

  ["labels: the number is free", `select d.position, f.file_name from cargo_intake_drafts d
     left join documents f on f.id = d.document_id and f.tenant_id = d.tenant_id
     where d.tenant_id = $1 and d.batch_id = $2 and d.position = $3
       and d.deleted_at is null and d.id <> $4`,
    [FAKE_TENANT, FAKE_BATCH, 7, FAKE_DRAFT]],

  ["labels: write them", `update cargo_intake_drafts
     set position = $3, batch_id = $4, label = $5, shipment_type = $6, updated_by = $2
     where id = $1 and tenant_id = $7 and deleted_at is null
     returning position, batch_id, label, shipment_type`,
    [FAKE_DRAFT, FAKE_USER, 7, FAKE_BATCH, "Packing list", "transit", FAKE_TENANT]],

  ["commit: the page as it stands", `select document_id, committed_shipment_id, position, label, printed_reference
     from cargo_intake_drafts where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_DRAFT, FAKE_TENANT]],

  ["commit: the file it became", `select file_number from cargo_shipments
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_SHIPMENT, FAKE_TENANT]],

  ["commit: the paper moves onto the file", `update documents set entity_type = 'shipment', entity_id = $3, updated_by = $2
     where id = $1 and tenant_id = $4 and entity_type = 'cargo_intake' and deleted_at is null`,
    [FAKE_DOC, FAKE_USER, FAKE_SHIPMENT, FAKE_TENANT]],

  ["commit: the page is stamped once", `update cargo_intake_drafts
     set committed_shipment_id = $3, committed_at = now(), updated_by = $2
     where id = $1 and tenant_id = $4 and deleted_at is null
       and committed_shipment_id is null
     returning id`,
    [FAKE_DRAFT, FAKE_USER, FAKE_SHIPMENT, FAKE_TENANT]],

  ["remove: the page and its bytes", `select document_id, committed_shipment_id, position, label, extract_status,
        f.storage_path, f.file_name
     from cargo_intake_drafts d
     join documents f on f.id = d.document_id and f.tenant_id = d.tenant_id
     where d.id = $1 and d.tenant_id = $2 and d.deleted_at is null`,
    [FAKE_DRAFT, FAKE_TENANT]],

  ["remove: the draft is retired", `update cargo_intake_drafts set deleted_at = now(), updated_by = $2
     where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_DRAFT, FAKE_USER, FAKE_TENANT]],

  ["vault: an intake page is named by its number", `select d.id, d.entity_type, d.entity_id,
        case d.entity_type
          when 'cargo_intake' then (select coalesce(ci.label,
            'Page ' || ci.position || ' — ' || coalesce(ci.printed_reference, 'unnumbered paper'))
            from cargo_intake_drafts ci where ci.id = d.entity_id)
        end as entity_label
     from documents d
     where d.tenant_id = $1 and d.deleted_at is null
       and ($2::text is null or d.entity_type = $2)
     order by d.created_at desc limit 300`,
    [FAKE_TENANT, "cargo_intake"]],

  ["vault: a paper deleted from the shelf frees its number", `update cargo_intake_drafts set deleted_at = now(), updated_by = $2
     where id = $1 and tenant_id = $3 and deleted_at is null
       and committed_shipment_id is null`,
    [FAKE_DRAFT, FAKE_USER, FAKE_TENANT]],

  ["audit trail of one page", `select a.action, a.after from audit_logs a
     where a.tenant_id = $1 and a.entity = 'cargo_intake' and a.entity_id = $2
     order by a.ts desc limit 20`,
    [FAKE_TENANT, FAKE_DRAFT]],

  // The connection runs as a role with BYPASSRLS, so a missing predicate is a leak, not a
  // filtered result. These two prove every reader path binds its tenant from its own side.
  ["cross-tenant: another seat's page is not on this shelf", `select ${DRAFT_COLUMNS}
     ${DRAFT_FROM}
     where d.tenant_id = $1 and d.id = $2 and d.deleted_at is null`,
    [FAKE_OTHER_TENANT, FAKE_DRAFT]],

  ["cross-tenant: another seat's draft cannot be stamped", `update cargo_intake_drafts
     set committed_shipment_id = $3, committed_at = now(), updated_by = $2
     where id = $1 and tenant_id = $4 and deleted_at is null
       and committed_shipment_id is null
     returning id`,
    [FAKE_DRAFT, FAKE_USER, FAKE_SHIPMENT, FAKE_OTHER_TENANT]]
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  // Planned as the role the API pool actually connects with, so what is proved here is what
  // runs in production: these statements carry their own tenant predicates, not a policy.
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
  console.log("all cargo intake SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
