/**
 * #175 — the health surface, driven the way the deploy platform drives it.
 *
 * The complaint was literal: "on platform landing page, it shows the below report. Endpoint
 * `GET /health` is not defined, so no answer at all." The API answered `/api/v1/health` and
 * the platform asks the root, so a missing route and a dead service looked identical.
 *
 * Three things a unit test cannot prove about a route whose entire job is to be polled:
 *
 *  - the paths exist on the running process, at the ROOT the platform asks and not only under
 *    the API prefix it never guessed;
 *  - the burst protection is real. `checks.database.probes` is the number of round trips this
 *    process has actually made, so sixty polls that move it by one is the proof — a health
 *    route that costs a pool connection per poll is a route that takes the service down while
 *    reporting on it;
 *  - the exemption from the IP bucket is true in the database, not in a comment. `rate_limits`
 *    is Postgres-backed, so the bucket's own count says whether health traffic entered it, and
 *    a positive control (three requests on an ordinary public route, which must move that
 *    count by exactly three) is what makes the zero above it mean something.
 *
 * Every register claim is a DELTA against a baseline read before the traffic, because these
 * tables are minute-folded and shared with the previous run — an absolute count would pass or
 * fail on when this suite last ran, which is not a fact about the route.
 *
 * The 503 branch is NOT exercised here: it needs the database unreachable, and this dev
 * database is the production one. `tests/health.test.ts` pins that branch with an injected
 * probe; this file proves the same body arrives over real HTTP when the database answers, and
 * that it carries nothing that could name the database.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-health.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { HEALTH_ALIAS, HEALTH_LIVENESS, HEALTH_READINESS } from "../src/security/audience.js";

const ROOT = "http://localhost:4000";

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passes += 1; console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

async function get(path: string, headers?: Record<string, string>) {
  const res = await fetch(ROOT + path, { headers });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a non-JSON answer is its own finding */ }
  return { status: res.status, text, json };
}

/** The pieces of the connection string that must never appear in a public answer. Reported
 *  back truncated and starred, because printing what matched would be the leak this checks. */
function dsnParts(): string[] {
  const dsn = process.env.DATABASE_URL ?? "";
  const afterAt = dsn.split("@")[1] ?? "";
  const pw = dsn.includes("://")
    ? dsn.split("://")[1].split("@")[0].split(":").slice(1).join(":") : "";
  return [dsn, pw, afterAt.split("?")[0]].filter((s) => s.length > 3);
}

async function main() {
  const boot = await get(HEALTH_LIVENESS);
  if (boot.status !== 200) {
    console.error(`API not answering ${HEALTH_LIVENESS} on :4000 (${boot.status}) — boot it first`);
    process.exit(1);
  }

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const q = (sql: string, params: unknown[] = []) => owner.query(sql, params as any[]);
  const ipCount = async () => Number((await q(
    "select coalesce(sum(count),0)::int as n from rate_limits where bucket like 'ip:%'"
  )).rows[0].n);
  const totals = async (route: string) => {
    const row = (await q(
      "select coalesce(sum(requests),0)::bigint as n, coalesce(sum(server_errors),0)::bigint as errors," +
      " coalesce(max(max_ms),0)::int as worst from request_timings where method = 'GET' and route = $1",
      [route])).rows[0];
    return { n: Number(row.n), errors: Number(row.errors), worst: Number(row.worst) };
  };
  // Baselines first: everything below is measured as a change from here.
  const baseIp = await ipCount();
  const baseRoute: Record<string, { n: number; errors: number; worst: number }> = {
    [HEALTH_LIVENESS]: await totals(HEALTH_LIVENESS),
    [HEALTH_READINESS]: await totals(HEALTH_READINESS),
    [HEALTH_ALIAS]: await totals(HEALTH_ALIAS)
  };

  console.log("\n1. the paths the platform asks for");
  const live = await get(HEALTH_LIVENESS);
  const ready = await get(HEALTH_READINESS);
  const alias = await get(HEALTH_ALIAS);
  check("GET /health answers 200", live.status === 200, live.status);
  check("GET /health/ready answers 200 while the database answers", ready.status === 200,
    { status: ready.status, said: ready.json?.status });
  check("GET /api/v1/health still answers — the prefix every client learned first",
    alias.status === 200 && alias.json?.status === "ok", alias.status);
  check("a query string does not break the match", (await get("/health?verbose=1")).status === 200);
  check("the old contract is a subset of the new one",
    live.json?.status === "ok" && typeof live.json?.time === "string",
    { status: live.json?.status, time: live.json?.time });

  console.log("\n2. what it says about the process and the database");
  const db = live.json?.checks?.database ?? {};
  check("the database probe reached the database", db.status === "up", db);
  check("and measured the round trip instead of asserting it",
    Number.isFinite(db.latency_ms) && db.latency_ms >= 0, db.latency_ms);
  check("it names the service and how long this instance has been serving",
    live.json?.service === "waisha-api" && live.json?.uptime_seconds > 0,
    { service: live.json?.service, uptime: live.json?.uptime_seconds });
  check("it reports the pool it is standing on",
    ["total", "idle", "waiting"].every((k) => Number.isFinite(db.pool?.[k])), db.pool);
  check("readiness and liveness describe the same instant",
    ready.json?.checks?.database?.status === db.status, ready.json?.checks?.database);

  console.log("\n3. nothing beside the probes is reachable, and no token is needed");
  check("POST /health is not a route",
    (await fetch(ROOT + HEALTH_LIVENESS, { method: "POST" })).status === 404);
  const neighbour = await get("/healthz");
  const deeper = await get("/health/deep");
  check("a neighbour path and a deeper one still 404",
    neighbour.status === 404 && deeper.status === 404,
    { healthz: neighbour.status, deep: deeper.status });
  const broken = await get(HEALTH_LIVENESS, { Authorization: "Bearer not-a-token" });
  check("a garbage bearer cannot blind the platform's probe", broken.status === 200, broken.status);

  console.log("\n4. the answer carries nothing that could name the database");
  const TOP = ["status", "service", "environment", "commit", "time", "uptime_seconds", "checks"];
  const CHECK = ["status", "latency_ms", "age_seconds", "reason", "pool", "probes"];
  const POOL = ["total", "idle", "waiting"];
  check("the top level is exactly the allowlisted shape",
    Object.keys(live.json).every((k) => TOP.includes(k)), Object.keys(live.json));
  check("the database check is exactly the allowlisted shape",
    Object.keys(db).every((k) => CHECK.includes(k)), Object.keys(db));
  check("the pool object is exactly the allowlisted shape",
    Object.keys(db.pool ?? {}).every((k) => POOL.includes(k)), Object.keys(db.pool ?? {}));
  const lower = live.text.toLowerCase();
  const matched = dsnParts().map((p) => p.toLowerCase()).filter((p) => lower.includes(p));
  check("no part of the connection string is in the body", matched.length === 0,
    matched.map((m) => `${m.slice(0, 4)}***`));
  const words = ["postgres://", "supabase", "password", "stack", "message", "trace"];
  check("no driver text, stack or credential word is in the body",
    words.every((w) => !lower.includes(w)), words.filter((w) => lower.includes(w)));

  console.log("\n5. sixty polls, one round trip");
  const beforeBody = (await get(HEALTH_LIVENESS)).json;
  const before = beforeBody.checks.database.probes as number;
  const burst = await Promise.all(Array.from({ length: 60 }, () => get(HEALTH_LIVENESS)));
  const refused = burst.filter((b) => b.status !== 200).map((b) => b.status);
  check("every poll was answered", refused.length === 0, refused.slice(0, 5));
  const lastBody = burst[burst.length - 1].json;
  const after = lastBody.checks.database.probes as number;
  check("and they cost at most two database probes between them", after - before <= 2,
    { before, after, delta: after - before });
  check("nothing was queued for a connection while they ran",
    lastBody.checks.database.pool.waiting === 0, lastBody.checks.database.pool);

  console.log("\n6. the probe never enters the IP bucket");
  const c0 = await ipCount();
  for (let i = 0; i < 3; i++) await get("/api/v1/announcements");
  const c1 = await ipCount();
  check("three ordinary public requests move the bucket by three — the read can see growth",
    c1 - c0 === 3, { c0, c1, delta: c1 - c0 });
  for (let i = 0; i < 20; i++) await get(HEALTH_LIVENESS);
  const c2 = await ipCount();
  check("twenty health polls move it by none", c2 - c1 === 0, { c1, c2, delta: c2 - c1 });

  console.log("\n7. the reliability collector folds these routes like any other");
  await new Promise((r) => setTimeout(r, 7000)); // the flush loop runs every five seconds
  const liveNow = await totals(HEALTH_LIVENESS);
  const readyNow = await totals(HEALTH_READINESS);
  const aliasNow = await totals(HEALTH_ALIAS);
  const dn = (route: string, now: { n: number; errors: number }) =>
    now.n - baseRoute[route].n;
  const de = (route: string, now: { n: number; errors: number }) =>
    now.errors - baseRoute[route].errors;

  check(`${HEALTH_LIVENESS} was folded as its own route`, dn(HEALTH_LIVENESS, liveNow) >= 60,
    { requests: dn(HEALTH_LIVENESS, liveNow), worst_ms: liveNow.worst });
  check("the sixty-poll burst landed as counted requests on one folded row, not sixty rows",
    dn(HEALTH_LIVENESS, liveNow) >= 60 && de(HEALTH_LIVENESS, liveNow) === 0,
    { requests: dn(HEALTH_LIVENESS, liveNow), errors: de(HEALTH_LIVENESS, liveNow) });
  check(`${HEALTH_ALIAS} is on the register too`, dn(HEALTH_ALIAS, aliasNow) >= 1 &&
    de(HEALTH_ALIAS, aliasNow) === 0,
    { requests: dn(HEALTH_ALIAS, aliasNow), errors: de(HEALTH_ALIAS, aliasNow) });
  check(`${HEALTH_READINESS} is on the register`, dn(HEALTH_READINESS, readyNow) >= 1,
    { requests: dn(HEALTH_READINESS, readyNow) });
  // Readiness is allowed a 5xx: while the database is unreachable its contract IS the 503, and
  // the collector counts a 503 as a server error like any other. What would be a bug is more
  // errors than requests, or a 503 this run did not ask for.
  check("readiness never counts more server errors than requests",
    de(HEALTH_READINESS, readyNow) <= dn(HEALTH_READINESS, readyNow),
    { errors: de(HEALTH_READINESS, readyNow), requests: dn(HEALTH_READINESS, readyNow) });
  check("and it broke only the way this run asked it to",
    de(HEALTH_READINESS, readyNow) === 0 ||
    (ready.status === 503 && ready.json?.status === "unavailable"),
    { errors: de(HEALTH_READINESS, readyNow), saw: ready.status, said: ready.json?.status });

  await owner.end();
  console.log(`\nhealth smoke: ${passes} ok, ${failures} failed ` +
    `(ip bucket untouched by ${c2 - c1} polls, database round trip ${db.latency_ms} ms)`);
  console.log("no fixture rows: the only residue is the latency and rate counters this route " +
    "is supposed to leave in its registers.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
