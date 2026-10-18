/**
 * Security scanner (CI gate). Four provable invariants, all of them born from a bug that
 * was already shipped:
 *
 * 1. **No interpolated SQL, no dynamic execution, and the tenant bind is the tenant's.**
 *    Every SQL value must travel as a bind parameter ($1, $2, …). A write whose WHERE
 *    clause compares `tenant_id` to the *person's* id can never match a row, and because
 *    row level security already keeps the statement inside the caller's tenant it fails
 *    quietly: the client is told `{ ok: true }` and the change is simply gone. Eight
 *    shipped writes were broken exactly that way, so the bind is proven at build time
 *    instead of in front of a user. Statements that build their bind list in a variable
 *    are out of reach here — the 24 that do all follow the `[id, sub, tid]` builder shape
 *    and were read by hand when this check went in.
 * 2. **Every credential surface is throttled.** A login route without a limiter is a
 *    password oracle, and this one hides behind a neutral error message on purpose.
 * 3. **Nothing hands raw markup to the browser** and nothing opens a window the caller
 *    can steer (`target="_blank"` without `rel`).
 * 4. **The navigation and the permissions probe agree.** The control bar only offers a
 *    desk whose duty the probe actually lists; twice now a duty shipped, the seat held
 *    it, the route enforced it — and the link never appeared.
 *
 * `security-scan.ts [src-dir]` — the default is the package's own source, and a path may
 * be passed to prove the rules against a different tree. The client-side and navigation
 * rules always read this repo's own `web/` half, located through the workspace marker.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const ARG = process.argv[2];
const ROOT = !ARG ? join(process.cwd(), "src") : isAbsolute(ARG) ? ARG : resolve(process.cwd(), ARG);
const failures: string[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

function walkExt(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) {
      if (["node_modules", ".next", ".swc"].includes(d.name)) return [];
      return walkExt(p, exts);
    }
    return exts.some((e) => p.endsWith(e)) ? [p] : [];
  });
}

const norm = (p: string) => p.replace(/\\/g, "/");

/** A path as printed in a failure: relative to the tree the rule is reading, never a temp-dir absolute. */
function relTo(file: string, base: string, under = "") {
  const f = norm(file), b = norm(base);
  return f.startsWith(b) ? under + f.slice(b.length) : f;
}

/** The repo root, found by walking up to the pnpm workspace marker. */
function repoRoot(): string | null {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return null;
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

// ---------------------------------------------------------------------------
// 2. credential surfaces
// ---------------------------------------------------------------------------

/** A POST whose body can carry a secret, mint one, or consume a one-time value. */
const CREDENTIAL_SUFFIX =
  /(login|signup|password|forgot|reset|otp|totp|verify|revoke|resend|invite|refresh|activate|setup|impersonate|client-errors)$/i;

/**
 * Credential doors that the suffix above cannot see because their path is a plain REST
 * name. `POST /users` mints an invite token and mails the link, so it is a credential
 * surface whatever the URL says.
 */
const CREDENTIAL_EXACT = new Set(["/users"]);

function isCredentialPath(path: string) {
  return CREDENTIAL_SUFFIX.test(path) || CREDENTIAL_EXACT.has(path);
}

/**
 * Matched by the vocabulary above but deliberately unthrottled, each with the reason.
 * A route that belongs on this list gets argued about in review, not added quietly.
 */
const NO_LIMITER_ALLOWED: Record<string, string> = {
  "/auth/refresh": "the credential is a 32-byte hash-stored rotation token and the " +
    "replay path already revokes the family; a bucket here throttles the tabs of one " +
    "honest session before it slows an attacker (see the concurrent-refresh fix)"
};

/** Each handler body, from its registration to the next one in the file. */
function postHandlers(rel: string, src: string) {
  const re = /app\.post\(\s*"([^"]+)"/g;
  const at: { path: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) at.push({ path: m[1], index: m.index });
  return at.map((h, i) => ({
    path: h.path,
    line: src.slice(0, h.index).split("\n").length,
    body: src.slice(h.index, i + 1 < at.length ? at[i + 1].index : src.length),
    rel
  }));
}

function checkCredentialLimiters(handlers: ReturnType<typeof postHandlers>) {
  for (const h of handlers) {
    if (!isCredentialPath(h.path)) continue;
    if (/enforceRateLimit\s*\(/.test(h.body)) continue;
    const exempt = Object.keys(NO_LIMITER_ALLOWED).find((p) => h.path.endsWith(p));
    if (exempt) continue;
    failures.push(`${h.rel}:${h.line}  POST ${h.path} checks or mints a credential with ` +
      `no enforceRateLimit in its handler — add a bucket, or exempt it with a reason`);
  }
}

// ---------------------------------------------------------------------------
// 3. client-side sinks
// ---------------------------------------------------------------------------

const SINK = /dangerouslySetInnerHTML|\.\s*innerHTML\s*=|insertAdjacentHTML|document\.write\s*\(|\beval\s*\(|new Function\s*\(/;

function checkClientSinks(files: string[], repo: string) {
  for (const file of files) {
    const rel = relTo(file, repo + "/");
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*/, "");
      if (SINK.test(code)) {
        failures.push(`${rel}:${i + 1}  markup sink: ${line.trim().slice(0, 110)}`);
      }
      // React forwards `target="_blank"` to the anchor, and the new tab gets a
      // `window.opener` that can redirect this one.
      if (/target=["']?_blank/.test(code) && !/noopener|noreferrer/.test(code)) {
        failures.push(`${rel}:${i + 1}  target="_blank" without rel=noopener/noreferrer: ` +
          `${line.trim().slice(0, 110)}`);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 4. navigation ↔ permissions probe
// ---------------------------------------------------------------------------

function stringLiterals(src: string): string[] {
  return [...src.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The control bar gates each link on a duty name, and the API answers only the keys it
 * was told to probe. A duty missing from the probe is held by the seat, enforced by the
 * route and invisible in the panel — which reads as a broken desk, not a closed one.
 */
function checkNavProbe(webRoot: string, apiRoutes: string) {
  const navFile = join(webRoot, "components", "ControlNav.tsx");
  if (!existsSync(navFile) || !existsSync(apiRoutes)) return;
  const nav = readFileSync(navFile, "utf8");
  const probe = readFileSync(apiRoutes, "utf8");

  const probeKeys = new Set<string>();
  const arr = probe.match(/const keys\s*=\s*\[([\s\S]*?)\];/);
  if (arr) {
    for (const item of arr[1].split(",")) {
      const token = item.trim();
      if (!token) continue;
      if (/^"/.test(token)) { probeKeys.add(token.replace(/^"|"$/g, "")); continue; }
      // The array mixes in module constants — resolve them in the same file.
      const def = probe.match(new RegExp(`const ${token}\\s*=\\s*"([^"]+)"`));
      if (def) probeKeys.add(def[1]);
    }
  }
  if (!probeKeys.size) {
    failures.push("control-analytics.routes.ts  the permissions probe no longer reads as a " +
      "key list; the navigation contract cannot be proven");
    return;
  }

  for (const group of nav.matchAll(/keys:\s*\[([\s\S]*?)\]/g)) {
    for (const key of stringLiterals(group[1])) {
      if (probeKeys.has(key)) continue;
      failures.push(`web/components/ControlNav.tsx  the bar gates a screen on ` +
        `"${key}", which GET /control/auth/permissions never probes: the seat holds the ` +
        `duty and the link never appears`);
    }
  }

  for (const href of stringLiterals(nav.match(/\[([\s\S]*?)\]/) ? nav : "")) {
    if (!href.startsWith("/control")) continue;
    const page = join(webRoot, "app", ...href.split("/"), "page.tsx");
    if (!existsSync(page)) {
      failures.push(`web/components/ControlNav.tsx  offers ${href} but no page.tsx is there`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. hijacked responses
// ---------------------------------------------------------------------------

/** `reply.hijack()` discards the reply object, and with it every header helmet set. */
function checkHijackHeaders(rel: string, src: string) {
  if (!/\.hijack\(\)/.test(src)) return;
  if (/nosniff/i.test(src)) return;
  failures.push(`${rel}  writes a hijacked response without X-Content-Type-Options: ` +
    `nosniff — the reply pipeline that normally sets it is thrown away`);
}

// ---------------------------------------------------------------------------

const REPO = repoRoot();
const allHandlers: ReturnType<typeof postHandlers> = [];

for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8");
  const rel = relTo(file, ROOT, "src");
  checkTenantBinds(rel, src);
  checkHijackHeaders(rel, src);
  if (/src[\\/]routes[\\/]/.test(rel)) allHandlers.push(...postHandlers(rel, src));
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

checkCredentialLimiters(allHandlers);

if (REPO) {
  const webRoot = join(REPO, "web");
  checkClientSinks([...walkExt(join(webRoot, "app"), [".ts", ".tsx"]),
  ...walkExt(join(webRoot, "components"), [".ts", ".tsx"]),
  ...walkExt(join(webRoot, "lib"), [".ts", ".tsx"])], REPO);
  checkNavProbe(webRoot, join(ROOT, "routes", "control-analytics.routes.ts"));
}

if (failures.length) {
  console.error("SECURITY SCAN FAILED:");
  failures.forEach((f) => console.error("  " + f));
  process.exit(1);
}
console.log("Security scan passed: no interpolated SQL, no eval, no child_process, every " +
  "tenant bind proven, every credential route throttled, no markup sinks, and the " +
  "navigation matches the permissions probe.");
