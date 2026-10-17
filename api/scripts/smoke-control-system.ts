/**
 * The machine room over HTTP — smoke for #117 (routes on 069's readers).
 *
 * The verify script proves the SQL. This proves the four things only a request can
 * prove: that the route reaches the SECURITY DEFINER rather than a bare pool query
 * (which would answer 200 with zeros, the most dangerous shape in this product), that
 * the duty gate is the seeded matrix and not the role keys in the session, that a
 * lapsed delegation is neither a duty nor a permission here either, and that the two
 * halves of one screen — the database's report and this process's own facts — actually
 * arrive together.
 *
 * Seven seats, differing only by duty: a Super Admin, an analyst, the support engineer
 * who fixes faults, a billing admin who reads the money but not the machine, a service
 * agent with neither key, a director with no control key at all, and an analyst whose
 * delegation has lapsed. Plus a staff-type account with a real bearer token, because the
 * audience boundary is a door and this desk sits behind it.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-control-system.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);
const STAMP = Date.now().toString().slice(-8);
const TENANT_SWEEP = "System Smoke %";
const EMAIL_SWEEP = `smoke.system.%@waisha.test`;

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

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const roleIds = (await oi(
    `select id, key from roles where tenant_id is null
       and key = any($1)`,
    [["super_admin", "platform_analyst", "support_engineer", "billing_admin",
      "customer_service_agent", "director"]]
  )).rows;
  const rid = (k: string) => roleIds.find((r: any) => r.key === k)?.id;
  for (const k of ["super_admin", "platform_analyst", "support_engineer", "billing_admin"])
    if (!rid(k)) throw new Error(`global role ${k} missing`);

  const TC = randomUUID();
  const uSA = randomUUID();
  const uAN = randomUUID();
  const uSE = randomUUID();
  const uBA = randomUUID();
  const uCS = randomUUID();
  const uDIR = randomUUID();
  const uLAPSE = randomUUID();
  const uSTF = randomUUID();

  const tok = (who: string) => `system-smoke-${who}-${STAMP}`;
  const ck = (who: string) => ({ cookie: tok(who) });
  const allUsers = [uSA, uAN, uSE, uBA, uCS, uDIR, uLAPSE, uSTF];

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
      await oi(`delete from rate_limits where bucket like 'system:uid:%'`).catch(() => { });
    }
    await oi(`delete from roles where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await oi(`delete from rate_limits where bucket like 'system:uid:%'`);

  // ---------------- fixtures ----------------
  await oi(`insert into tenants (id, type, name, status) values ($1,'platform',$2,'active')`,
    [TC, `System Smoke Platform ${STAMP}`]);

  const seat = (id: string, name: string, email: string, type = "platform") =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
             last_login_at, created_at)
        values ($1,$2,$3,$4,$5,'active',true, now(), now() - interval '90 days')`,
      [id, TC, type, name, email]);
  await seat(uSA, "Sima Admin", `smoke.system.sa.${STAMP}@waisha.test`);
  await seat(uAN, "Annie Analyst", `smoke.system.an.${STAMP}@waisha.test`);
  await seat(uSE, "Sam Engineer", `smoke.system.se.${STAMP}@waisha.test`);
  await seat(uBA, "Bella Billing", `smoke.system.ba.${STAMP}@waisha.test`);
  await seat(uCS, "Cally Service", `smoke.system.cs.${STAMP}@waisha.test`);
  await seat(uDIR, "Daudi Director", `smoke.system.dir.${STAMP}@waisha.test`);
  await seat(uLAPSE, "Lapsed Annie", `smoke.system.lapse.${STAMP}@waisha.test`);
  await seat(uSTF, "Staff Not On Desk", `smoke.system.stf.${STAMP}@waisha.test`, "staff");

  await oi(`insert into user_roles (user_id, role_id) values
      ($1,$2), ($3,$4), ($5,$6), ($7,$8), ($9,$10), ($11,$12)`,
    [uSA, rid("super_admin"), uAN, rid("platform_analyst"), uSE, rid("support_engineer"),
      uBA, rid("billing_admin"), uCS, rid("customer_service_agent"), uDIR, rid("director")]);
  // Same duty, already expired: on 066/067/068 a lapsed delegation counts for nothing,
  // and the new key must behave the same way here.
  await oi(`insert into user_roles (user_id, role_id, expires_at)
            values ($1,$2, now() - interval '1 day')`, [uLAPSE, rid("platform_analyst")]);

  const openSession = (uid: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-control-system',$6,
          now() + interval '2 hours')`,
      [randomUUID(), uid, TC, randomUUID(), sha256(tok(who)), "127.0.0.1"]);
  for (const [uid, who] of [
    [uSA, "sa"], [uAN, "an"], [uSE, "se"], [uBA, "ba"], [uCS, "cs"],
    [uDIR, "dir"], [uLAPSE, "lapse"]
  ] as [string, string][]) await openSession(uid, who);

  const mint = async (sub: string, roles: string[]) =>
    new SignJWT({ tid: TC, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);
  const staffJWT = await mint(uSTF, ["staff"]);

  const uids = allUsers;
  try {
    // ---------------- the door ----------------
    phase("authentication");
    for (const path of ["/control/system/report", "/control/system/advisory"]) {
      const anon = await call(path);
      check(`an anonymous request to ${path.split("/").pop()} is turned away before the catalog is read`,
        anon.status === 401, { s: anon.status, e: anon.json?.error?.code });
      const forged = await call(path, { cookie: tok("nobody" + STAMP) });
      check(`a cookie with no session row behind it does not open ${path.split("/").pop()}`,
        forged.status === 401, { s: forged.status });
      const bearer = await call(path, { token: staffJWT });
      check("a staff bearer token does not reach the platform surface — the cookie does",
        bearer.status === 401, { s: bearer.status });
    }

    // ---------------- whose duty is which ----------------
    phase("three seats read the machine room");
    const asSA = await call("/control/system/report", ck("sa"));
    check("the Super Admin reads the technical report",
      asSA.status === 200 && !!asSA.json?.shape && !!asSA.json?.posture, { s: asSA.status });
    const asAN = await call("/control/system/report", ck("an"));
    check("the analyst reads it too — the same duty that reads every other aggregate",
      asAN.status === 200, { s: asAN.status });
    const asSE = await call("/control/system/report", ck("se"));
    check("…and so does the support engineer, the seat that fixes what this report finds, "
      + "which 068 kept off the money on purpose", asSE.status === 200, { s: asSE.status });

    phase("four seats may not");
    const asBA = await call("/control/system/report", ck("ba"));
    check("the billing admin reads the revenue registers but not the machine room — 403",
      asBA.status === 403 && asBA.json?.error?.code === "FORBIDDEN",
      { s: asBA.status, e: asBA.json?.error?.code });
    const baAdv = await call("/control/system/advisory", ck("ba"));
    check("…and the advisory is the same duty, not a separate favour",
      baAdv.status === 403, { s: baAdv.status });
    const asCS = await call("/control/system/report", ck("cs"));
    check("customer service is not on this desk at all", asCS.status === 403, { s: asCS.status });
    const asDIR = await call("/control/system/report", ck("dir"));
    check("a director signed into the control shell holds no system key",
      asDIR.status === 403, { s: asDIR.status });
    const asLAPSE = await call("/control/system/report", ck("lapse"));
    check("an expired delegation is not a duty, so a lapsed analyst cannot read it either",
      asLAPSE.status === 403, { s: asLAPSE.status });

    const nav = await call("/control/auth/permissions", ck("ba"));
    const baKeys: string[] = nav.json?.permissions ?? [];
    check("the navigation probe reports the two keys apart, so ControlNav cannot hide a "
      + "desk a seat holds or show one it does not",
      baKeys.includes("control.subscriptions.view") && !baKeys.includes("control.system.view"),
      baKeys.filter(k => k.startsWith("control.")));
    const navSA = await call("/control/auth/permissions", ck("sa"));
    check("…and the Super Admin is offered the System tab",
      (navSA.json?.permissions ?? []).includes("control.system.view"),
      navSA.json?.permissions);

    // ---------------- the report itself ----------------
    phase("the report is the definer's, not an RLS-blind query");
    const rep = asSA.json;
    check("a cross-tenant catalog read answers with real numbers — a bare pool.query would "
      + "have returned 200 and zeros",
      Number(rep.shape?.tables) > 50 && Number(rep.shape?.functions) > 20
      && Number(rep.modules?.companies) > 0,
      { tables: rep.shape?.tables, functions: rep.shape?.functions, companies: rep.modules?.companies });
    check("the schema's own shape is counted, not described",
      ["tables", "views", "indexes", "triggers", "functions"].every(k => typeof rep.shape?.[k] === "number"),
      Object.keys(rep.shape ?? {}));
    check("isolation facts are lists the panel can show or hide",
      ["tenant_tables_without_rls", "rls_without_policy", "definer_public_reachable",
        "definer_without_search_path"].every(k => Array.isArray(rep.posture?.[k])),
      Object.fromEntries(Object.entries(rep.posture ?? {})
        .filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as any[]).length])));
    check("the report says what it cannot say, and names the audit partition gap",
      Array.isArray(rep.caveats) && rep.caveats.length === 6 &&
      rep.caveats.some((c: string) => /audit_logs/i.test(c)), rep.caveats?.length);

    phase("both halves arrive together");
    check("the process facts ride along with the database facts, because drift needs both",
      typeof rep.runtime?.node === "string" && typeof rep.runtime?.pid === "number"
      && /^\d{4}-\d{2}-\d{2}T/.test(String(rep.runtime?.started_at)) &&
      typeof rep.runtime?.readiness?.mail_configured === "boolean",
      rep.runtime);
    check("readiness is reported as booleans and provider names — never as a value",
      Object.entries(rep.runtime?.readiness ?? {})
        .every(([, v]) => typeof v === "boolean" || typeof v === "string") &&
      !Object.values(rep.runtime?.readiness ?? {}).some(v => typeof v === "string" && v.length > 40),
      rep.runtime?.readiness);
    check("the migration directory was found from this process and nothing on disk is unapplied",
      rep.migrations?.dir_found === true && rep.migrations?.unapplied?.length === 0
      && rep.migrations?.applied_without_file?.length === 0,
      { dir: rep.migrations?.dir_found, unapplied: rep.migrations?.unapplied,
        missing: rep.migrations?.applied_without_file });
    const dbApplied = (await oi(`select count(*)::int as n from schema_migrations`)).rows[0].n;
    check(`the two clocks agree: the database says ${dbApplied} applied, the disk says `
      + `${rep.migrations?.files_on_disk} files, the reader says ${rep.migrations?.applied}`,
      Number(rep.migrations?.applied) === dbApplied
      && Number(rep.migrations?.files_on_disk) === dbApplied,
      { db: dbApplied, disk: rep.migrations?.files_on_disk, reader: rep.migrations?.applied });
    check("069 is recorded in the database's own bookkeeping, which is what the disk is "
      + "diffed against",
      (await oi(`select 1 from schema_migrations
        where name = '069_control_system_report_and_advisory.sql'`)).rowCount === 1);

    // ---------------- the advisory ----------------
    phase("the advisory");
    const adv = (await call("/control/system/advisory", ck("sa"))).json;
    check("it answers with a total, the two breakdowns, the items and the limits",
      typeof adv?.total === "number" && Array.isArray(adv?.items) &&
      adv?.by_priority && adv?.by_kind && Array.isArray(adv?.not_measured),
      { keys: Object.keys(adv ?? {}) });
    check("the counts add up to the list it returned",
      adv.total === adv.items.length &&
      Object.values(adv.by_priority).reduce((s: number, n: any) => s + Number(n), 0) === adv.total &&
      Object.values(adv.by_kind).reduce((s: number, n: any) => s + Number(n), 0) === adv.total,
      { total: adv.total, by_priority: adv.by_priority, by_kind: adv.by_kind });
    check("items arrive sorted by rank, so the panel's first line is its most urgent",
      adv.items.every((i: any, n: number) => n === 0 || adv.items[n - 1].rank <= i.rank),
      adv.items.map((i: any) => i.rank));
    check("every item is a complete sentence: finding, number, unit, action",
      adv.items.every((i: any) => i.item_id && i.title && i.detail && i.action && i.area &&
        ["risk", "revenue", "growth", "retention", "improve"].includes(i.kind) &&
        ["high", "medium", "low"].includes(i.priority) && Array.isArray(i.evidence)),
      adv.items.filter((i: any) => !i.action).map((i: any) => i.item_id));
    check("metric is a number or null — never a string a total was concatenated out of",
      adv.items.every((i: any) => i.metric === null || typeof i.metric === "number"),
      adv.items.map((i: any) => typeof i.metric));
    check("the P&L caveat is on the screen rather than buried in a migration comment",
      adv.not_measured.length === 6 &&
      adv.not_measured.some((x: any) => /churn/i.test(x.thing)) &&
      adv.not_measured.some((x: any) => /uptime|latency/i.test(x.thing)) &&
      adv.not_measured.every((x: any) => (x.why ?? "").length > 40),
      adv.not_measured.map((x: any) => x.thing));

    check("the advisory and the report tell the same story about isolation",
      !adv.items.some((i: any) => i.item_id === "rls_missing")
      === ((rep.posture?.tenant_tables_without_rls ?? []).length === 0)
      && !adv.items.some((i: any) => i.item_id === "definer_exposed")
      === ((rep.posture?.definer_public_reachable ?? []).length === 0),
      { fired: adv.items.map((i: any) => i.item_id).filter((x: string) => x.includes("rls") || x.includes("definer")),
        posture: rep.posture?.tenant_tables_without_rls });

    const again = await call("/control/system/report", ck("sa"));
    check("a second read is stable — the report is a fact, not a roll of the dice",
      again.status === 200 && again.json?.shape?.tables === rep.shape?.tables &&
      again.json?.runtime?.pid === rep.runtime?.pid,
      { a: rep.shape?.tables, b: again.json?.shape?.tables });

    // ---------------- the limiter is per seat ----------------
    phase("rate limit");
    const buckets = (await oi(
      `select distinct bucket from rate_limits where bucket like 'system:uid:%'`)).rows
      .map(r => r.bucket as string);
    check("the bucket is keyed on the seat, so one analyst's refresh loop cannot close the "
      + "desk for the whole office — and only the three seats that passed the gate have one",
      buckets.length === 3 && [uSA, uAN, uSE].every(u => buckets.includes(`system:uid:${u}`)),
      buckets);
    check("…and a bucket name carries no address or token in it",
      buckets.every(b => !/@|system-smoke|eyJ/.test(b)), buckets);

    // ---------------- /control/auth/me carries its own person only ----------------
    phase("what a seat is told about itself");
    const me = await call("/control/auth/me", ck("an"));
    check("the shell learns its own name and address so the desk can greet a person",
      me.status === 200 && me.json?.email === `smoke.system.an.${STAMP}@waisha.test`
      && me.json?.fullName === "Annie Analyst" &&
      JSON.stringify(me.json?.roles) === JSON.stringify(["platform_analyst"]),
      me.json);
    const others = (await oi(
      `select full_name, email from users where tenant_id = $1 and id <> $2`, [TC, uAN])).rows;
    const leaked = others.filter(o => bodies.some(b => b.includes(o.email)));
    check("no other seat's address appears in any response this run collected",
      leaked.length === 0, leaked.map(o => o.email));

    // ---------------- nothing leaks ----------------
    phase("leak scan");
    const LEAKS = ["syntax error at or near", "duplicate key value violates", "insert into",
      "node_modules", "refresh_token_hash", "$2b$", "encrypted_phone", "encrypted_nida",
      "search_hash", "password_hash", "app_runtime.", "totp_secret"];
    const hit = LEAKS.filter(m => bodies.some(b => b.toLowerCase().includes(m.toLowerCase())));
    check("no engine string, hash column or credential word ever reached a client",
      hit.length === 0, hit);
    const SECRET_KEYS = ["JWT_SECRET", "FIELD_ENCRYPTION_KEY", "SEARCH_HASH_KEY",
      "APP_DB_PASSWORD", "RESEND_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "AZAMPAY_CLIENT_SECRET"];
    const secrets = SECRET_KEYS.map(k => [k, process.env[k]] as const)
      .filter(([, v]) => !!v).filter(([, v]) => bodies.some(b => b.includes(v as string)))
      .map(([k]) => k);
    check("no credential from the environment appears in any payload",
      secrets.length === 0, secrets);
    const IDENTITY = /"(full_name|fullName|first_name|last_name|email|phone|nida)[":]/i;
    // migrations.last_name is the name of the newest .sql file, and 069 is already
    // applied to the live database, so the key stays as it shipped. The rest of the
    // report is what has to carry no identity at all.
    const countedSections = ["shape", "posture", "size", "access", "activity", "modules",
      "statistics"].map(k => JSON.stringify(rep[k])).join("");
    check("the technical report counts people and never names one",
      !IDENTITY.test(countedSections), countedSections.match(IDENTITY));
    const PII = /"(email|phone|nida|user_id|seeker_id|id)[":]|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|_encrypted|@/i;
    check("the advisory's evidence carries a display name or a company where the office has "
      + "someone to go and see — never an address, an id or a hash",
      !PII.test(JSON.stringify(adv.items)), JSON.stringify(adv.items).match(PII)?.[0]);
  } finally {
    phase("teardown");
    await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from rate_limits where bucket like 'system:uid:%'`).catch(() => { });
    await oi(`delete from users where id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from tenants where id = any($1::uuid[])`, [[TC]]).catch(() => { });
    await sweep();
    const residue = await oi(
      `select (select count(*) from user_roles where user_id = any($1::uuid[])) as grants,
              (select count(*) from sessions where user_id = any($1::uuid[])) as sessions,
              (select count(*) from rate_limits where bucket like 'system:uid:%') as buckets,
              (select count(*) from users where id = any($1::uuid[])) as users,
              (select count(*) from tenants where id = any($1::uuid[])) as tenants,
              (select count(*) from tenants where name like $2) as smoke_tenants,
              (select count(*) from users where email like $3) as smoke_users`,
      [uids, TENANT_SWEEP, EMAIL_SWEEP]);
    check("cleanup: no fixture seat, duty, session or bucket survives the run",
      Object.values(residue.rows[0]).every((n: any) => Number(n) === 0), residue.rows[0]);
    await owner.end();
  }

  console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILURE(S)`} — smoke-control-system`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
