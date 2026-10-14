/**
 * SQL validation for messages.routes.ts + the message branch of documents.routes.ts —
 * plans every statement against the live schema without executing writes (EXPLAIN only).
 * Run: npx tsx scripts/verify-messages-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_SHIPMENT = "22222222-2222-7222-8222-222222222222";
const FAKE_MESSAGE = "33333333-3333-7333-8333-333333333333";

const checks: [string, string, unknown[]][] = [
  ["permission gate", `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "messages.view"]],

  ["threads: general", `select
       (select jsonb_build_object('body', m.body, 'senderName', u.full_name, 'createdAt', m.created_at)
        from messages m left join users u on u.id = m.created_by
        where m.tenant_id = $1 and m.shipment_id is null and m.deleted_at is null
        order by m.created_at desc limit 1) as last_message,
       (select count(*)::int from messages x
        where x.tenant_id = $1 and x.shipment_id is null and x.deleted_at is null
          and x.created_at > coalesce(
            (select r.last_read_at from message_reads r
             where r.tenant_id = $1 and r.user_id = $2 and r.shipment_id is null),
            'epoch'::timestamptz)) as unread`,
    [FAKE_TENANT, FAKE_USER]],

  ["threads: cargo files", `select s.id as shipment_id, s.file_number, s.consignee_name, s.status, s.stage,
              lm.last_message,
              coalesce(un.cnt, 0)::int as unread
       from cargo_shipments s
       left join lateral (
         select jsonb_build_object('body', m.body, 'senderName', u.full_name, 'createdAt', m.created_at) as last_message,
                m.created_at as sort_at
         from messages m left join users u on u.id = m.created_by
         where m.tenant_id = s.tenant_id and m.shipment_id = s.id and m.deleted_at is null
         order by m.created_at desc limit 1
       ) lm on true
       left join lateral (
         select count(*)::int as cnt from messages m
         where m.tenant_id = s.tenant_id and m.shipment_id = s.id and m.deleted_at is null
           and m.created_at > coalesce(
             (select r.last_read_at from message_reads r
              where r.tenant_id = s.tenant_id and r.user_id = $2 and r.shipment_id = s.id),
             'epoch'::timestamptz)
       ) un on true
       where s.tenant_id = $1 and s.deleted_at is null
       order by lm.sort_at desc nulls last, s.created_at desc
       limit 200`,
    [FAKE_TENANT, FAKE_USER]],

  ["conversation header", `select id, file_number, consignee_name, status, stage from cargo_shipments
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_SHIPMENT, FAKE_TENANT]],

  ["conversation: messages + attachments", `select m.id, m.body, m.created_at, m.created_by, u.full_name as sender_name,
              (select jsonb_agg(jsonb_build_object('id', d.id, 'fileName', d.file_name,
                 'mimeType', d.mime_type, 'sizeBytes', d.size_bytes) order by d.created_at)
               from documents d
               where d.tenant_id = m.tenant_id and d.entity_type = 'message'
                 and d.entity_id = m.id and d.deleted_at is null) as attachments
       from messages m left join users u on u.id = m.created_by
       where m.tenant_id = $1 and m.deleted_at is null
         and (($2::uuid is null and m.shipment_id is null) or m.shipment_id = $2)
       order by m.created_at desc
       limit 300`,
    [FAKE_TENANT, null]],

  ["read watermark: general", `insert into message_reads (tenant_id, user_id, shipment_id, last_read_at)
     values ($1,$2,null,now())
     on conflict (tenant_id, user_id) where shipment_id is null
     do update set last_read_at = now()`,
    [FAKE_TENANT, FAKE_USER]],

  ["read watermark: shipment", `insert into message_reads (tenant_id, user_id, shipment_id, last_read_at)
     values ($1,$2,$3,now())
     on conflict (tenant_id, user_id, shipment_id) where shipment_id is not null
     do update set last_read_at = now()`,
    [FAKE_TENANT, FAKE_USER, FAKE_SHIPMENT]],

  ["post: insert", `insert into messages (id, tenant_id, shipment_id, body, created_by)
     values ($1,$2,$3,$4,$5)`,
    [FAKE_MESSAGE, FAKE_TENANT, null, "hello", FAKE_USER]],

  ["delete: fetch", `select created_by, shipment_id, deleted_at from messages
     where id = $1 and tenant_id = $2`,
    [FAKE_MESSAGE, FAKE_TENANT]],

  ["delete: soft", `update messages set deleted_at = now()
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_MESSAGE, FAKE_TENANT]],

  ["delete: attachments soft", `update documents set deleted_at = now()
     where tenant_id = $1 and entity_type = 'message' and entity_id = $2 and deleted_at is null
     returning storage_path`,
    [FAKE_TENANT, FAKE_MESSAGE]],

  ["documents: message guard", `select created_by, deleted_at from messages where id = $1 and tenant_id = $2`,
    [FAKE_MESSAGE, FAKE_TENANT]],

  ["documents: message cap", `select count(*)::int as n from documents
     where tenant_id = $1 and entity_type = 'message' and entity_id = $2 and deleted_at is null`,
    [FAKE_TENANT, FAKE_MESSAGE]],

  ["documents: message insert", `insert into documents (id, tenant_id, entity_type, entity_id, kind,
     file_name, mime_type, size_bytes, storage_path, uploaded_by, created_by, updated_by)
   values ($1,$2,'message',$3,'attachment','a.pdf','application/pdf',1,'p',$4,$4,$4)`,
    [FAKE_USER, FAKE_TENANT, FAKE_MESSAGE, FAKE_USER]],

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
              end as entity_label
       from documents d
       where d.tenant_id = $1 and d.deleted_at is null
         and ($2::text is null or d.entity_type = $2)
         and ($3::text is null or d.kind = $3)
       order by d.created_at desc
       limit 300`,
    [FAKE_TENANT, "message", "attachment"]]
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
  console.log("all messages SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
