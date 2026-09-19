import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL in api/.env");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(readFileSync(join(process.cwd(), "seeds", "seed.sql"), "utf8"));
  await client.end();
  console.log("Seed complete.");
}
main().catch((e) => { console.error(e); process.exit(1); });