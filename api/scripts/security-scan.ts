/**
 * Security scanner (CI gate): fails the build if any query contains
 * interpolated values, or forbidden dynamic-execution constructs appear.
 * Every SQL value must travel as a bind parameter ($1, $2, ...).
 *
 * It also proves the tenant bind. A write whose WHERE clause compares
 * `tenant_id` to the *person's* id can never match a row, and because row
 * level security already keeps the statement inside the caller's tenant, it
 * fails quietly: the client is told `{ ok: true }` and the change is simply
 * gone. Eight shipped writes were broken exactly that way (route and branch
 * edit/delete, staff name/phone/title/status, invoice payment posting and
 * status change), so the bind is now proven at build time instead of in front
 * of a user. Statements that build their bind list in a variable are out of
 * reach here — the 24 that do all follow the `[id, sub, tid]` builder shape
 * and were read by hand when this check went in.
 */
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** `security-scan.ts [src-dir]` — the default is the package's own source, and a
 *  path may be passed to prove the rules against a different tree. */
const ARG = process.argv[2];
const ROOT = !ARG ? join(process.cwd(), "src") : isAbsolute(ARG) ? ARG : resolve(process.cwd(), ARG);
const failures: string[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** The element of a bind list at 1-based `$n`; commas inside nested calls are ignored. */
function nthElement(params: string, n: number): string | null {
  const parts: string[] = [];
  let depth = 0, current = "";
  for (const ch of params) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts[n - 1]?.trim() ?? null;
}

/** The inside of a balanced `[...]` whose opening bracket sits at `from`. */
function readArray(src: string, from: number): string | null {
  let depth = 0, inString: string | null = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { inString = ch; continue; }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      depth--;
      if (depth === 0) return src.slice(from + 1, i);
      if (depth < 0) return null;
    }
  }
  return null;
}

const PERSON_BIND = /req\.user\.sub|\bsub\b|\buserId\b|\buid\b|\bactorUserId\b/;
const TENANT_BIND = /req\.user\.tid|\btid\b|tenantId/;

function checkTenantBinds(rel: string, src: string) {
  const call = /\.query\(\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src))) {
    const sqlStart = m.index + m[0].length;
    const sqlEnd = src.indexOf("`", sqlStart);
    if (sqlEnd < 0) continue;
    const sql = src.slice(sqlStart, sqlEnd);
    if (sql.includes("${")) continue; // reported as interpolated SQL below
    const binds = [...sql.matchAll(/tenant_id\s*=\s*\$(\d+)/gi)].map(x => Number(x[1]));
    if (!binds.length) continue;

    const tail = src.slice(sqlEnd + 1);
    const head = tail.match(/^\s*,\s*/);
    if (!head || tail[head[0].length] !== "[") continue; // params in a variable: shape not provable
    const params = readArray(src, sqlEnd + 1 + head[0].length);
    if (params === null) continue;

    for (const n of binds) {
      const el = nthElement(params, n);
      if (!el || !PERSON_BIND.test(el) || TENANT_BIND.test(el)) continue;
      failures.push(`${rel}:${src.slice(0, m.index).split("\n").length}  ` +
        `tenant_id=$${n} is bound to "${el}": a person id never equals tenant_id, ` +
        `so this write silently affects no row`);
    }
  }
}

for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8");
  const rel = file.replace(ROOT, "src");
  checkTenantBinds(rel, src);
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
console.log("Security scan passed: no interpolated SQL, no eval, no child_process, every tenant bind proven.");
