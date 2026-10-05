/**
 * SQL validation for users.routes.ts — plans every statement against the live
 * schema without executing writes (EXPLAIN only). Catches column/join/RLS
 * grant mistakes the unit tests can't see.
 * Run: npx tsx scripts/verify-users-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";

const listSql = `
  select u.id, u.full_name, u.email, u.status, u.user_type, u.job_title,
         u.last_login_at, u.created_at,
         coalesce((select json_agg(json_build_object('key', r.key, 'name', r.name)
                     order by r.name)
                   from user_roles ur join roles r on r.id = ur.role_id
                   where ur.user_id = u.id
                     and (ur.expires_at is null or ur.expires_at > now())),
                  '[]'::json) as roles
  from users u
  where u.tenant_id = $1 and u.deleted_at is null
    and u.user_type in ('director','staff')
  order by u.created_at`;

const permSql = `
  select 1 from user_roles ur
  join role_permissions rp on rp.role_id = ur.role_id
  where ur.user_id = $1 and rp.permission_key = $2
    and (ur.expires_at is null or ur.expires_at > now())
  limit 1`;

const checks: [string, string, unknown[]][] = [
  ["users list", listSql, [FAKE_TENANT]],
  ["permission check", permSql, [FAKE_USER, "users.view"]],
  ["roles list", `select key, name from roles
     where tenant_id is null and is_system and key = any($1::text[]) order by name`,
    [["director", "dispatcher"]]],
  ["in-tenant email dup", `select id from users where tenant_id = $1
     and email_normalized_search = $2 and deleted_at is null`,
    [FAKE_TENANT, "x"]],
  ["seat count", `select count(*)::int as n from users
     where tenant_id = $1 and deleted_at is null and user_type in ('director','staff')`,
    [FAKE_TENANT]],
  ["tenant name", "select name from tenants where id = $1", [FAKE_TENANT]],
  ["role keys exist", `select key from roles where tenant_id is null and key = any($1) and is_system`,
    [["dispatcher"]]],
  ["invite: user insert", `insert into users (id, tenant_id, user_type, email,
     email_normalized_search, phone_encrypted, phone_search, password_hash, status, full_name)
   values ($1,$2,'staff',$3,$4,$5,$6,$7,'pending_verification',$8)`,
    [FAKE_USER, FAKE_TENANT, "a@b.tz", "x", null, null, "h", "A B"]],
  ["invite: role grants", `insert into user_roles (user_id, role_id, granted_by)
   select $1, id, $3 from roles where tenant_id is null and key = any($2)`,
    [FAKE_USER, ["dispatcher"], FAKE_USER]],
  ["invite: reset token", `insert into password_resets (id, user_id, tenant_id, token_hash, expires_at)
   values ($1,$2,$3,$4, now() + interval '7 days')`,
    [FAKE_USER, FAKE_USER, FAKE_TENANT, "x"]],
  ["edit: name", `update users set full_name = $2, updated_by = $3, updated_at = now()
   where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_USER, "A B", FAKE_USER]],
  ["edit: current roles", `select r.key from user_roles ur join roles r on r.id = ur.role_id
   where ur.user_id = $1 and (ur.expires_at is null or ur.expires_at > now()) order by r.name`,
    [FAKE_USER]],
  ["edit: clear roles", "delete from user_roles where user_id = $1", [FAKE_USER]],
  ["status: set", `update users set status = $2, updated_by = $3, updated_at = now()
   where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_USER, "deactivated", FAKE_USER]],
  ["status: revoke sessions", `update sessions set revoked_at = now(), revoked_reason = 'deactivated'
   where user_id = $1 and revoked_at is null`, [FAKE_USER]],
  ["reinvite: burn tokens", `update password_resets set used_at = now()
   where user_id = $1 and used_at is null`, [FAKE_USER]],
  ["reset: promote invitee", `update users set password_hash=$2, status='active' where id=$1`,
    [FAKE_USER, "h"]],
  ["edit: phone", `update users set phone_encrypted = $2, phone_search = $3,
     updated_by = $4, updated_at = now()
   where id = $1 and tenant_id = $4 and deleted_at is null`,
    [FAKE_USER, null, null, FAKE_USER]],
  ["edit: job title", `update users set job_title = $2, updated_by = $3, updated_at = now()
   where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_USER, "Dispatcher", FAKE_USER]],
  ["fleet: dims insert", `insert into vessels (id, tenant_id, name, vessel_type, plate_number,
     gross_weight_kg, length_m, width_m, height_m, fuel_type, status)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'diesel','standby')`,
    [FAKE_USER, FAKE_TENANT, "V", "truck_head", "T 1 ABC", 1, 2, 3, 4]],
  ["fleet: dims update", `update vessels set gross_weight_kg = $2, length_m = $3,
     width_m = $4, height_m = $5, updated_by = $6, updated_at = now()
   where id = $1 and tenant_id = $7 and deleted_at is null`,
    [FAKE_USER, 1, 2, 3, 4, FAKE_USER, FAKE_TENANT]],
  ["vessels: active trip ref", `select v.*, (select t.reference from trips t
     where t.vessel_id = v.id and t.status in ('planned','in_transit')
       and t.deleted_at is null order by t.created_at desc limit 1) as active_trip_reference
   from vessels v where v.tenant_id = $1 limit 1`, [FAKE_TENANT]]
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
  console.log("all users SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
