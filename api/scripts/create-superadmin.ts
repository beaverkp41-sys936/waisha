/**
 * Bootstrap the first platform Super Admin (spec 8: no email reset without a
 * second admin, so initial creation is an operator-run script).
 * Prints a one-time temporary password. TOTP enrollment is forced on first login.
 *
 * Usage: pnpm --filter @waisha/api exec tsx scripts/create-superadmin.ts "email" "Full Name"
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { hashPassword } from "../src/security/argon2.js";
import { searchHash } from "../src/util/crypto.js";
import { uuidv7 } from "../src/util/uuid.js";

const PLATFORM_TENANT = "00000000-0000-4000-8000-000000000000";

async function main() {
  const [emailRaw, fullName] = process.argv.slice(2);
  const email = (emailRaw ?? "").trim().toLowerCase();
  if (!email || !fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName.trim()) {
    console.error('Usage: tsx scripts/create-superadmin.ts "email@domain" "Full Name"');
    process.exit(1);
  }

  // Temporary password: template guarantees the policy classes; random middle is unique.
  const tempPassword = `Ctrl!${randomBytes(8).toString("base64url")}A7`;

  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL in api/.env");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const dupe = await client.query(
    "select 1 from users where email_normalized_search = $1 limit 1", [searchHash(email)]);
  if (dupe.rowCount) {
    console.error("A user with this email already exists.");
    await client.end();
    process.exit(1);
  }

  const role = await client.query(
    "select id from roles where key = 'super_admin' and tenant_id is null limit 1");
  if (!role.rowCount) throw new Error("super_admin role missing - run migrations.");

  const userId = uuidv7();
  await client.query("begin");
  await client.query(
    `insert into users (id, tenant_id, user_type, email, email_normalized_search,
       password_hash, status, full_name)
     values ($1,$2,'platform',$3,$4,$5,'active',$6)`,
    [userId, PLATFORM_TENANT, email, searchHash(email),
     await hashPassword(tempPassword), fullName.trim()]);
  await client.query(
    "insert into user_roles (user_id, role_id) values ($1,$2)", [userId, role.rows[0].id]);
  await client.query(
    `insert into audit_logs (id, tenant_id, entity, entity_id, action, after)
     values ($1,$2,'users',$3,'platform.staff.created',$4::jsonb)`,
    [uuidv7(), PLATFORM_TENANT, userId, JSON.stringify({ email, role: "super_admin" })]);
  await client.query("commit");

  console.log("==============================================================");
  console.log(" Super Admin created:");
  console.log(`   email:     ${email}`);
  console.log(`   temporary: ${tempPassword}`);
  console.log(" SAVE THIS PASSWORD NOW - it is not shown again.");
  console.log(" TOTP enrollment will be forced at first login (Part 2B).");
  console.log("==============================================================");
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });