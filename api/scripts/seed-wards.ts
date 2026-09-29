/**
 * Seeds geo_wards from api/seeds/geo_tz_wards.txt (operator-collected, 31 regions).
 * v2: fixes the colon<-1 truthiness bug that skipped all ward lines; strips
 * urban/rural markers from the match base (they become the U/R discriminator);
 * handles merged councils (warns), duplicates (dedupes), missing districts.
 * Idempotent - safe to re-run.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const REGION_ALIASES: [string, string][] = [
  ["MJINI MAGHARIBI", "TZ-UMM"], ["URBAN WEST", "TZ-UMM"],
  ["KASKAZINI UNGUJA", "TZ-UKN"], ["NORTH UNGUJA", "TZ-UKN"],
  ["KUSINI UNGUJA", "TZ-UKS"], ["SOUTH UNGUJA", "TZ-UKS"],
  ["KASKAZINI PEMBA", "TZ-PKN"], ["NORTH PEMBA", "TZ-PKN"],
  ["KUSINI PEMBA", "TZ-PKS"], ["SOUTH PEMBA", "TZ-PKS"],
  ["DODOMA", "TZ-DOD"], ["ARUSHA", "TZ-ARU"], ["KILIMANJARO", "TZ-KIL"],
  ["TANGA", "TZ-TAN"], ["DAR ES SALAAM", "TZ-DAR"], ["MOROGORO", "TZ-MOR"],
  ["PWANI", "TZ-POA"], ["LINDI", "TZ-LIN"], ["MTWARA", "TZ-MTW"],
  ["RUVUMA", "TZ-RUV"], ["IRINGA", "TZ-IRI"], ["MBEYA", "TZ-MBE"],
  ["SINGIDA", "TZ-SIN"], ["TABORA", "TZ-TAB"], ["RUKWA", "TZ-RUK"],
  ["KIGOMA", "TZ-KIG"], ["SHINYANGA", "TZ-SHW"], ["KAGERA", "TZ-KAG"],
  ["MWANZA", "TZ-MWA"], ["MARA", "TZ-MAR"], ["MANYARA", "TZ-MAN"],
  ["NJOMBE", "TZ-NJI"], ["KATAVI", "TZ-KAT"], ["SIMIYU", "TZ-SIM"],
  ["GEITA", "TZ-GEI"], ["SONGWE", "TZ-SON"],
];
const PHRASE_FIXES: [RegExp, string][] = [
  [/missenyi/i, "Misenyi"],
  [/handani/i, "Handeni"],
  [/^dar es salaam city council/i, "Ilala"],
  [/^mjini district council/i, "Mjini"]
];
// Marker words are stripped from the match base - they live in markerOf().
const NOISE = new Set(["council", "councils", "municipal", "town", "city", "district",
  "dc", "mji", "mjini", "vijijini", "urban", "rural"]);

function normBase(name: string): string {
  const words = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter(w => w && !NOISE.has(w));
  return words.join(" ") || name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function markerOf(name: string): "U" | "R" | "" {
  const s = name.toLowerCase();
  if (/(mjini|urban|municipal|city|jiji|town)/.test(s)) return "U";
  if (/(vijijini|rural)/.test(s)) return "R";
  return "";
}
function cleanWard(w: string): string {
  return w.replace(/\./g, "").replace(/\s+/g, " ").trim();
}

interface Dist { id: number; name: string; base: string; marker: "U" | "R" | ""; }

function matchDistrict(cands: Dist[], phrase: string): { dist?: Dist; ambiguous?: boolean } {
  const base = normBase(phrase);
  const marker = markerOf(phrase);
  let hits = cands.filter(c => c.base === base && c.marker === marker);
  if (hits.length === 1) return { dist: hits[0] };
  hits = cands.filter(c => c.base === base);
  if (hits.length === 1) return { dist: hits[0] };
  if (hits.length > 1) {
    const preferR = /district/i.test(phrase) && !/(town|city|municipal|mjini|jiji|urban)/i.test(phrase);
    const pick = hits.find(h => h.marker === (preferR ? "R" : "U")) ?? hits[0];
    return { dist: pick, ambiguous: true };
  }
  const sub = cands.filter(c => c.base.length >= 5 && (base.includes(c.base) || c.base.includes(base)));
  if (sub.length === 1) return { dist: sub[0] };
  return {};
}

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL in api/.env");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const regions = new Map<string, number>();
  for (const r of (await client.query("select id, code from geo_regions")).rows) {
    regions.set(r.code, r.id);
  }
  const byRegion = new Map<number, Dist[]>();
  for (const d of (await client.query("select id, region_id, name_en from geo_districts")).rows) {
    const list = byRegion.get(d.region_id) ?? [];
    list.push({ id: d.id, name: d.name_en, base: normBase(d.name_en), marker: markerOf(d.name_en) });
    byRegion.set(d.region_id, list);
  }

  const text = readFileSync(join(process.cwd(), "seeds", "geo_tz_wards.txt"), "utf8");
  const lines = text.split(/\r?\n/);

  let regionId: number | null = null;
  let current: { id: number; name: string; seen: Set<string> } | null = null;
  const stats = { regions: new Set<string>(), matched: 0, created: 0, wards: 0, dupes: 0 };
  const merged: string[] = [];
  const created: string[] = [];
  const unmatched: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^=+$/.test(line)) continue;
    if (/^(TANZANIA|ZANZIBAR|UNGUJA ISLAND|PEMBA ISLAND)/i.test(line) && !/REGION/i.test(line)) continue;

    const colon = line.indexOf(":");
    const head = colon >= 0 ? line.slice(0, colon) : line;
    const tail = colon >= 0 ? line.slice(colon + 1) : "";
    const headUpper = head.toUpperCase();

    if (/\bREGION\b/.test(headUpper)) {
      for (const [alias, code] of REGION_ALIASES) {
        if (headUpper.includes(alias)) {
          regionId = regions.get(code) ?? null;
          if (regionId) { stats.regions.add(code); current = null; }
          break;
        }
      }
      if (regionId === null) unmatched.push(line);
      if (!/COUNCIL/i.test(headUpper)) continue;
    }

    if (/COUNCIL/i.test(headUpper) && regionId !== null) {
      let phrase = head.replace(/^\s*[\d.]+\s*/, "").trim();
      for (const [re, rep] of PHRASE_FIXES) phrase = phrase.replace(re, rep);
      const cut = phrase.match(/^(.*?council)/i);
      if (cut) phrase = cut[1].replace(/\s+/g, " ").trim();
      if (/(councils|\s\/\s|,\s)/i.test(head.replace(cut ? cut[1] : "", ""))) {
        merged.push(head.replace(/\s+/g, " ").slice(0, 70));
      }

      const cands = byRegion.get(regionId) ?? [];
      const m = matchDistrict(cands, phrase);
      let dist = m.dist;
      if (!dist) {
        const ins = await client.query(
          `insert into geo_districts (region_id, name_en, name_sw)
           values ($1,$2,$2)
           on conflict (region_id, name_en) do nothing returning id`, [regionId, phrase]);
        let id: number;
        if (ins.rowCount) {
          id = ins.rows[0].id;
        } else {
          const ex = await client.query(
            "select id, name_en from geo_districts where region_id=$1 and name_en=$2", [regionId, phrase]);
          id = ex.rows[0].id;
        }
        dist = { id, name: phrase, base: normBase(phrase), marker: markerOf(phrase) };
        cands.push(dist);
        created.push(phrase);
        stats.created++;
        console.log(`  + new district: ${phrase}`);
      } else {
        stats.matched++;
        if (m.ambiguous) merged.push(`${phrase} (urban/rural pair - attached to ${dist.name})`);
      }
      current = { id: dist.id, name: dist.name, seen: new Set() };
    }

    // THE FIX: colon === -1 means "no colon on this line" -> it is a ward list.
    // (The old `!colon` was false for -1, silently skipping every ward line.)
    const wardText = /COUNCIL/i.test(headUpper) && colon >= 0 ? tail : (colon < 0 ? line : "");
    if (current && wardText.trim()) {
      for (const w of wardText.split(",")) {
        const name = cleanWard(w);
        if (!name || current.seen.has(name.toLowerCase())) { if (name) stats.dupes++; continue; }
        current.seen.add(name.toLowerCase());
        const ins = await client.query(
          "insert into geo_wards (district_id, name) values ($1,$2) on conflict do nothing returning id",
          [current.id, name]);
        if (ins.rowCount) stats.wards++; else stats.dupes++;
      }
    }
  }

  console.log("==============================================");
  console.log(` regions matched:      ${stats.regions.size}`);
  console.log(` districts matched:    ${stats.matched}`);
  console.log(` districts created:    ${stats.created}  ${created.join(" | ")}`);
  console.log(` wards inserted:       ${stats.wards}`);
  console.log(` duplicates skipped:   ${stats.dupes}`);
  if (merged.length) {
    console.log(`\n MERGED / AMBIGUOUS SECTIONS (wards attached to first match - review later):`);
    merged.forEach(m => console.log(`   ! ${m}`));
  }
  if (unmatched.length) {
    console.log(`\n UNMATCHED REGION HEADERS:`);
    unmatched.forEach(m => console.log(`   ? ${m}`));
  }
  console.log("==============================================");
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });