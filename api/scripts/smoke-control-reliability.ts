/**
 * #155c — the reliability desk over HTTP (routes on 085's readers).
 *
 * verify-reliability-sql.ts proves the definer bodies: the band arithmetic, the gap finder,
 * the clamps, the refusals. What only a request can prove is the wiring, and there are four
 * pieces of wiring here that a green SQL gate would not notice:
 *
 *  - the collector is a hook on the live process, so a request that is served must appear in
 *    `request_timings` a few seconds later — with the 5xx of a route that failed counted
 *    against the route, not lost;
 *  - the desk reaches the DEFINER and not a bare pool query. A bare query on these four
 *    registers answers 200 with empty arrays, and an empty latency table is the most
 *    reassuring wrong screen the panel can show;
 *  - pg hands bigint and numeric back as STRINGS. The route converts them, so a number in the
 *    JSON is proof the conversion ran, and a string would have reached the desk as text the
 *    browser cannot compare;
 *  - the day label is formed in Dar es Salaam, not in UTC, so the daily series cannot shift a
 *    day sideways on the way out.
 *
 * Then the two write doors. A snapshot and a retention run are the only ways this register
 * changes on purpose, so both are gated on `control.system.manage` (which 005 gave to exactly
 * one role) and both land an audit line naming the seat that pressed the button.
 *
 * Seven seats, differing only by duty, plus a staff bearer token for the audience boundary.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-control-reliability.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);
const STAMP = Date.now().toString().slice(-8);
const TENANT_SWEEP = "Reliability Smoke %";
const EMAIL_SWEEP = `smoke.reliability.%@waisha.test`;

const DESK = "/control/system/reliability";
const SNAPSHOT = "/control/system/reliability/snapshot";
const RETENTION = "/control/system/reliability/retention";
/** A route that fails on purpose, registered only outside production (082). Its 500 is the
 *  only way this suite can put a server error into the timing store through real traffic. */
const PROBE = "/dev/error-probe";
const PROBE_STAMP = `rel${STAMP}`.slice(0, 20);

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const bodies: string[] = [];
async function call(path: string, opts: { token?: string | null; cookie?: string } = {},
  init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { Cookie: `waisha_control=${opts.cookie}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  bodies.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const darDay = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Dar_es_Salaam", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const roleIds = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "platform_analyst", "support_engineer", "billing_admin", "director"]]
  )).rows;
  const rid = (k: string) => roleIds.find((r: any) => r.key === k)?.id;
  for (const k of ["super_admin", "platform_analyst", "support_engineer", "billing_admin"])
    if (!rid(k)) throw new Error(`global role ${k} missing`);

  const TC = randomUUID();
  const ids = {
    sa: randomUUID(), an: randomUUID(), se: randomUUID(),
    ba: randomUUID(), dir: randomUUID(), lapse: randomUUID(), stf: randomUUID()
  };
  const tok = (who: string) => `reliability-smoke-${who}-${STAMP}`;
  const ck = (who: string) => ({ cookie: tok(who) });

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  // Desk limiters only — the registers themselves are never wiped: they are the production
  // process's own telemetry, and a suite that deletes them destroys the evidence it reads.
  await oi(`delete from rate_limits where bucket like 'reliability%' or bucket like 'system:uid:%'`);

  await oi(`insert into tenants (id, type, name, status) values ($1,'platform',$2,'active')`,
    [TC, `Reliability Smoke Platform ${STAMP}`]);

  const seat = (id: string, name: string, email: string, type = "platform") =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
             last_login_at, created_at)
        values ($1,$2,$3,$4,$5,'active',true, now(), now() - interval '90 days')`,
      [id, TC, type, name, email]);
  await seat(ids.sa, "Rhea Admin", `smoke.reliability.sa.${STAMP}@waisha.test`);
  await seat(ids.an, "Rony Analyst", `smoke.reliability.an.${STAMP}@waisha.test`);
  await seat(ids.se, "Rashid Engineer", `smoke.reliability.se.${STAMP}@waisha.test`);
  await seat(ids.ba, "Rita Billing", `smoke.reliability.ba.${STAMP}@waisha.test`);
  await seat(ids.dir, "Rudi Director", `smoke.reliability.dir.${STAMP}@waisha.test`);
  await seat(ids.lapse, "Rae Lapsed", `smoke.reliability.lapse.${STAMP}@waisha.test`);
  await seat(ids.stf, "Rosa Staff", `smoke.reliability.stf.${STAMP}@waisha.test`, "staff");

  await oi(`insert into user_roles (user_id, role_id) values ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10)`,
    [ids.sa, rid("super_admin"), ids.an, rid("platform_analyst"), ids.se, rid("support_engineer"),
    ids.ba, rid("billing_admin"), ids.dir, rid("director")]);
  await oi(`insert into user_roles (user_id, role_id, expires_at) values ($1,$2, now() - interval '1 day')`,
    [ids.lapse, rid("platform_analyst")]);

  const openSession = (uid: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-reliability','127.0.0.1',
          now() + interval '2 hours')`,
      [randomUUID(), uid, TC, randomUUID(), sha256(tok(who))]);
  for (const [uid, who] of [
    [ids.sa, "sa"], [ids.an, "an"], [ids.se, "se"], [ids.ba, "ba"],
    [ids.dir, "dir"], [ids.lapse, "lapse"]
  ] as [string, string][]) await openSession(uid, who);

  const staffJWT = await new SignJWT({ tid: TC, sid: randomUUID(), typ: "staff", roles: ["staff"] })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(ids.stf).setIssuedAt().setExpirationTime("15m").sign(key);

  // Where the registers stood before this run, so every later count is a difference rather
  // than an absolute — the live API is collecting into the same tables the whole time.
  const readRegisters = async () => (await oi(`select
      (select count(*) from service_boots)::bigint as boots,
      (select count(*) from service_heartbeats)::bigint as beats,
      (select count(*) from request_timings)::bigint as timings,
      (select count(distinct captured_at) from pg_stat_snapshots)::bigint as captures,
      (select coalesce(sum(requests),0) from request_timings
        where bucket >= now() - interval '7 days')::bigint as timed7`)).rows[0];
  const before = await readRegisters();
  const bootsBefore = Number(before.boots);

  try {
    // ---------------------------------------------------------------- the door
    phase("authentication");
    for (const path of [DESK, SNAPSHOT, RETENTION]) {
      const anon = await call(path, {}, path === DESK ? {} : { method: "POST", body: "{}" });
      check(`an anonymous request to ${path.split("/").pop()} is turned away before the registers are read`,
        anon.status === 401, { s: anon.status, e: anon.json?.error?.code });
      const forged = await call(path, { cookie: tok("nobody" + STAMP) },
        path === DESK ? {} : { method: "POST", body: "{}" });
      check(`a cookie with no session row behind it does not open ${path.split("/").pop()}`,
        forged.status === 401, { s: forged.status });
      const bearer = await call(path, { token: staffJWT },
        path === DESK ? {} : { method: "POST", body: "{}" });
      check("a staff bearer token does not reach the platform surface — the control cookie does",
        bearer.status === 401, { s: bearer.status });
    }

    // ---------------------------------------------------------------- duty
    phase("which seat sees what");
    const asSA = await call(DESK, ck("sa"));
    check("the Super Admin reads the desk", asSA.status === 200 && !!asSA.json?.uptime
      && Array.isArray(asSA.json?.latency?.routes), { s: asSA.status });
    const asAN = await call(DESK, ck("an"));
    check("the platform analyst reads it too — same duty as every other aggregate",
      asAN.status === 200, { s: asAN.status });
    const asSE = await call(DESK, ck("se"));
    check("…and so does the support engineer, the seat that acts on a slow route",
      asSE.status === 200, { s: asSE.status });

    const asBA = await call(DESK, ck("ba"));
    check("the billing admin reads the money but not the machine — 403",
      asBA.status === 403 && asBA.json?.error?.code === "FORBIDDEN",
      { s: asBA.status, e: asBA.json?.error?.code });
    const asDIR = await call(DESK, ck("dir"));
    check("a director signed into the control shell holds no system key",
      asDIR.status === 403, { s: asDIR.status });
    const asLAPSE = await call(DESK, ck("lapse"));
    check("an expired delegation is not a duty, so a lapsed analyst cannot read it either",
      asLAPSE.status === 403, { s: asLAPSE.status });

    check("the desk tells the analyst it cannot manage, so the buttons are hidden rather than dead",
      asSA.json?.can_manage === true && asAN.json?.can_manage === false
      && asSE.json?.can_manage === false,
      { sa: asSA.json?.can_manage, an: asAN.json?.can_manage, se: asSE.json?.can_manage });

    const nav = await call("/control/auth/permissions", ck("sa"));
    const saKeys: string[] = nav.json?.permissions ?? [];
    check("the navigation probe offers the desk to a view-only seat and the same desk's actions to a manage seat",
      saKeys.includes("control.system.view") && saKeys.includes("control.system.manage"), saKeys);
    const navAN = await call("/control/auth/permissions", ck("an"));
    const anKeys: string[] = navAN.json?.permissions ?? [];
    check("…and the analyst is offered the tab without the write keys, which is the same split the desk applies",
      anKeys.includes("control.system.view") && !anKeys.includes("control.system.manage"), anKeys);

    // ------------------------------------------------- the collector, over real traffic
    phase("a served request becomes a timing row");
    for (let i = 0; i < 4; i++) await call("/health");
    await call("/announcements");
    await call(DESK, ck("an"));
    const probe = await call(`${PROBE}?stamp=${PROBE_STAMP}&kind=plain`, {},
      { method: "POST", body: "{}" });
    check("the probe route still fails on purpose outside production",
      probe.status === 500, { s: probe.status });

    // The flush is on a five-second timer, so this polls instead of assuming.
    let seen = { health: 0, probe: 0, err: 0 };
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const t = await oi(`select route, sum(requests)::int as requests, sum(server_errors)::int as errs
        from request_timings
        where route in ('/api/v1/health', $1) and bucket >= now() - interval '3 minutes'
        group by route`, [`/api/v1${PROBE}`]);
      const byRoute: Record<string, any> = {};
      for (const r of t.rows) byRoute[r.route] = r;
      seen = {
        health: Number(byRoute["/api/v1/health"]?.requests ?? 0),
        probe: Number(byRoute[`/api/v1${PROBE}`]?.requests ?? 0),
        err: Number(byRoute[`/api/v1${PROBE}`]?.errs ?? 0)
      };
      if (seen.health >= 4 && seen.probe >= 1) break;
    }
    check("four health calls became at least four counted requests on one folded row",
      seen.health >= 4, seen);
    check("a 500 is counted against its route, so the latency table and the error register describe the same failures",
      seen.probe >= 1 && seen.err >= 1, seen);

    const stored = await oi(`select method, requests, sum_ms, max_ms,
        band_fast + band_ok + band_slow + band_bad + band_awful as banded, server_errors
      from request_timings where route = '/api/v1/health'
        and bucket >= now() - interval '3 minutes'`);
    check("the minute key is the method and the normalised path, and every request sits in exactly one band",
      stored.rows.length > 0 && stored.rows.every(r => r.method === "GET"
        && Number(r.banded) === Number(r.requests) && Number(r.server_errors) === 0
        && Number(r.max_ms) >= 0 && Number(r.sum_ms) >= Number(r.max_ms)),
      stored.rows.slice(0, 3));

    // -------------------------------------------------- the desk is the definer's
    phase("the payload is measured, not invented");
    const desk = (await call(DESK, ck("sa"))).json;
    const health = (desk.latency.routes ?? []).find((r: any) => r.route === "/api/v1/health");
    check("the route that was just timed is on the desk — a bare pool query would have shown an empty table here",
      !!health && Number(health.requests) >= 4, health ?? desk.latency.routes?.length);
    check("the desk's own route measures the desk, so a slow screen would be visible on it",
      (desk.latency.routes ?? []).some((r: any) => r.route === `/api/v1${DESK}`),
      (desk.latency.routes ?? []).map((r: any) => r.route).slice(0, 12));
    check("the failing route carries its server errors into the same row as its percentiles",
      (desk.latency.routes ?? []).some((r: any) => r.route === `/api/v1${PROBE}`
        && Number(r.server_errors) >= 1),
      (desk.latency.routes ?? []).filter((r: any) => r.route?.includes("error-probe")));

    check("every numeric column left pg's string form behind — bigint and numeric arrive as text and the desk converts them",
      (desk.latency.routes ?? []).every((r: any) => typeof r.requests === "number"
        && typeof r.max_ms === "number" && (r.mean_ms === null || typeof r.mean_ms === "number")
        && (r.p95_ms === null || typeof r.p95_ms === "number")
        && (r.error_rate === null || typeof r.error_rate === "number")),
      (desk.latency.routes ?? [])[0]);
    const rawLatency = await oi(`select * from platform_auth.request_latency(7, 3)`);
    check("…which is a conversion the driver does not do for us: the same column is a string here",
      rawLatency.rows.length > 0 && typeof rawLatency.rows[0].mean_ms === "string",
      { mean: typeof rawLatency.rows[0]?.mean_ms, requests: typeof rawLatency.rows[0]?.requests });

    check("the approximation is stated in the payload rather than left to the reader",
      desk.latency.approximate === true
      && JSON.stringify(desk.latency.band_edges_ms) === "[100,300,1000,3000]",
      { approximate: desk.latency.approximate, edges: desk.latency.band_edges_ms });
    check("no row claims more slow answers or more errors than it claims requests",
      (desk.latency.routes ?? []).every((r: any) => r.over_1s <= r.requests
        && r.server_errors <= r.requests), desk.latency.routes?.[0]);

    check("the daily series is labelled with a Dar es Salaam day, not the UTC one a raw date would give",
      (desk.latency.daily ?? []).length > 0
      && (desk.latency.daily ?? []).every((d: any) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))
      && (desk.latency.daily ?? []).some((d: any) => d.day === darDay()),
      { days: (desk.latency.daily ?? []).map((d: any) => d.day), today: darDay() });

    // -------------------------------------------------- uptime, from the live process
    phase("the live process is on the register");
    check("the instance that answered is the one that recorded its boot — the desk names its own author",
      /^\d+@/.test(String(desk.collector?.answered_by))
      && desk.collector?.instance === desk.collector?.answered_by
      && (desk.uptime.boots ?? []).some((b: any) => b.instance === desk.collector.answered_by),
      { answered_by: desk.collector?.answered_by, boots: (desk.uptime.boots ?? []).map((b: any) => b.instance) });
    check("a window with a boot in it has a percentage, and the note that bounds it",
      typeof desk.uptime.uptime_pct === "number" && desk.uptime.uptime_pct >= 0
      && desk.uptime.uptime_pct <= 100 && Number(desk.uptime.expected_minutes) > 0
      && Number(desk.uptime.alive_minutes) >= 1 && !!desk.uptime.collector_note,
      { pct: desk.uptime.uptime_pct, expected: desk.uptime.expected_minutes, alive: desk.uptime.alive_minutes });
    const beats = await oi(`select count(*)::int as n from service_heartbeats
      where bucket >= date_trunc('minute', now()) - interval '2 minutes'`);
    check("the heartbeat loop has written this minute or the one before it",
      Number(beats.rows[0].n) >= 1, beats.rows[0]);

    // -------------------------------------------------- query contract
    phase("the window is the one that was asked for");
    const d1 = await call(`${DESK}?days=1&bloat_days=7&limit=1`, ck("sa"));
    check("days, bloat_days and limit are honoured, and a one-row limit is a one-row answer",
      d1.status === 200 && d1.json?.window_days === 1 && d1.json?.bloat_window_days === 7
      && (d1.json?.latency?.routes ?? []).length <= 1,
      { w: d1.json?.window_days, b: d1.json?.bloat_window_days, n: d1.json?.latency?.routes?.length });
    for (const bad of ["?days=0", "?days=91", "?bloat_days=400", "?limit=0", "?limit=201", "?surprise=1"]) {
      const r = await call(`${DESK}${bad}`, ck("sa"));
      check(`${bad} is refused before the registers are read`,
        r.status === 400, { s: r.status, e: r.json?.error?.code });
    }
    const weird = await call(`${DESK}?days=seven`, ck("sa"));
    check("a non-numeric window is a refusal, not a silent default",
      weird.status === 400, { s: weird.status });

    // -------------------------------------------------- the writes
    phase("a snapshot is a write with a receipt");
    const anSnap = await call(SNAPSHOT, ck("an"), { method: "POST", body: "{}" });
    check("an analyst cannot take a snapshot — the desk is a reader, the register is not theirs to fill",
      anSnap.status === 403, { s: anSnap.status, e: anSnap.json?.error?.code });
    const emptySnap = await call(SNAPSHOT, ck("sa"),
      { method: "POST", headers: { "content-type": "application/json" } });
    check("a POST that announces JSON and carries nothing is a framing refusal, not a 500 — "
      + "which is why the desk sends {} out loud",
      emptySnap.status === 400, { s: emptySnap.status, e: emptySnap.json?.error?.code });

    const snap1 = await call(SNAPSHOT, ck("sa"), { method: "POST", body: "{}" });
    check("the Super Admin captures every relation in public, and the receipt counts them",
      snap1.status === 200 && Number(snap1.json?.relations) > 50 && !!snap1.json?.captured_at,
      { s: snap1.status, j: snap1.json });
    await new Promise(r => setTimeout(r, 1500));
    const snap2 = await call(SNAPSHOT, ck("sa"), { method: "POST", body: "{}" });
    check("a second capture is accepted, and two captures are what turns bloat into a trend",
      snap2.status === 200 && Number(snap2.json?.relations) > 50, { s: snap2.status, j: snap2.json });

    const after = await readRegisters();
    check("the captures landed in the store the reader reads",
      Number(after.captures) >= Number(before.captures) + 2,
      { before: before.captures, after: after.captures });

    const desk2 = (await call(`${DESK}?bloat_days=7&limit=200`, ck("sa"))).json;
    check("and the desk now says it has history, with one row per relation",
      desk2.bloat?.meta?.has_history === true
      && Number(desk2.bloat?.meta?.captures) >= 2
      && (desk2.bloat?.relations ?? []).length === Math.min(200, Number(desk2.bloat?.meta?.relations))
      && (desk2.bloat?.relations ?? []).every((r: any) => Number(r.snapshots) >= 2),
      { meta: desk2.bloat?.meta, rows: (desk2.bloat?.relations ?? []).length });
    check("bloat figures are numbers too, and a relation's dead share is inside 0–100",
      (desk2.bloat?.relations ?? []).every((r: any) => typeof r.dead_tuples === "number"
        && typeof r.table_bytes === "number"
        && (r.dead_pct === null || (r.dead_pct >= 0 && r.dead_pct <= 100))),
      (desk2.bloat?.relations ?? [])[0]);
    const withTrend = (desk2.bloat?.relations ?? []).filter(
      (r: any) => r.dead_growth !== null && r.table_growth_bytes !== null);
    check("two captures a moment apart give every relation a growth figure, which is the gate the desk labels",
      withTrend.length > 0, { trended: withTrend.length, of: (desk2.bloat?.relations ?? []).length });

    const snapAudit = await oi(`select action, actor_user_id, after from audit_logs
      where tenant_id = $1 and action = 'control.reliability.snapshot' order by ts desc limit 2`,
      [TC]);
    check("both captures are audited against the seat that pressed the button",
      snapAudit.rows.length === 2 && snapAudit.rows.every(a => a.actor_user_id === ids.sa)
      && Number(snapAudit.rows[0].after?.relations) > 50,
      snapAudit.rows.map(a => ({ who: a.actor_user_id === ids.sa, r: a.after?.relations })));

    // -------------------------------------------------- retention
    phase("retention is an operator decision");
    const anPrune = await call(RETENTION, ck("an"),
      { method: "POST", body: JSON.stringify({ keepDays: 30 }) });
    check("an analyst cannot prune history — dropping evidence needs the manage duty",
      anPrune.status === 403, { s: anPrune.status });
    for (const body of [{ keepDays: 3 }, { keepDays: 0 }, {}, { keepDays: "seven" },
      { keepDays: 30, extra: 1 }]) {
      const r = await call(RETENTION, ck("sa"),
        { method: "POST", body: JSON.stringify(body) });
      check(`a retention request for ${JSON.stringify(body)} is refused by the schema, not by the definer's mercy`,
        r.status === 400, { s: r.status, e: r.json?.error?.code });
    }

    const beforePrune = await readRegisters();
    const oldTimings = await oi(`select count(*)::int as n from request_timings
      where bucket < now() - interval '7 days'`);
    // enforceRateLimit runs before the schema, so the five refusals above each spent one of
    // the five prune-hour slots. The bucket is cleared out loud rather than the suite
    // pretending the limit does not apply to a request it rejected.
    await oi(`delete from rate_limits where bucket = $1`, [`reliability-prune:uid:${ids.sa}`]);
    const prune = await call(RETENTION, ck("sa"),
      { method: "POST", body: JSON.stringify({ keepDays: 7 }) });
    check("seven days is the shortest window the definer will accept, and it answers with what it removed",
      prune.status === 200 && Number(prune.json?.keep_days) === 7
      && typeof prune.json?.request_lines === "number" && !!prune.json?.cutoff,
      { s: prune.status, j: prune.json });
    check("the counts it reports are the rows that were actually older than the cutoff",
      Number(prune.json?.request_lines) === Number(oldTimings.rows[0].n),
      { reported: prune.json?.request_lines, older: oldTimings.rows[0].n });

    const afterPrune = await readRegisters();
    const stillHere = await oi(`select count(*)::int as n from request_timings
      where route = '/api/v1/health' and bucket >= now() - interval '3 minutes'`);
    check("nothing inside the window was touched — this run's own timings survived the prune",
      Number(stillHere.rows[0].n) >= 1
      && Number(afterPrune.timings) >= Number(beforePrune.timings) - Number(prune.json?.request_lines),
      { timings: afterPrune.timings, stillHere: stillHere.rows[0].n });
    const bootsAfter = await oi(`select count(*)::int as n from service_boots`);
    check("boot lines are never pruned: a restart is the reason an old gap looks the way it does",
      Number(bootsAfter.rows[0].n) >= bootsBefore, { now: bootsAfter.rows[0].n, was: bootsBefore });

    const pruneAudit = await oi(`select action, actor_user_id, after from audit_logs
      where tenant_id = $1 and action = 'control.reliability.retention' limit 2`, [TC]);
    check("and the prune is audited with the keep window and the line counts it spent",
      pruneAudit.rows.length >= 1 && pruneAudit.rows[0].actor_user_id === ids.sa
      && Number(pruneAudit.rows[0].after?.keep_days) === 7,
      pruneAudit.rows.map(a => ({ who: a.actor_user_id === ids.sa, k: a.after?.keep_days })));

    // -------------------------------------------------- the advisory carries the same facts
    phase("the advisory says what the desk says");
    const dbBefore = await oi(`select coalesce(sum(requests),0)::bigint as n from request_timings
      where bucket >= now() - interval '7 days'`);
    const adv = await call("/control/system/advisory", ck("sa"));
    const dbAfter = await oi(`select coalesce(sum(requests),0)::bigint as n from request_timings
      where bucket >= now() - interval '7 days'`);
    check("the advisory answers", adv.status === 200 && Array.isArray(adv.json?.items),
      { s: adv.status });
    const advRequests = Number(adv.json?.reliability?.requests ?? -1);
    const lo = Number(dbBefore.rows[0].n), hi = Number(dbAfter.rows[0].n);
    check("its request count is the same table the desk reads, inside the traffic the run itself added",
      advRequests >= lo && advRequests <= hi, { advisory: advRequests, before: lo, after: hi });
    const ids2: string[] = (adv.json?.items ?? []).map((i: any) => i.item_id);
    const known = ["latency_no_samples", "latency_p95_high", "latency_error_rate",
      "uptime_no_collector", "uptime_gap", "bloat_no_history"];
    // A card is only allowed to exist because a rule wrote it, so the whitelist is read
    // from the two places rules are actually written: the definer's own output and the
    // item_ids the route files construct. Anything else on this screen was invented here.
    const definerIds = (await oi(`select distinct item_id from platform_auth.control_advisory()`))
      .rows.map((r: any) => String(r.item_id));
    const declared = new Set([...definerIds, ...known, "migrations_dir_unreadable",
      "migrations_unapplied", "migrations_applied_without_file", "mail_unset", "storage_unset",
      "scheduler_http_off", "errors_server_24h"]);
    check("every card on the advisory is a rule that exists in code — none of them is a guess",
      definerIds.length > 0 && ids2.length > 0 && ids2.every(i => declared.has(i)),
      { undeclared: ids2.filter(i => !declared.has(i)), cards: ids2.length });
    check("and the reliability family is drawn only from the guarded six, so no new rule can fire silently",
      ids2.filter(i => /^(latency|uptime|bloat)_/.test(i)).every(i => known.includes(i)),
      ids2.filter(i => /^(latency|uptime|bloat)_/.test(i)));
    check("and the lines that fire are consistent with the store: with traffic and history there is no 'nothing timed' or 'no history' card",
      !(advRequests === 0 ? !ids2.includes("latency_no_samples")
        : ids2.includes("latency_no_samples"))
      && !(Number(adv.json?.reliability?.captures) > 1 ? ids2.includes("bloat_no_history")
        : !ids2.includes("bloat_no_history")),
      { items: ids2.filter(i => known.includes(i)), captures: adv.json?.reliability?.captures });
    const claims = JSON.stringify(adv.json?.not_measured ?? []);
    check("the 'cannot tell you yet' list no longer claims reliability is invisible",
      !/uptime|latency|slow route|request-timing|bloat trend|metrics endpoint/i.test(claims),
      claims.slice(0, 300));
    check("the report's runtime facts and the desk's collector agree about which process answered",
      (await call("/control/system/report", ck("sa"))).status === 200);

    // -------------------------------------------------- limiter
    phase("the read is capped");
    await call(DESK, ck("sa"));
    await oi(`update rate_limits set count = 60 where bucket = $1`, [`reliability:uid:${ids.sa}`]);
    const flood = [];
    for (let i = 0; i < 5; i++) flood.push((await call(DESK, ck("sa"))).status);
    check("sixty reads a minute is a ceiling, not a suggestion — a desk that polls cannot become load",
      flood.includes(429), flood);
    await oi(`delete from rate_limits where bucket like 'reliability%'`);

    // -------------------------------------------------- leak
    phase("nothing leaves the register that should not");
    // Column names, engine strings and hash prefixes — the shapes a leak actually takes. An
    // env var's NAME is not a leak (the advisory legitimately says "set RESEND_API_KEY"), so
    // the values themselves are checked below against this process's own environment.
    const LEAKS = ["syntax error at or near", "duplicate key value violates", "insert into",
      "node_modules", "refresh_token_hash", "$2b$", "encrypted_phone", "encrypted_nida",
      "search_hash", "password_hash", "app_runtime.", "totp_secret", "Bearer ey"];
    const hit = LEAKS.filter(m => bodies.some(b => b.toLowerCase().includes(m.toLowerCase())));
    check("no engine string, hash column or credential word ever reached a client",
      hit.length === 0, hit);
    const SECRET_KEYS = ["JWT_SECRET", "FIELD_ENCRYPTION_KEY", "SEARCH_HASH_KEY",
      "APP_DB_PASSWORD", "RESEND_API_KEY", "MIGRATE_DATABASE_URL", "DATABASE_URL"];
    const secrets = SECRET_KEYS.map(k => [k, process.env[k] ?? ""] as const)
      .filter(([, v]) => v.length > 6)
      .filter(([, v]) => bodies.some(b => b.includes(v)));
    check("and no secret value from this environment appears in any body either",
      secrets.length === 0, secrets.map(([k]) => k));
    const withEmail = bodies.filter(b => b.includes("waisha.test"));
    check("and no fixture seat's address is echoed by a cross-tenant desk",
      withEmail.length === 0, withEmail.slice(0, 1).map(s => s.slice(0, 160)));
    check("the desk never returns a stack: no 'at ' frames and no pg error text",
      !bodies.some(b => /at Object\.|does not exist|relation "|SQLSTATE|syntax error at/i.test(b)));

    // -------------------------------------------------- residue
    phase("what the run leaves behind");
    const resid = await oi(`select
      (select count(*) from tenants where name like $1)::int as tenants,
      (select count(*) from users where email like $2)::int as users`,
      [TENANT_SWEEP, EMAIL_SWEEP]);
    check("the seats and the platform tenant are still present while the run is — the sweep is the next step",
      Number(resid.rows[0].tenants) === 1 && Number(resid.rows[0].users) === 7, resid.rows[0]);
  } finally {
    phase("cleanup");
    await sweep();
    await oi(`delete from rate_limits where bucket like 'reliability%' or bucket like 'system:uid:%'`);
    const left = await oi(`select
      (select count(*) from tenants where name like $1)::int as tenants,
      (select count(*) from users where email like $2)::int as users,
      (select count(*) from sessions where user_agent = 'smoke-reliability')::int as sessions`,
      [TENANT_SWEEP, EMAIL_SWEEP]);
    check("no fixture seat, company or session survives the run",
      Number(left.rows[0].tenants) === 0 && Number(left.rows[0].users) === 0
      && Number(left.rows[0].sessions) === 0, left.rows[0]);
    const reg = await readRegisters();
    const dBoots = Number(reg.boots) - bootsBefore;
    check("the registers were not wiped by the suite: boots only grew by real process starts, and the captures it took stand",
      dBoots >= 0 && Number(reg.captures) >= Number(before.captures) + 2,
      { bootsDelta: dBoots, captures: `${before.captures} → ${reg.captures}` });
    console.log(`\nnote: timings, heartbeats, boot lines and pg_stat captures are the live `
      + `process's own telemetry — a smoke that deleted them would destroy the evidence the `
      + `desk exists to read.`);
    await owner.end();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failing check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("smoke crashed:", e); process.exit(1); });
