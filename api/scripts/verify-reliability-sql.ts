/**
 * Live proof for #155a/#155b — reliability measured instead of asserted (migration 085).
 *
 * The same rule 066 established and 082 re-proved: EXPLAIN cannot see inside a SECURITY
 * DEFINER body, so a collector that silently drops every row, a percentile that interpolates
 * against the wrong band, or an uptime percentage that quietly divides by a period before the
 * collector existed is only caught by running it. The posture half is read out of the catalog
 * as the owner; the execution half runs the exported statements from the routes and the
 * collector, so what is tested is the exact string the desk sends.
 *
 * Two halves on purpose:
 *
 *  - The live half writes through the real pool (`flushRequestTimings`), because that is the
 *    path a request takes in production: hook → in-process fold → one JSON statement. Its rows
 *    are deleted again at the end; nothing else in this file commits.
 *  - The probe half runs inside one transaction and rolls back. It needs to be inside a
 *    transaction for the arithmetic to be testable at all: `now()` is the transaction timestamp,
 *    so a minute's worth of folding is deterministic in there, and the retention tests can
 *    delete without destroying real history.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-reliability-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  RECORD_BOOT_SQL, RECORD_HEARTBEAT_SQL, RECORD_REQUESTS_SQL,
  foldRequest, flushRequestTimings, INSTANCE_ID
} from "../src/security/reliability.js";
import { normalisePath } from "../src/security/error-record.js";
import {
  UPTIME_SQL, LATENCY_SQL, LATENCY_DAILY_SQL, LATENCY_OVERALL_SQL, BLOAT_SQL,
  SNAPSHOT_META_SQL, SNAPSHOT_CAPTURE_SQL, METRICS_PRUNE_SQL, reliabilityAdvisory, dayKey
} from "../src/routes/control-reliability.routes.js";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label,
    (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500)); }
}

function ownerUrl(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  return url;
}

/** app_runtime URL: dev hands us the owner URL, so rebuild it (066's shape). */
function appUrl(): string | null {
  const url = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  const u = new URL(url);
  if (u.username.startsWith("app_runtime")) return url;
  if (!process.env.APP_DB_PASSWORD) return null;
  const ref = u.username.split(".")[1];
  u.username = "app_runtime" + (ref ? "." + ref : "");
  u.password = encodeURIComponent(process.env.APP_DB_PASSWORD);
  return u.toString();
}

const DEFINERS = [
  "record_boot", "record_heartbeat", "record_requests", "capture_pg_stat",
  "uptime_report", "request_latency", "request_daily", "request_overall",
  "bloat_trend", "snapshot_meta", "prune_metrics"
];
const TABLES = ["service_boots", "service_heartbeats", "request_timings", "pg_stat_snapshots"];

/** One stamp per run so a probe line can never be mistaken for real traffic. */
const STAMP = "v" + Date.now().toString(36) + "p";
const R_FAST = `/085/verify/fast/${STAMP}`;
const R_OK = `/085/verify/ok/${STAMP}`;
const R_AWFUL = `/085/verify/awful/${STAMP}`;
const R_FOLD = `/085/verify/fold/${STAMP}`;
const R_FOLD2 = `/085/verify/fold2/${STAMP}`;
const R_GOOD = `/085/verify/good/${STAMP}`;
const PROBE_ROUTES = [R_FAST, R_OK, R_AWFUL, R_FOLD, R_FOLD2, R_GOOD];

/** The row shape the collector emits, spelled out so a probe can override one field. */
function row(route: string, over: Record<string, unknown> = {}) {
  return {
    method: "GET", route, requests: 1, sum_ms: 50, max_ms: 50,
    band_fast: 1, band_ok: 0, band_slow: 0, band_bad: 0, band_awful: 0,
    server_errors: 0, ...over
  };
}

/** Numbers in, number out. A null becomes NaN rather than null so every comparison against it
 *  is false — an assertion that reads a missing figure fails loudly instead of quietly
 *  matching another missing figure, which is what a `null === null` would have done. */
const n = (v: any) => (v === null || v === undefined ? NaN : Number(v));
/** `record_requests` answers with the count it accepted, in a column of its own name — the
 *  same receipt the collector's flush gets, and the only proof a fold was not silently dropped. */
const receipt = (r: any) => n(r?.rows?.[0]?.record_requests);

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();

  // ================================================================
  console.log("\n--- 1 · the collector, on the path a real request takes ---");

  // The latency table and the error register have to name a route in the same words or the
  // two desks cannot be read side by side. Same function, so the shapes are re-asserted here.
  const id = randomUUID();
  check("the route key is the error register's normalised path, query string and all",
    normalisePath(`/api/v1/drivers/${id}/docs?token=abc`) === "/api/v1/drivers/:id/docs"
    && normalisePath("/api/v1/trips/41780") === "/api/v1/trips/:id",
    normalisePath(`/api/v1/drivers/${id}/docs?token=abc`));

  // A run that crashed mid-way would otherwise leave probe lines behind and make the fold
  // counts below ambiguous. Nothing else in this file commits.
  await owner.query(`delete from request_timings where route like '/085/verify/%'`);

  const before = (await owner.query("select count(*)::int as n from request_timings")).rows[0].n;
  const advisoryBefore = await reliabilityAdvisory(7);
  check("an empty store is reported as an empty store, not as a healthy week",
    before === 0 ? advisoryBefore.items.some((i: any) => i.item_id === "latency_no_samples")
      : !advisoryBefore.items.some((i: any) => i.item_id === "latency_no_samples"),
    { before, items: advisoryBefore.items.map((i: any) => i.item_id) });

  // The state the desk is in the minute it ships: the register exists, the collector has not
  // run yet. A 0% here would be an invented outage, so the reader returns no percentage and
  // the advisory says the collector is missing instead of saying the app is down. Which of
  // the two states this run is in depends on whether an API beside it has already booted, so
  // the boot register is read first and both answers are checked against their own rule.
  const bootsBefore = (await owner.query("select count(*)::int as n from service_boots")).rows[0].n;
  const empty = advisoryBefore.uptime as any;
  check("an empty boot register answers with no percentage rather than a 0% outage",
    bootsBefore === 0
      ? empty.uptime_pct === null && n(empty.expected_minutes) === 0 && n(empty.instances) === 0
        && Array.isArray(empty.boots) && empty.boots.length === 0
        && /No boot has been recorded/.test(String(empty.collector_note ?? ""))
        && advisoryBefore.items.some((i: any) => i.item_id === "uptime_no_collector")
        && !advisoryBefore.items.some((i: any) => i.item_id === "uptime_gap")
      : n(empty.instances) > 0 && empty.uptime_pct !== null
        && n(empty.uptime_pct) >= 0 && n(empty.uptime_pct) <= 100
        && !advisoryBefore.items.some((i: any) => i.item_id === "uptime_no_collector"),
    { bootsBefore, empty, items: advisoryBefore.items.map((i: any) => i.item_id) });

  // Folded in memory first: five bands, a negative duration, and an absurd one, on one cell.
  const folded = [50, 150, 500, 1500, 5000, -25, 10_000_000]
    .map((ms, i) => foldRequest("GET", R_FOLD, ms, i === 4 ? 503 : 200));
  check("seven folds into one cell, and a 5xx lands in its server-error count",
    folded.every(Boolean));
  const written = await flushRequestTimings();
  const live = (await owner.query(
    `select method, route, requests, sum_ms, max_ms, band_fast, band_ok, band_slow,
            band_bad, band_awful, server_errors,
            bucket = date_trunc('minute', bucket) as on_minute,
            bucket between now() - interval '3 minutes' and now() as fresh,
            count(*) over () as lines
       from request_timings where route = $1`, [R_FOLD])).rows[0];
  // The definer drops a row whose max_ms is over 600000 outright, so the clamp has to happen
  // in the hook or a single pathological duration would delete the whole minute of counts.
  check("one flush writes one line for the cell, on the database's own truncated minute",
    written === 1 && n(live?.lines) === 1 && n(live?.requests) === 7
    && live?.on_minute === true && live?.fresh === true,
    { written, live });
  check("a negative duration folds to 0 and an absurd one to the ceiling, never past it",
    n(live?.max_ms) === 600000 && n(live?.sum_ms) === 50 + 150 + 500 + 1500 + 5000 + 0 + 600000,
    { sum: live?.sum_ms, max: live?.max_ms });
  check("each duration lands in the band its reader interpolates from",
    n(live?.band_fast) === 2 && n(live?.band_ok) === 1 && n(live?.band_slow) === 1
    && n(live?.band_bad) === 1 && n(live?.band_awful) === 2
    && n(live?.band_fast) + n(live?.band_ok) + n(live?.band_slow) + n(live?.band_bad)
       + n(live?.band_awful) === n(live?.requests), live);
  check("…and the 503 is counted as a server error without touching the others",
    n(live?.server_errors) === 1, live?.server_errors);
  check("the flush drained the buffer, so the next one writes nothing",
    (await flushRequestTimings()) === 0);

  // ================================================================
  console.log("\n--- 2 · the catalog posture a handler must not be able to talk around ---");

  const shape = await owner.query(
    `select c.relname, c.relrowsecurity,
            (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
            (select string_agg(privilege_type, ',' order by privilege_type)
               from information_schema.table_privileges tp
              where tp.table_name = c.relname
                and tp.grantee in ('app_runtime','public','anon','authenticated','service_role'))
              as granted
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any($1)
       order by c.relname`, [TABLES]);
  check("all four stores exist", shape.rows.length === 4, shape.rows.map((r) => r.relname));
  for (const t of shape.rows) {
    check(`${t.relname}: row security on`, t.relrowsecurity === true, t);
    check(`…with zero policies, because nothing is meant to be readable through RLS`,
      Number(t.policies) === 0, t.policies);
    check(`…and no table grant to app_runtime, public, anon, authenticated or service_role`,
      !t.granted, t.granted);
  }

  const idx = await owner.query(
    `select indexname, indexdef from pg_indexes where schemaname = 'public'
       and tablename = any($1) order by tablename, indexname`, [TABLES]);
  const defs = idx.rows.map((r) => r.indexdef);
  check("the timing store's fold key is (bucket, method, route) — one line per route per minute",
    defs.some((d) => /UNIQUE/i.test(d) && /bucket/.test(d) && /method/.test(d) && /route/.test(d)),
    defs.filter((d) => /USING btree \("(bucket|method)"/.test(d)));
  check("the boot and heartbeat keys name the instance, so two dynos are two series",
    defs.some((d) => /UNIQUE/i.test(d) && /instance/.test(d) && /started_at/.test(d))
    && defs.some((d) => /UNIQUE/i.test(d) && /bucket/.test(d) && /instance/.test(d)), defs);
  check("a snapshot is keyed on the capture and the relation, and both read paths are indexed",
    defs.some((d) => /UNIQUE/i.test(d) && /captured_at/.test(d) && /relid/.test(d))
    && defs.some((d) => /relname/.test(d) && /captured_at desc/i.test(d))
    && defs.some((d) => /captured_at desc/i.test(d)), defs);

  // 085 has no CHECK constraints: the guards live in the writer's WHERE clause, because a
  // constraint would raise inside a collector that is not allowed to raise.
  const cons = await owner.query(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = any($1::regclass[]) and contype = 'c'`, [TABLES]);
  check("the only constraints are the keys — the clamping is done by the writer, not a check",
    cons.rows.length === 0, cons.rows);

  const acl = await owner.query(
    `select p.proname, p.prosecdef,
            coalesce(nullif(array_to_string(p.proconfig, ','), ''), '(unset)') as config,
            pg_get_function_identity_arguments(p.oid) as args,
            has_function_privilege('app_runtime', p.oid, 'execute') as app_x,
            has_function_privilege('public', p.oid, 'execute') as pub_x,
            has_function_privilege('anon', p.oid, 'execute') as anon_x,
            has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
            has_function_privilege('service_role', p.oid, 'execute') as svc_x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)
      order by p.proname`, [DEFINERS]);
  check("every 085 definer is present in the catalog",
    DEFINERS.every((d) => acl.rows.some((r) => r.proname === d)),
    acl.rows.map((r) => r.proname));
  for (const r of acl.rows) {
    check(`${r.proname}: definer, search_path pinned, app_runtime only`,
      r.prosecdef === true && r.config === "search_path=public" && r.app_x === true
      && r.pub_x === false && r.anon_x === false && r.auth_x === false && r.svc_x === false, r);
  }
  check("none of them is executable by PUBLIC — the writers included",
    acl.rows.every((r) => r.pub_x === false),
    acl.rows.filter((r) => r.pub_x).map((r) => r.proname));
  check("record_requests takes one jsonb parameter, not a typed one per column",
    acl.rows.some((r) => r.proname === "record_requests" && r.args === "p_rows jsonb"),
    acl.rows.find((r) => r.proname === "record_requests")?.args);

  // ================================================================
  console.log("\n--- 3 · the writers and the readers, on lines that roll back ---");

  const bootInstance = `probe-${STAMP}`;
  const clampedInstance = "x".repeat(80);
  const oldBucket = new Date(Date.now() - 30 * 86400_000);

  // Everything below this line is arithmetic against whole registers, and the registers are
  // live: an API running beside this script boots and beats and flushes timings of its own,
  // and whoever pressed the snapshot button on the desk committed captures that are not
  // ours. So the transaction starts by clearing the foreign lines — which is safe precisely
  // because it rolls all of it back — and the residue check compares against this baseline
  // rather than against zero.
  const baseline = await owner.query(
    `select (select count(*)::int from service_boots) as boots,
            (select count(*)::int from service_heartbeats) as beats,
            (select count(*)::int from pg_stat_snapshots) as snapshots,
            (select count(*)::int from request_timings) as timings`);

  await owner.query("begin");
  try {
    await owner.query(`delete from service_boots`);
    await owner.query(`delete from service_heartbeats`);
    await owner.query(`delete from pg_stat_snapshots`);
    await owner.query(`delete from request_timings where bucket < now() - interval '7 days'`);

    // ----------------------------------------------------------------
    console.log("\n--- 3a · boots and heartbeats ---");

    await owner.query(RECORD_BOOT_SQL, [bootInstance, "v20.10.0", "linux/x64", "verify"]);
    await owner.query(RECORD_BOOT_SQL, [bootInstance, "v20.10.0", "linux/x64", "verify"]);
    await owner.query(RECORD_BOOT_SQL, ["   ", null, null, null]);
    await owner.query(RECORD_BOOT_SQL, [null, null, null, null]);
    const boots = await owner.query(
      `select instance, char_length(instance) as ilen, char_length(node) as nlen,
              environment, platform, started_at from service_boots`);
    check("a blank or null instance writes no boot line at all",
      boots.rows.length === 1, boots.rows);
    check("a boot is recorded once with its environment and its runtime",
      boots.rows[0]?.instance === bootInstance && boots.rows[0]?.environment === "verify"
      && boots.rows[0]?.platform === "linux/x64" && !!boots.rows[0]?.started_at, boots.rows[0]);
    check("…and every field is clamped to the column, not rejected by it",
      (await owner.query(RECORD_BOOT_SQL,
        ["x".repeat(200), "n".repeat(90), "p".repeat(90), "e".repeat(90)])).rowCount === 1
      && (await owner.query(
        `select char_length(instance) as i, char_length(node) as o,
                char_length(platform) as p, char_length(environment) as e
           from service_boots where instance = $1`, [clampedInstance]))
        .rows[0]?.i === 80, "clamped");

    await owner.query(RECORD_HEARTBEAT_SQL, [bootInstance]);
    await owner.query(RECORD_HEARTBEAT_SQL, [bootInstance]);
    await owner.query(RECORD_HEARTBEAT_SQL, [""]);
    const beats = await owner.query(
      `select count(*)::int as n, max(seen_at) as seen from service_heartbeats`);
    check("two heartbeats in one minute are one line, and a blank instance writes none",
      beats.rows[0]?.n === 1, beats.rows[0]);

    // A minute-by-minute series with one eleven-minute hole in it, which is the only shape
    // in which an uptime percentage means anything.
    const buckets: string[] = [];
    for (let m = 0; m <= 90; m++) {
      if (m >= 30 && m <= 39) continue;
      buckets.push(`date_trunc('minute', now() - make_interval(mins => ${m}))`);
    }
    await owner.query(
      `insert into service_heartbeats (bucket, instance, seen_at)
       select b, $1, now() from unnest(array[${buckets.join(",")}]) as b
       on conflict (bucket, instance) do nothing`,
      [bootInstance]);
    await owner.query(
      `insert into service_boots (instance, started_at) values ($1, now() - interval '90 minutes')`,
      [bootInstance]);

    const up = (await owner.query(UPTIME_SQL, [7])).rows[0].r as any;
    const alive = buckets.length;
    check("uptime counts alive minutes over expected minutes on the same clock",
      up.alive_minutes === alive && n(up.expected_minutes) >= 90 && n(up.expected_minutes) <= 91,
      { alive, up });
    check("…and the percentage is that division, capped at 100",
      // `expected_minutes` is printed rounded to a minute while the divide keeps the exact
      // fractional one, so a whole minute of drift is the most the two can ever differ by.
      Math.abs(n(up.uptime_pct) - Math.min(100, alive * 100 / n(up.expected_minutes))) <= 1
      && n(up.uptime_pct) <= 100 && n(up.uptime_pct) > 80,
      { uptime_pct: up.uptime_pct, alive, expected: up.expected_minutes });
    check("the eleven-minute hole is the longest gap, and it is listed with both edges",
      n(up.longest_gap_minutes) === 11 && up.gaps?.length === 1
      && n(up.gaps[0].minutes) === 11 && !!up.gaps[0].before && !!up.gaps[0].after, up.gaps);
    check("a window wider than the collector's life is floored at the first boot",
      // 30 days asked, ~91 minutes measurable: the floor is what stops this reading as 0.2%.
      n((await owner.query(UPTIME_SQL, [30])).rows[0].r.expected_minutes) < 200,
      (await owner.query(UPTIME_SQL, [30])).rows[0].r);
    const up30 = (await owner.query(UPTIME_SQL, [30])).rows[0].r as any;
    check("…so the percentage does not change when the window grows past the boot",
      Math.abs(n(up30.uptime_pct) - n(up.uptime_pct)) < 0.02
      && up30.measured_from === up.measured_from, { up30, measured_from: up.measured_from });
    check("the register says how many instances it counted and lists the boots behind them",
      // Three lines, two workers: the probe booted twice (once folded, once 90 minutes ago)
      // and the clamped instance is a second worker. The list is per boot, the count per
      // instance, and the desk needs both to tell a restart from a crash loop.
      up.instances === 2 && up.boot_count === 3 && Array.isArray(up.boots)
      && up.boots.length === 3 && !!up.last_boot, { i: up.instances, b: up.boot_count });
    check("and it prints the caveat with the number, not under the fold",
      /not a probe from outside/.test(String(up.collector_note ?? "")), up.collector_note);

    // Twelve restarts in twelve minutes is what a crash loop looks like from the inside. The
    // boot list is capped at ten so the desk stays readable; the counts are not, because an
    // operator has to see how often it broke even when the lines are not all on screen.
    await owner.query(
      `insert into service_boots (instance, started_at)
       select 'probe-loop-' || g, now() - make_interval(mins => g) from generate_series(1, 12) g`);
    const crashed = (await owner.query(UPTIME_SQL, [7])).rows[0].r as any;
    check("a crash loop is counted in full but listed only ten deep, and moves no percentage",
      Array.isArray(crashed.boots) && crashed.boots.length === 10
      && n(crashed.boot_count) === 15 && n(crashed.instances) === 14
      && n(crashed.uptime_pct) === n(up.uptime_pct),
      { listed: crashed.boots?.length, boot_count: crashed.boot_count,
        instances: crashed.instances, pct: crashed.uptime_pct });

    // ----------------------------------------------------------------
    console.log("\n--- 3b · the batched timing writer and what it refuses ---");

    // A route of its own, written only inside this transaction: folding is only deterministic
    // when both flushes share one `now()`, and the live line above belongs to whichever minute
    // the clock happened to be in when the pool flushed it.
    const firstFold = await owner.query(RECORD_REQUESTS_SQL, [JSON.stringify([
      row(R_FOLD2, { requests: 3, sum_ms: 150, max_ms: 90, band_fast: 2, band_ok: 1 })])]);
    const secondFold = await owner.query(RECORD_REQUESTS_SQL, [JSON.stringify([
      row(R_FOLD2, { requests: 4, sum_ms: 400, max_ms: 400, band_fast: 0, band_ok: 4 })])]);
    const lines2 = (await owner.query(
      `select count(*)::int as lines, max(requests)::int as requests, max(sum_ms)::text as sum_ms,
              max(max_ms)::int as max_ms, max(band_ok)::int as band_ok,
              max(band_fast)::int as band_fast, max(band_awful)::int as band_awful,
              max(server_errors)::int as server_errors, max(first_ts) as first_ts,
              max(last_ts) as last_ts
         from request_timings where route = $1`, [R_FOLD2])).rows[0];
    check("a second flush into the same minute folds into the same line",
      receipt(firstFold) === 1 && receipt(secondFold) === 1 && n(lines2?.lines) === 1,
      { first: firstFold.rows[0], second: secondFold.rows[0], lines2 });
    check("counts and bands add up while the worst duration is kept, not the latest",
      n(lines2?.requests) === 7 && n(lines2?.sum_ms) === 550 && n(lines2?.max_ms) === 400
      && n(lines2?.band_fast) === 2 && n(lines2?.band_ok) === 5
      && n(lines2?.band_awful) === 0
      && n(lines2?.band_fast) + n(lines2?.band_ok) === n(lines2?.requests), lines2);
    check("…and the line carries both ends of the minute the desk sorts on",
      !!lines2?.first_ts && !!lines2?.last_ts, lines2);

    await owner.query(RECORD_REQUESTS_SQL, [JSON.stringify([
      row(R_FOLD2, { method: "POST", requests: 2, sum_ms: 20, max_ms: 10, band_fast: 2 })])]);
    const perMethod = (await owner.query(
      `select count(*)::int as lines, sum(requests)::int as requests
         from request_timings where route = $1`, [R_FOLD2])).rows[0];
    check("the same route under two methods is two lines, because they are two handlers",
      n(perMethod?.lines) === 2 && n(perMethod?.requests) === 9, perMethod);

    const mixed = await owner.query(RECORD_REQUESTS_SQL, [JSON.stringify([
      row(R_GOOD),                                    // the only acceptable line
      row(`/085/verify/x/${STAMP}`, { method: "get" }),        // lowercase method
      row(`/085/verify/x/${STAMP}`, { method: "GETGETGETGETGET" }), // too long
      row(`/085/verify/x/${STAMP}?token=1`),                    // query string
      row(`/085//verify/x/${STAMP}`),                            // double slash
      row(`/085/verify/${"l".repeat(320)}`),                     // route over the ceiling
      row(`/085/verify/x/${STAMP}`, { max_ms: 600001 }),         // over the ceiling
      row(`/085/verify/x/${STAMP}`, { requests: 0 }),            // nothing happened
      row(`/085/verify/x/${STAMP}`, { sum_ms: -1 }),             // impossible total
      row(`/085/verify/x/${STAMP}`, { route: "  " }),            // blank
      row(`/085/verify/x/${STAMP}`, { route: null, method: null })
    ])]);
    check("one bad row does not poison the flush beside it — the good line still lands",
      receipt(mixed) === 1, mixed.rows[0]);
    check("…and none of the ten rejected shapes reached the table",
      (await owner.query(
        `select count(*)::int as n from request_timings where route like '/085/verify/x/%'
                                                    or route like '/085//%'
                                                    or route like '%?%'
                                                    or char_length(route) > 300`)).rows[0].n === 0);
    check("…and the long route was refused outright, not stored under a truncation of it",
      (await owner.query(
        `select count(*)::int as n from request_timings where route like $1`,
        [`/085/verify/${"l".repeat(60)}%`])).rows[0].n === 0);

    const beforeJunk = (await owner.query("select count(*)::int as n from request_timings"))
      .rows[0].n;
    const empties = await owner.query(RECORD_REQUESTS_SQL, [JSON.stringify([])]);
    const nulls = await owner.query(RECORD_REQUESTS_SQL, [null]);
    const object = await owner.query(RECORD_REQUESTS_SQL, ['{"a":1}']);
    const scalar = await owner.query(RECORD_REQUESTS_SQL, ['"not an array"']);
    check("an empty array, a null, an object and a JSON scalar each write nothing and raise nothing",
      receipt(empties) === 0 && receipt(nulls) === 0 && receipt(object) === 0
      && receipt(scalar) === 0
      && (await owner.query("select count(*)::int as n from request_timings")).rows[0].n
         === beforeJunk,
      { empties: empties.rows[0], nulls: nulls.rows[0], object: object.rows[0],
        scalar: scalar.rows[0] });

    // Text that is not JSON at all is refused where the wire meets the type, so it raises —
    // inside a savepoint, because a probe may not abort the transaction the rest of this file
    // runs in. A server that handed the collector this shape would surface as a caught flush
    // error in the loop, not as a broken request, which is the point of the catch beside it.
    await owner.query("savepoint not_json");
    const junk = await owner.query(RECORD_REQUESTS_SQL, ["not json at all"])
      .then((r) => ({ wrote: receipt(r) as number | null, raised: null as string | null }))
      .catch((e) => ({ wrote: null as number | null, raised: String(e.message) }));
    await owner.query("rollback to savepoint not_json");
    check("…and a payload that is not JSON is refused by the cast with nothing stored",
      junk.raised !== null && /invalid input syntax for type json/i.test(junk.raised)
      && (await owner.query("select count(*)::int as n from request_timings")).rows[0].n
         === beforeJunk, junk);

    // ----------------------------------------------------------------
    console.log("\n--- 3c · percentiles read out of the bands ---");

    await owner.query(RECORD_REQUESTS_SQL, [JSON.stringify([
      row(R_FAST, { requests: 100, sum_ms: 5000, max_ms: 50, band_fast: 100, band_ok: 0 }),
      row(R_OK, { requests: 20, sum_ms: 3000, max_ms: 150, band_fast: 0, band_ok: 20 }),
      row(R_AWFUL, { requests: 10, sum_ms: 40000, max_ms: 5000, band_fast: 0, band_awful: 10,
        server_errors: 2 })
    ])]);
    const lat = (await owner.query(LATENCY_SQL, [7, 200])).rows
      .filter((r: any) => PROBE_ROUTES.includes(r.route))
      .reduce((acc: Record<string, any>, r: any) => (acc[r.route] = r, acc), {});

    const fast = lat[R_FAST] ?? {};
    check("a route entirely inside the fastest band interpolates 50 and 95",
      n(fast.requests) === 100 && n(fast.mean_ms) === 50 && n(fast.p50_ms) === 50
      && n(fast.p95_ms) === 95 && n(fast.over_1s) === 0 && n(fast.max_ms) === 50, fast);
    const ok = lat[R_OK] ?? {};
    check("the second band is interpolated from its own floor and width",
      n(ok.p50_ms) === 200 && n(ok.p95_ms) === 290 && n(ok.mean_ms) === 150, ok);
    const awful = lat[R_AWFUL] ?? {};
    check("the top band interpolates against the stored worst, not against a made-up ceiling",
      n(awful.p50_ms) === 4000 && n(awful.p95_ms) === 4900 && n(awful.max_ms) === 5000
      && n(awful.over_1s) === 10, awful);
    check("…and two server errors in ten requests is an error rate the desk can print",
      n(awful.server_errors) === 2 && n(awful.error_rate) === 20, awful);
    check("the desk gets the method and the route in words the error register uses too",
      awful.method === "GET" && awful.route === R_AWFUL && !!awful.last_seen, awful);
    const busyness = (await owner.query(LATENCY_SQL, [7, 200])).rows
      .filter((r: any) => PROBE_ROUTES.includes(r.route))
      .map((r: any) => n(r.requests));
    check("busiest first, so the top of the table is the route worth fixing",
      busyness.join() === busyness.slice().sort((a, b) => b - a).join(), busyness);
    check("the row limit is honoured",
      (await owner.query(LATENCY_SQL, [7, 1])).rows.length <= 1);

    const day = (await owner.query(LATENCY_DAILY_SQL, [7])).rows;
    const darToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Dar_es_Salaam", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    // Read through the helper the desk builds its payload with: pg returns this `date` as a
    // Date at local midnight, so the raw JSON of the row says yesterday (the slice below is
    // what a naive read would have believed).
    const dayRow = day.find((r: any) => dayKey(r.day) === darToday);
    check("the daily series buckets on the country's date, and the desk's key keeps it there",
      day.length >= 1 && !!dayRow && n(dayRow.requests) >= 147,
      { darToday, keyed: dayRow && dayKey(dayRow.day), raw: String(dayRow?.day),
        requests: dayRow?.requests });
    const overall = (await owner.query(LATENCY_OVERALL_SQL, [7])).rows[0].r as any;
    check("the overall line is the same arithmetic over every route at once",
      n(overall.requests) >= 147 && n(overall.routes) >= 5 && n(overall.over_1s) >= 12
      && n(overall.server_errors) >= 3 && overall.window_days === 7, overall);
    check("…and its percentile is banded the same way, with the ceiling it used",
      n(overall.max_ms) === 600000 && n(overall.p95_ms) !== null, overall);

    // ----------------------------------------------------------------
    console.log("\n--- 3d · bloat: a direction needs two captures, and says so ---");

    const cap = (await owner.query(SNAPSHOT_CAPTURE_SQL)).rows[0].r as any;
    const tables = (await owner.query(
      `select count(*)::int as n from pg_stat_user_tables s
        join pg_class c on c.oid = s.relid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'`)).rows[0].n;
    check("a capture copies every user table out of pg_stat and receipts the count",
      cap.status === "ok" && n(cap.relations) === tables && !!cap.captured_at,
      { cap, tables });
    check("the stored snapshot carries the janitor's counters, not a summary of them",
      (await owner.query(
        `select relname, n_live_tup, n_dead_tup, table_bytes, index_bytes, seq_scan, idx_scan
           from pg_stat_snapshots where relname = 'audit_logs'`)).rows.length === 1);

    // Same transaction, same now(), so the same captured_at: the primary key refuses it and
    // the receipt says failed instead of returning ok with nothing behind it.
    const twice = (await owner.query(SNAPSHOT_CAPTURE_SQL)).rows[0].r as any;
    check("a second capture inside one transaction is refused loudly, not silently",
      twice.status === "failed" && /duplicate key|violates/i.test(String(twice.message ?? "")),
      twice);

    const meta1 = (await owner.query(SNAPSHOT_META_SQL)).rows[0].r as any;
    check("one capture is reported as no history, which is what it is",
      n(meta1.captures) === 1 && meta1.has_history === false
      && n(meta1.relations) === tables, meta1);

    const trend1 = (await owner.query(BLOAT_SQL, [30, 200])).rows;
    check("with one capture every growth column is NULL rather than a zero that reads as stable",
      trend1.length === Math.min(tables, 200) && trend1.every((r: any) => n(r.snapshots) === 1
        && r.dead_growth === null && r.table_growth_bytes === null),
      { returned: trend1.length, tables, sample: trend1.slice(0, 2) });

    // A direction needs two ends, and the live counters cannot supply them: a restart zeroes
    // `pg_stat_*`, and a connection through a pooler sees only what other backends have
    // flushed. So the second capture is synthesised — written straight into the store four
    // hours after the real one, with values the assertions below can state exactly. That is
    // the shape a scheduled second capture produces for a quiet table anyway.
    const real0 = (await owner.query(
      `select relid, n_live_tup, n_dead_tup, table_bytes, captured_at
         from pg_stat_snapshots where relname = 'audit_logs'
        order by captured_at desc limit 1`)).rows[0];
    const later = new Date(real0.captured_at.getTime() + 4 * 3600_000);
    await owner.query(
      `insert into pg_stat_snapshots (captured_at, relid, relname, n_live_tup, n_dead_tup,
                                      table_bytes, index_bytes, seq_scan, idx_scan,
                                      last_vacuum, last_autovacuum)
       values ($1::timestamptz,$2,'audit_logs',2000,1500,32768,8192,17,100,
               $1::timestamptz - interval '2 hours', null)`, [later, real0.relid]);
    const trend = (await owner.query(BLOAT_SQL, [30, 200])).rows;
    const grown = trend.find((r: any) => r.relname === "audit_logs");
    const single = trend.find((r: any) => r.relname !== "audit_logs");
    check("two captures turn into a dead-tuple growth and a size growth, newest minus oldest",
      n(grown?.snapshots) === 2 && n(grown?.dead_growth) === 1500 - n(real0.n_dead_tup)
      && n(grown?.table_growth_bytes) === 32768 - n(real0.table_bytes)
      && n(grown?.first_seen) === n(real0.captured_at) && n(grown?.last_seen) === n(later),
      { grown, real0 });
    check("…while every relation with one capture still refuses to claim a direction",
      n(single?.snapshots) === 1 && single?.dead_growth === null
      && single?.table_growth_bytes === null, single);
    check("the list is ordered by the dead tuples it shows, so the worst is at the top",
      trend.every((r: any, i: number) => i === 0
        || n(trend[i - 1].dead_tuples) >= n(r.dead_tuples)),
      trend.slice(0, 3).map((r: any) => [r.relname, r.dead_tuples]));
    check("the scan columns are the newest absolute counters, and the ratio is theirs",
      n(grown?.seq_scans) === 17 && n(grown?.idx_scans) === 100
      && Math.abs(n(grown?.scan_ratio) - 0.17) < 0.01, { grown });
    check("a table that has never been scanned by index answers with NULL, not a division error",
      trend.every((r: any) => r.scan_ratio === null || Number.isFinite(n(r.scan_ratio))),
      trend.filter((r: any) => r.scan_ratio === null).slice(0, 3));
    check("the newest snapshot's own tuples and sizes are what the desk prints",
      n(grown?.live_tuples) === 2000 && n(grown?.dead_tuples) === 1500
      && n(grown?.table_bytes) === 32768 && n(grown?.index_bytes) === 8192
      && Math.abs(n(grown?.dead_pct) - 100 * 1500 / 3500) < 0.1, { grown });
    check("…and a stale janitor is stated in hours against the capture, never as a zero",
      Math.abs(n(grown?.vacuum_stale_hours) - 2) < 0.05
      && grown?.last_autovacuum === null, { stale: grown?.vacuum_stale_hours });
    check("the meta line now has a history to show",
      (await owner.query(SNAPSHOT_META_SQL)).rows[0].r.has_history === true);

    // ----------------------------------------------------------------
    console.log("\n--- 3e · retention is an operator decision with a floor under it ---");

    await owner.query(
      `insert into request_timings (bucket, method, route, requests, sum_ms, max_ms,
                                    band_fast, first_ts, last_ts)
       values ($1,'GET',$2,9,450,50,9,$1,$1)`, [oldBucket, `/085/verify/old/${STAMP}`]);
    await owner.query(`insert into service_heartbeats (bucket, instance, seen_at)
                       values ($1,$2,$1)`, [oldBucket, bootInstance]);
    await owner.query(
      `insert into pg_stat_snapshots (captured_at, relid, relname, n_live_tup)
       values ($1, 999999, 'a_table_that_is_gone', 1)`, [oldBucket]);

    const refused = (await owner.query(METRICS_PRUNE_SQL, [3])).rows[0].r as any;
    check("a retention that would keep three days is refused with a reason",
      refused.status === "invalid" && /at least 7 days/.test(String(refused.message ?? "")),
      refused);
    check("…and it deleted nothing",
      (await owner.query(
        `select count(*)::int as n from request_timings where route = $1`,
        [`/085/verify/old/${STAMP}`])).rows[0].n === 1);

    // Typed inline rather than a bound parameter: an untyped $1 = NULL has no type for the
    // parser to resolve, and what is under test here is the guard, not the wire shape (the
    // route only ever sends a number zod has already parsed).
    const keptNull = (await owner.query("select platform_auth.prune_metrics(null::int) as r"))
      .rows[0].r as any;
    check("a null keep_days is refused the same way rather than pruning everything",
      keptNull.status === "invalid", keptNull);

    const beforePrune = (await owner.query(
      `select (select count(*)::int from service_boots) as boots,
              (select count(*)::int from pg_stat_snapshots) as snapshots`)).rows[0];
    const pruned = (await owner.query(METRICS_PRUNE_SQL, [7])).rows[0].r as any;
    check("a week is the floor it keeps, and it receipts each store it touched",
      pruned.status === "ok" && n(pruned.request_lines) === 1 && n(pruned.snapshot_lines) === 1
      && n(pruned.heartbeats) === 1 && !!pruned.cutoff, pruned);
    const afterPrune = await owner.query(
      `select (select count(*)::int from request_timings where route = $2) as old_timing,
              (select count(*)::int from request_timings where route = any($3::text[])) as probes,
              (select count(*)::int from service_heartbeats where instance = $1
                 and bucket = $4) as old_beat,
              (select count(*)::int from pg_stat_snapshots where relname = 'a_table_that_is_gone')
                as old_snapshot,
              (select count(*)::int from pg_stat_snapshots) as kept_snapshots,
              (select count(*)::int from service_boots) as boots`,
      [bootInstance, `/085/verify/old/${STAMP}`, PROBE_ROUTES, oldBucket]);
    check("the month-old lines go and every line inside the window stays",
      n(afterPrune.rows[0].old_timing) === 0
      // Seven because the long route in the mixed batch was refused outright rather than
      // stored under a truncation of it — the check in 3b is what keeps this number exact.
      && n(afterPrune.rows[0].probes) === 7
      && n(afterPrune.rows[0].old_beat) === 0 && n(afterPrune.rows[0].old_snapshot) === 0
      // One capture is one line per relation, so the kept count is the whole capture plus
      // the synthetic second end of audit_logs — and exactly one row less than before.
      && n(afterPrune.rows[0].kept_snapshots) === n(beforePrune.snapshots) - 1,
      { after: afterPrune.rows[0], before: beforePrune });
    check("…while the boot register is never pruned, because a gap needs its reason",
      n(afterPrune.rows[0].boots) === n(beforePrune.boots) && n(afterPrune.rows[0].boots) >= 15,
      { before: beforePrune.boots, after: afterPrune.rows[0].boots });

    await owner.query("rollback");
  } catch (e) {
    await owner.query("rollback").catch(() => { });
    check("the write probes rolled back cleanly", false, String(e).slice(0, 400));
  }

  const residue = await owner.query(
    `select (select count(*)::int from service_boots) as boots,
            (select count(*)::int from service_heartbeats) as beats,
            (select count(*)::int from pg_stat_snapshots) as snapshots,
            (select count(*)::int from request_timings
              where route = any($1::text[]) and route <> $2) as probes,
            (select count(*)::int from request_timings where route like '/085/verify/x/%') as junk,
            (select count(*)::int from request_timings) as timings`,
    [PROBE_ROUTES, R_FOLD]);
  check("the transaction left nothing behind: every register is back to its baseline count",
    n(residue.rows[0].boots) === n(baseline.rows[0].boots)
    && n(residue.rows[0].beats) === n(baseline.rows[0].beats)
    && n(residue.rows[0].snapshots) === n(baseline.rows[0].snapshots)
    && n(residue.rows[0].timings) === n(baseline.rows[0].timings)
    && n(residue.rows[0].probes) === 0 && n(residue.rows[0].junk) === 0,
    { residue: residue.rows[0], baseline: baseline.rows[0] });

  // ================================================================
  console.log("\n--- 4 · the advisory guards, on the store the live API writes ---");

  // What is committed here is the live collector's own line (7 requests, one of them clamped
  // to the ceiling) plus whatever real traffic an API beside this script has flushed. So each
  // guard is checked against the rule recomputed from the advisory's own inputs, which stays
  // true on the second run of this script and on the hundredth, and the positive case is
  // proved separately, on the route the probe wrote.
  const advisory = await reliabilityAdvisory(7);
  const ids = advisory.items.map((i: any) => i.item_id);
  const has = (id: string) => ids.filter((x: string) => x === id).length;
  const item = (id: string) => advisory.items.find((i: any) => i.item_id === id) as any;
  const requests = n(advisory.overall.requests);
  const p95 = n(advisory.overall.p95_ms);
  const errorRate = n(advisory.overall.error_rate) ?? 0;
  const uptime = advisory.uptime as any;
  const expected = n(uptime.expected_minutes);

  check("traffic that exists is not reported as an empty store",
    requests >= 7 && !has("latency_no_samples"), { requests, ids });
  const foldLine = (await owner.query(LATENCY_SQL, [7, 200])).rows
    .find((r: any) => r.route === R_FOLD) ?? {};
  check("the folded collector line is in the store the guards read, and is timed as a slow route",
    n(foldLine.requests) === 7 && n(foldLine.p95_ms) >= 3000 && n(foldLine.max_ms) === 600000,
    foldLine);
  check("the slow-route line exists exactly when the banded p95 passes a second, at the "
    + "priority its own threshold says",
    has("latency_p95_high") === (requests > 0 && p95 !== null && p95 >= 1000 ? 1 : 0)
    && (!has("latency_p95_high")
      || item("latency_p95_high").priority === (p95 >= 3000 ? "high" : "medium")),
    { p95, item: item("latency_p95_high") });
  check("the error-rate line stays quiet until there are a hundred requests to divide by",
    has("latency_error_rate") === (requests >= 100 && errorRate >= 1 ? 1 : 0)
    && (!has("latency_error_rate")
      || item("latency_error_rate").priority === (errorRate >= 5 ? "high" : "medium")),
    { requests, errorRate, item: item("latency_error_rate") });
  check("a missing pg_stat history is named as missing history, and says which half of that it is",
    has("bloat_no_history") === (advisory.snapshot.has_history ? 0 : 1)
    && (advisory.snapshot.has_history
      || item("bloat_no_history").title === (n(advisory.snapshot.captures) === 0
        ? "No pg_stat history has been captured yet" : "Bloat trend needs a second capture")),
    advisory.snapshot);
  check("an absent collector is reported as absent, never as 0% uptime, and never beside a gap",
    has("uptime_no_collector") === (expected === 0 && n(uptime.instances) === 0 ? 1 : 0)
    && !(has("uptime_no_collector") && has("uptime_gap"))
    && (expected !== 0 || uptime.uptime_pct === null), { expected, up: uptime, ids });
  check("…and once a collector exists the percentage is bounded and the gap line follows it",
    expected === 0
      ? n(uptime.alive_minutes) >= 0
      : uptime.uptime_pct !== null && n(uptime.uptime_pct) >= 0 && n(uptime.uptime_pct) <= 100
        && n(uptime.alive_minutes) <= expected
        && has("uptime_gap") === (expected >= 120 && n(uptime.uptime_pct) < 99 ? 1 : 0),
    { expected, up: uptime, ids });
  check("every line the desk shows has the shape the advisory screen renders",
    advisory.items.every((i: any) => typeof i.item_id === "string"
      && typeof i.title === "string" && typeof i.detail === "string"
      && ["high", "medium", "low"].includes(i.priority)
      && ["risk", "revenue", "growth", "retention", "improve"].includes(i.kind)
      && typeof i.rank === "number" && Array.isArray(i.evidence) && !!i.action
      && !!i.area && i.unit),
    advisory.items);

  // ================================================================
  console.log("\n--- 5 · the exported statements, as the role that actually runs them ---");

  const app = appUrl();
  if (!app) {
    console.log("skip  app_runtime probe (no APP_DB_PASSWORD / APP_DATABASE_URL)");
  } else {
    const runtime = new pg.Client({ connectionString: app, ssl: { rejectUnauthorized: false } });
    await runtime.connect();

    // The API's role is the one that calls the collector on every flush, in production. That
    // has to be proven as a write that lands, so it runs in a transaction that is undone.
    await runtime.query("begin");
    const wr = await runtime.query(RECORD_REQUESTS_SQL,
      [JSON.stringify([row(`/085/verify/runtime/${STAMP}`, { requests: 3, sum_ms: 300 })])]);
    await runtime.query(RECORD_BOOT_SQL, [`runtime-${STAMP}`, null, null, "verify"]);
    await runtime.query(RECORD_HEARTBEAT_SQL, [`runtime-${STAMP}`]);
    const cp = await runtime.query(SNAPSHOT_CAPTURE_SQL);
    // record_boot and record_heartbeat return void, so a rowCount proves only that the call
    // was allowed. The uptime reader is the receipt that says a line was stored.
    const heard = (await runtime.query(UPTIME_SQL, [1])).rows[0].r as any;
    // `instances` and `alive_minutes` are lower bounds, not equalities: 085's register is live
    // now, so a running API is on it too. The proof that this role's write landed is that its
    // own boot line comes back out of the reader — no other process could have written it.
    check("app_runtime can execute the collectors the API calls, and their writes land",
      receipt(wr) === 1 && (cp.rows[0]?.r as any)?.status === "ok"
      && (heard.boots as any[]).some((b: any) => b.instance === `runtime-${STAMP}`)
      && n(heard.instances) >= 1 && n(heard.alive_minutes) >= 1,
      { rows: wr.rows[0], cp: cp.rows[0]?.r, instances: heard.instances,
        alive: heard.alive_minutes, boots: heard.boots });
    // Read back through the desk's own definer: the role has no table grant, so this is also
    // the proof that the writer and the reader describe the same row.
    const seenRuntime = await runtime.query(LATENCY_SQL, [1, 200]);
    const runtimeLine = seenRuntime.rows.find((r: any) => r.route === `/085/verify/runtime/${STAMP}`);
    check("…and the reader the desk uses sees exactly what that role just wrote",
      n(runtimeLine?.requests) === 3 && runtimeLine?.method === "GET", runtimeLine);
    const prunable = await runtime.query(METRICS_PRUNE_SQL, [400]);
    check("the same role can call the pruner, and 400 days of retention deletes nothing today",
      (prunable.rows[0]?.r as any)?.status === "ok"
      && n((prunable.rows[0]?.r as any)?.request_lines) === 0
      && n((prunable.rows[0]?.r as any)?.snapshot_lines) === 0, prunable.rows[0]?.r);
    const refusedPrune = await runtime.query(METRICS_PRUNE_SQL, [1]);
    check("…and the pruner still refuses a one-day window whoever calls it",
      (refusedPrune.rows[0]?.r as any)?.status === "invalid", refusedPrune.rows[0]?.r);
    await runtime.query("rollback");

    await runtime.query("begin");
    await runtime.query("set transaction read only");
    for (const [label, sql, params] of [
      ["uptime_report", UPTIME_SQL, [7]],
      ["request_latency", LATENCY_SQL, [7, 40]],
      ["request_daily", LATENCY_DAILY_SQL, [7]],
      ["request_overall", LATENCY_OVERALL_SQL, [7]],
      ["bloat_trend", BLOAT_SQL, [30, 40]],
      ["snapshot_meta", SNAPSHOT_META_SQL, []]
    ] as [string, string, any[]][]) {
      const r = await runtime.query(sql, params).catch((e) => ({ err: String(e.message) } as any));
      check(`app_runtime can execute ${label}`, !r.err, r.err ?? "");
    }
    await runtime.query("rollback");

    for (const deniedSql of [
      "select * from service_boots limit 1",
      "select * from service_heartbeats limit 1",
      "select * from request_timings limit 1",
      "select * from pg_stat_snapshots limit 1"
    ]) {
      const denied = await runtime.query(deniedSql)
        .then(() => null).catch((e) => String(e.message));
      check(`app_runtime cannot ${deniedSql} — the definer is the only door`,
        !!denied && /permission denied/i.test(denied), denied);
    }
    for (const [label, sql] of [
      ["insert a timing line", `insert into request_timings (bucket, method, route, requests,
         sum_ms, max_ms) values (date_trunc('minute', now()),'GET','/forged',1,1,1)`],
      ["rewrite a timing line", `update request_timings set requests = 0 where true`],
      ["delete the history", `delete from pg_stat_snapshots where true`],
      ["delete a boot", `delete from service_boots where true`]
    ] as [string, string][]) {
      const denied = await runtime.query(sql).then(() => null).catch((e) => String(e.message));
      check(`app_runtime cannot ${label}`,
        !!denied && /permission denied/i.test(denied), denied);
    }
    await runtime.end();
  }

  // ================================================================
  console.log("\n--- 6 · teardown of what the live half committed ---");

  await owner.query(`delete from request_timings where route = any($1::text[])`, [PROBE_ROUTES]);
  const gone = await owner.query(
    `select count(*)::int as n from request_timings where route like '/085/verify/%'`);
  check("no probe route survives in the timing store", n(gone.rows[0].n) === 0, gone.rows[0]);
  const survivors = await owner.query(
    `select (select count(*)::int from service_boots where instance like 'probe-%'
              or instance like 'runtime-%' or instance = repeat('x', 80)) as boots,
            (select count(*)::int from service_heartbeats where instance like 'probe-%'
              or instance like 'runtime-%') as beats,
            (select count(*)::int from pg_stat_snapshots where relname = 'a_table_that_is_gone')
              as probe_snapshots,
            (select count(*)::int from pg_stat_snapshots) as snapshots`);
  check("…and the rolled-back half left nothing anywhere else either",
    n(survivors.rows[0].boots) === 0 && n(survivors.rows[0].beats) === 0
    && n(survivors.rows[0].probe_snapshots) === 0
    && n(survivors.rows[0].snapshots) === n(baseline.rows[0].snapshots), survivors.rows[0]);
  const realCollector = await owner.query(
    `select count(*)::int as n from service_boots where instance = $1`, [INSTANCE_ID]);
  console.log("note  this process is not the one the API runs; the boot line for",
    INSTANCE_ID, "is expected to be", n(realCollector.rows[0].n) === 0 ? "absent here" : "present");

  await owner.end();
  console.log(`\n${failures ? "FAILURES: " + failures : "085 verified."}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
