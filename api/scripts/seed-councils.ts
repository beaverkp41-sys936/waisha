/**
 * v7 - Seeds geo_wards from api/seeds/geo_tz_councils.txt (authoritative).
 * FIXES vs v6: NOISE list now matches the ward parser (urban/rural/mjini/
 * vijijini stripped) so DB names "X (Urban)" normalize to base "x" and
 * MATCH headers instead of creating junk; markerOf treats "urban" as Urban;
 * PHRASE_FIXES restored (Missenyi->Misenyi, Handeni, Mjini). Council-type
 * word is the U/R discriminator. Idempotent.
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

const PHRASE_FIXES: [RegExp, string][] = [
  [/missenyi/i, "Misenyi"],
  [/handani/i, "Handeni"],
  [/^mjini district council/i, "Mjini"]
];

/** Name-differing alignments (header base -> our district name_en). */
const COUNCIL_FIXES: Record<string, string> = {
  "dar es salaam": "Ilala Municipal",   // Dar es Salaam City Council (Ilala)
  "mwanza": "Nyamagana (City)"          // Mwanza City Council (Nyamagana)
};
/** New councils (not in 013) -> region for creation. */
const REGION_HINTS: Record<string, string> = {
  "kibiti": "TZ-POA",
  "tarime town": "TZ-MAR",
  "handeni town": "TZ-TAN"
};
/** ALL 31 region names -> codes. Creation fallback. */
const REGION_NAMES: Record<string, string> = {
  "arusha": "TZ-ARU", "dar es salaam": "TZ-DAR", "dodoma": "TZ-DOD",
  "geita": "TZ-GEI", "iringa": "TZ-IRI", "kagera": "TZ-KAG",
  "katavi": "TZ-KAT", "kigoma": "TZ-KIG", "kilimanjaro": "TZ-KIL",
  "lindi": "TZ-LIN", "manyara": "TZ-MAN", "mara": "TZ-MAR",
  "mbeya": "TZ-MBE", "morogoro": "TZ-MOR", "mtwara": "TZ-MTW",
  "mwanza": "TZ-MWA", "njombe": "TZ-NJI", "pwani": "TZ-POA",
  "rukwa": "TZ-RUK", "ruvuma": "TZ-RUV", "shinyanga": "TZ-SHW",
  "simiyu": "TZ-SIM", "singida": "TZ-SIN", "songwe": "TZ-SON",
  "tabora": "TZ-TAB", "tanga": "TZ-TAN",
  "pemba north": "TZ-PKN", "pemba kaskazini": "TZ-PKN",
  "pemba south": "TZ-PKS", "pemba kusini": "TZ-PKS",
  "unguja north": "TZ-UKN", "unguja kaskazini": "TZ-UKN",
  "unguja south": "TZ-UKS", "unguja kusini": "TZ-UKS",
  "urban west": "TZ-UMM", "mjini magharibi": "TZ-UMM"
};
/** Parenthetical region names -> codes. */
const PAREN_REGIONS: Record<string, string> = {
  "dar es salaam": "TZ-DAR", "kagera": "TZ-KAG", "katavi": "TZ-KAT",
  "mara": "TZ-MAR", "kilimanjaro": "TZ-KIL", "nyamagana": "TZ-MWA"
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

  const text = readFileSync(join(process.cwd(), "seeds", "geo_tz_councils.txt"), "utf8");
  const lines = text.split(/\r?\n/);

  let current: { id: number; name: string; seen: Set<string> } | null = null;
  const stats = { councils: 0, matched: 0, created: 0, wards: 0, dupes: 0 };
  const created: string[] = [];
  const notes: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^-+$/.test(line) || /^=+$/.test(line)) continue;

    const head = line.match(/^\d+\.\s+(.+)$/);
    if (head) {
      const full = head[1].replace(/\s+/g, " ").trim();
      const paren = full.match(/\(([^)]+)\)\s*$/);
      let clean = full.replace(/\s*\([^)]*\)\s*$/, "").trim();
      for (const [re, rep] of PHRASE_FIXES) clean = clean.replace(re, rep);
      const base = normBase(clean);
      const marker = markerOf(clean);
      const hintRegion = paren ? PAREN_REGIONS[paren[1].trim().toLowerCase()] ?? null : null;

      let dist: Dist | undefined;

      if (COUNCIL_FIXES[base]) {
        const target = COUNCIL_FIXES[base];
        dist = all.find(d => normBase(target) === d.base);
      }

      if (!dist) {
        const hits = all.filter(d => d.base === base);
        const typed = hits.filter(h => h.marker === marker);
        if (typed.length === 1) dist = typed[0];
        else if (hits.length === 1) dist = hits[0];
        else if (typed.length > 1 || hits.length > 1) {
          dist = typed[0] ?? hits[0];
          notes.push(`${full} -> ${dist.name} (ambiguous base, type-picked)`);
        }
      }

      if (!dist) {
        const regionCode = hintRegion
          ?? REGION_HINTS[`${base} ${marker === "U" ? "town" : ""}`.trim()]
          ?? REGION_HINTS[base]
          ?? REGION_NAMES[base];
        const rid = regionCode ? regionsByCode.get(regionCode) : undefined;
        if (!rid) {
          console.log(`  ! no region for council: ${full}`);
          current = null;
          continue;
        }
        let nm = clean.split(/\s+/).filter(w => !/^(councils?|districts?)$/i.test(w)).join(" ");
        if (marker === "U" && !/(town|city|municipal|jiji|urban)/i.test(nm)) nm = `${nm} Town`;
        const ins = await client.query(
          `insert into geo_districts (region_id, name_en, name_sw) values ($1,$2,$2)
           on conflict (region_id, name_en) do nothing returning id`, [rid, nm]);
        const id = ins.rowCount ? ins.rows[0].id
          : (await client.query("select id from geo_districts where region_id=$1 and name_en=$2", [rid, nm])).rows[0].id;
        dist = { id, regionId: rid, name: nm, base: normBase(nm), marker };
        all.push(dist);
        created.push(nm);
        stats.created++;
        console.log(`  + new district: ${nm} (${regionCode})`);
      } else {
        stats.matched++;
      }

      stats.councils++;
      current = { id: dist.id, name: dist.name, seen: new Set() };
      continue;
    }

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
  console.log(` councils processed:   ${stats.councils}`);
  console.log(` matched to districts: ${stats.matched}`);
  console.log(` districts created:    ${stats.created}  ${created.join(" | ")}`);
  console.log(` wards inserted:       ${stats.wards}`);
  console.log(` duplicates skipped:   ${stats.dupes}`);
  if (notes.length) {
    console.log(`\n MATCHING NOTES:`);
    notes.forEach(m => console.log(`   ! ${m}`));
  }
  console.log("==============================================");
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });