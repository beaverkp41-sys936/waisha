import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL in api/.env");

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  await client.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())"
  );

  const dir = join(process.cwd(), "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const done = await client.query("select 1 from schema_migrations where name = $1", [file]);
    if (done.rowCount) { console.log("skip  ", file); continue; }

    const sql = readFileSync(join(dir, file), "utf8");
    console.log("apply ", file);
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  }

  // ALTER ROLE cannot take a bind parameter, so we inject an escaped literal.
  // The value is the operator's own APP_DB_PASSWORD from .env, never user input.
  const pw = process.env.APP_DB_PASSWORD;
  if (pw) {
    const safe = pw.replace(/'/g, "''");
    await client.query(`alter role app_runtime login password '${safe}'`);
    console.log("app_runtime password set");
  }

  await client.end();
  console.log("Migrations complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });