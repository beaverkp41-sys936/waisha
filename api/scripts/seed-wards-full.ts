/**
 * v8 - Additive full-coverage seed from geo_tz_councils_full.txt.
 * Format: region headers between === rules, "- Council" headers, "* ward" lists.
 * INSERT-ONLY: never deletes; tops up the existing wards (idempotent, dedupes).
 * New districts are created when needed (using parenthetical hints / region map).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const NOISE = new Set(["council", "councils", "municipal", "town", "city", "district",
  "dc", "mjini", "vijijini", "urban", "rural"]);

function normBase(name: string): string {
  const words = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter(w => w && !NOISE.has(w));
  return words.join(" ") || name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function markerOf(name: string): "U" | "R" | "" {
  const s = name.toLowerCase();
  if (/(municipal|city|town|jiji|urban|mjini)/.test(s)) return "U";
  if (/(district|vijijini|rural)/.test(s)) return "R";
  return "";
}

const REGION_NAMES: Record<string, string> = {
  "dodoma": "TZ-DOD", "arusha": "TZ-ARU", "kilimanjaro": "TZ-KIL",
  "tanga": "TZ-TAN", "morogoro": "TZ-MOR", "pwani": "TZ-POA",
  "dar es salaam": "TZ-DAR", "lindi": "TZ-LIN", "mtwara": "TZ-MTW",
  "ruvuma": "TZ-RUV", "iringa": "TZ-IRI", "mbeya": "TZ-MBE",
  "singida": "TZ-SIN", "tabora": "TZ-TAB", "rukwa": "TZ-RUK",
  "kigoma": "TZ-KIG", "shinyanga": "TZ-SHW", "kagera": "TZ-KAG",
  "mwanza": "TZ-MWA", "mara": "TZ-MAR", "manyara": "TZ-MAN",
  "njombe": "TZ-NJI", "katavi": "TZ-KAT", "simiyu": "TZ-SIM",
  "geita": "TZ-GEI", "songwe": "TZ-SON",
  "mjini magharibi": "TZ-UMM", "urban west": "TZ-UMM",
  "kaskazini unguja": "TZ-UKN", "north unguja": "TZ-UKN",
  "kusini unguja": "TZ-UKS", "south unguja": "TZ-UKS",
  "kaskazini pemba": "TZ-PKN", "north pemba": "TZ-PKN",
  "kusini pemba": "TZ-PKS", "south pemba": "TZ-PKS"
};

interface Dist { id: number; regionId: number; name: string; base: string; marker: "U" | "R" | ""; }

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL in api/.env");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const regionsByCode = new Map<string, number>();
  for (const r of (await client.query("select id, code from geo_regions")).rows) {
    regionsByCode.set(r.code, r.id);
  }
  const all: Dist[] = [];
  for (const d of (await client.query("select id, region_id, name_en from geo_districts")).rows) {
    all.push({ id: d.id, regionId: d.region_id, name: d.name_en, base: normBase(d.name_en), marker: markerOf(d.name_en) });
  }

  const text = readFileSync(join(process.cwd(), "seeds", "geo_tz_councils_full.txt"), "utf8");
  const lines = text.split(/\r?\n/);

  let regionCode: string | null = null;
  let regionId: number | null = null;
  let current: { id: number; name: string; seen: Set<string> } | null = null;
  const stats = { regions: new Set<string>(), councils: 0, matched: 0, created: 0, wards: 0, dupes: 0 };
  const created: string[] = [];
  const unmatched: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^=+$/.test(line)) continue;
    if (/^(TANZANIA MAINLAND|ZANZIBAR|UNGUJA ISLAND|PEMBA ISLAND)/i.test(line)) continue;

    // Region header: "<NAME> REGION" (between === rules)
    if (/\bREGION\b/i.test(line) && !/^-/.test(line)) {
      const namePart = line.replace(/\bREGION\b/i, "").replace(/^[\s\d.]+/, "").replace(/\s+/g, " ").trim().toLowerCase();
      regionCode = REGION_NAMES[namePart] ?? null;
      regionId = regionCode ? regionsByCode.get(regionCode) ?? null : null;
      if (regionId) { stats.regions.add(regionCode!); current = null; }
      else unmatched.push(line);
      continue;
    }

    // Council header: "- <Council name>"
    if (/^- (.+)$/.test(line) && regionId !== null) {
      const phrase = line.slice(2).replace(/\s+/g, " ").trim();
      const base = normBase(phrase);
      const marker = markerOf(phrase);
      const cands = all.filter(d =>
        d.base === base && d.regionId === regionId);
      const candsAny = all.filter(d => d.base === base);
      let dist: Dist | undefined =
        cands.find(c => c.marker === marker) ??
        cands.find(c => c.marker === "") ??
        candsAny.find(c => c.marker === marker) ??
        candsAny.find(c => c.marker === "");
      if (!dist) {
        const ins = await client.query(
          `insert into geo_districts (region_id, name_en, name_sw) values ($1,$2,$2)
           on conflict (region_id, name_en) do nothing returning id`, [regionId, phrase]);
        const id = ins.rowCount ? ins.rows[0].id
          : (await client.query("select id from geo_districts where region_id=$1 and name_en=$2", [regionId, phrase])).rows[0].id;
        dist = { id, regionId, name: phrase, base, marker };
        all.push(dist);
        created.push(phrase);
        stats.created++;
        console.log(`  + new district: ${phrase}`);
      } else {
        stats.matched++;
      }
      current = { id: dist.id, name: dist.name, seen: new Set() };
      continue;
    }

    // Ward line: "* <ward>"
    const ward = line.match(/^\*\s*(.+)$/);
    if (ward && current) {
      const name = ward[1].replace(/\s+/g, " ").trim();
      if (!name || current.seen.has(name.toLowerCase())) { if (name) stats.dupes++; continue; }
      current.seen.add(name.toLowerCase());
      const ins = await client.query(
        "insert into geo_wards (district_id, name) values ($1,$2) on conflict do nothing returning id",
        [current.id, name]);
      if (ins.rowCount) stats.wards++; else stats.dupes++;
    }
  }

  console.log("==============================================");
  console.log(` regions matched:      ${stats.regions.size}`);
  console.log(` councils matched:     ${stats.matched}`);
  console.log(` districts created:    ${stats.created}  ${created.join(" | ")}`);
  console.log(` NEW wards inserted:   ${stats.wards}`);
  console.log(` duplicates skipped:   ${stats.dupes}`);
  if (unmatched.length) {
    console.log(`\n UNMATCHED REGION HEADERS:`);
    unmatched.forEach(m => console.log(`   ? ${m}`));
  }
  console.log("==============================================");
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });