/**
 * Security scanner (CI gate): fails the build if any query contains
 * interpolated values, or forbidden dynamic-execution constructs appear.
 * Every SQL value must travel as a bind parameter ($1, $2, ...).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src");
const failures: string[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8");
  const rel = file.replace(ROOT, "src");
  src.split("\n").forEach((line, i) => {
    // A template literal passed to .query( with ${ } inside -> injection risk
    if (/\.query\(\s*`[^`]*\$\{/.test(line)) {
      failures.push(`${rel}:${i + 1}  interpolated SQL: ${line.trim()}`);
    }
    if (/\beval\(|new Function\(/.test(line)) {
      failures.push(`${rel}:${i + 1}  dynamic eval: ${line.trim()}`);
    }
    if (/child_process/.test(line)) {
      failures.push(`${rel}:${i + 1}  child_process use: ${line.trim()}`);
    }
  });
}

if (failures.length) {
  console.error("SECURITY SCAN FAILED:");
  failures.forEach((f) => console.error("  " + f));
  process.exit(1);
}
console.log("Security scan passed: no interpolated SQL, no eval, no child_process.");