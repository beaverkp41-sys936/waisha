/**
 * Live proof for migration 067 and the platform staff desk (#103).
 *
 * The SQL of this module lives in the routes, not in the database: there is no definer
 * function to interrogate, and the entire design claim is that ordinary RLS inside the
 * platform tenant is sufficient. Only running these exact statements as app_runtime
 * under a tenant setting proves that — the dev owner URL bypasses RLS and would
 * false-pass every isolation probe here. So the statements are exported from
 * control-staff.routes.ts and executed verbatim, never retyped.
 *
 * Fixtures are built and torn down by the owner (the API role has no DELETE anywhere).
 * Every app_runtime write runs inside a transaction that is thrown away, so the only
 * thing left behind is the probe trail itself: audit_logs is append-only, and these
 * rows name themselves verify.staff.* and reference nothing a person owns.
 *
 * Run: npx tsx scripts/verify-control-staff-sql.ts   (DNS_FALLBACK=1 if DNS is broken)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROSTER_SQL, SEAT_SQL, LIVE_ROLE_KEYS_SQL, ADMIN_HELD_SQL, ROLE_CATALOG_SQL,
  DUTIES_SQL, STATS_SQL, WORKLOAD_SQL, DUTY_MIX_SQL, WORK_LOG_SQL, AVATAR_SQL,
  SESSIONS_SQL, KNOWN_PLATFORM_ROLES_SQL, ASSIGN_ROLES_DELETE_SQL,
  ASSIGN_ROLE_INSERT_SQL, UPDATE_SEAT_SQL, UPDATE_STATUS_SQL,
  REVOKE_SEAT_SESSIONS_SQL, RETIRE_AVATAR_SQL, INSERT_AVATAR_SQL
} from "../src/routes/control-staff.routes.js";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label, String(detail).slice(0, 400)); }
}

const STAMP = `VST${Date.now().toString(36).toUpperCase()}`;
const A = randomUUID();  // the desk's own platform tenant (fixture)
const B = randomUUID();  // a second platform tenant, to prove the roster cannot see it
const U1 = randomUUID(); // the only active Super Admin on the fixture desk
const U2 = randomUUID(); // analyst: one lapsed delegation, one foreign company duty
const U3 = randomUUID(); // support engineer: suspended, retired picture only
const U4 = randomUUID(); // a director inside the same tenant — not platform, not roster
const U5 = randomUUID(); // platform seat in tenant B

const DOC_NEW = randomUUID();
const DOC_OLD = randomUUID();
const DOC_RETIRED = randomUUID();
const ROLES_OFFICE = randomUUID();

const DAY = 86400000;
const HOUR = 3600000;
const now = Date.now();

/** Dar es Salaam is UTC+3 with no DST, so the shift is the whole conversion. */
const pad = (n: number) => String(n).padStart(2, "0");
function darDate(ms: number): string {
  const x = new Date(ms + 3 * HOUR);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}
/** The instant that is 00:01 in Dar es Salaam today — 21:01 UTC of the day before. */
function darTodayEarlyMorning(): number {
  const t = darDate(now).split("-").map(Number);
  return Date.UTC(t[0], t[1] - 1, t[2], 0, 1, 0) - 3 * HOUR;
}

type Probe = { actor: string; ts: number; action: string; entity: string; tenant: string };
const EVENTS: Probe[] = [
  { actor: U1, ts: now - HOUR, action: "verify.staff.hour", entity: "users", tenant: A },
  { actor: U1, ts: now - 3 * DAY, action: "verify.staff.three_days", entity: "verify", tenant: A },
  { actor: U1, ts: now - 10 * DAY, action: "verify.staff.ten_days", entity: "verify", tenant: A },
  { actor: U1, ts: now - 45 * DAY, action: "verify.staff.long_ago", entity: "verify", tenant: A },
  { actor: U1, ts: darTodayEarlyMorning(), action: "verify.staff.edge", entity: "sessions", tenant: A },
  { actor: U2, ts: now - 2 * HOUR, action: "verify.staff.read", entity: "verify", tenant: A },
  { actor: U2, ts: now - 2 * DAY, action: "verify.staff.read", entity: "users", tenant: A },
  { actor: U3, ts: now - 5 * DAY, action: "verify.staff.engineer", entity: "verify", tenant: A },
  { actor: U5, ts: now - HOUR, action: "verify.staff.foreign", entity: "verify", tenant: B },
  // Attributed to the desk's own admin but stamped with another tenant: a row that
  // exists and must never reach this desk's counts.
  { actor: U1, ts: now - 2 * HOUR, action: "verify.staff.forged", entity: "verify", tenant: B }
];

const u1In = EVENTS.filter(e => e.actor === U1 && e.tenant === A && e.ts >= now - 30 * DAY);
const u1Prev = EVENTS.filter(e => e.actor === U1 && e.tenant === A
  && e.ts >= now - 60 * DAY && e.ts < now - 30 * DAY);
const u1Seven = EVENTS.filter(e => e.actor === U1 && e.tenant === A && e.ts >= now - 7 * DAY);
const u1DarDays = [...new Set(u1In.map(e => darDate(e.ts)))];
const u1Entities = [...new Set(u1In.map(e => e.entity))];
const u1Actions = [...new Set(u1In.map(e => e.action))];
const edgeDay = darDate(darTodayEarlyMorning());

function ownerUrl(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  return url;
}

/** app_runtime URL: dev hands us the owner URL, so rebuild it (066 script shape). */
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

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  // ============================
  // 1. The migration's own posture, as the owner
  // ============================
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const migText = readFileSync(
    join(process.cwd(), "migrations", "067_control_staff_roster.sql"), "utf8");
  check("067 is on disk and readable", migText.length > 200);
  check("067 adds no table, no function, no grant and no revoke — it only splits duties",
    !/create table|create or replace function|^\s*grant\b|^\s*revoke\b/im.test(migText),
    String(migText.match(/create table|create or replace function|^\s*grant\b|^\s*revoke\b/im)?.[0]));

  const perm = (await oi(
    `select p.key, coalesce(array_agg(r.key order by r.key) filter (where r.tenant_id is null), '{}') as roles
       from permissions p
       left join role_permissions rp on rp.permission_key = p.key
       left join roles r on r.id = rp.role_id
      where p.key in ('control.staff.view','control.staff.manage')
      group by p.key`)).rows;
  const view = perm.find((p: any) => p.key === "control.staff.view");
  const manage = perm.find((p: any) => p.key === "control.staff.manage");
  check("control.staff.view exists", !!view, JSON.stringify(perm));
  check("it is held by exactly the four reading seats",
    (view?.roles ?? []).length === 4 &&
    ["super_admin", "compliance_officer", "platform_analyst", "support_engineer"]
      .every(k => (view.roles as string[]).includes(k)), JSON.stringify(view?.roles));
  check("customer service and billing do not get the roster",
    !(view?.roles ?? []).includes("customer_service_agent") &&
    !(view?.roles ?? []).includes("billing_admin"), JSON.stringify(view?.roles));
  check("editing stays with super_admin alone",
    (manage?.roles ?? []).length === 1 && manage.roles[0] === "super_admin",
    JSON.stringify(manage?.roles));

  const idx = (await oi(
    `select indexname from pg_indexes where schemaname = 'public'
        and indexname in ('idx_audit_tenant_actor_ts','idx_documents_user_avatar')`)).rows;
  check("both 067 indexes exist", idx.length === 2, JSON.stringify(idx.map((i: any) => i.indexname)));

  let replay = true;
  let replayErr = "";
  try {
    await oi("begin");
    await oi(migText);
    await oi(migText);
    await oi("rollback");
  } catch (e: any) {
    replay = false; replayErr = e.message ?? "";
    await oi("rollback").catch(() => null);
  }
  check("067 replays cleanly, twice, then rolls back without a trace", replay, replayErr);

  // ============================
  // 2. Fixtures, as the owner
  // ============================
  await oi(`insert into tenants (id, type, name, status) values
     ($1,'platform',$2,'active'), ($3,'platform',$4,'active')`,
    [A, `Verify Desk Platform ${STAMP}`, B, `Verify Foreign Platform ${STAMP}`]);

  await oi(`insert into users (id, tenant_id, user_type, email, full_name, job_title, status,
             totp_enabled, last_login_at, created_at)
            values
     ($1,$2,'platform',$3,'Juma Administrator','Head of the platform desk','active',true, now()-interval '2 hours', now()-interval '200 days'),
     ($4,$2,'platform',$5,'Fatma Analyst',null,'active',true, now()-interval '20 minutes', now()-interval '90 days'),
     ($6,$2,'platform',$7,'Peter Support','Desk engineer','suspended',false, now()-interval '9 days', now()-interval '60 days'),
     ($8,$2,'staff',$9,'Amina Director',null,'active',false,null, now()-interval '5 days'),
     ($10,$11,'platform',$12,'Kipha Otherdesk',null,'active',false,null, now()-interval '5 days')`,
    [U1, A, `juma.${STAMP}@verify.invalid`, U2, `fatma.${STAMP}@verify.invalid`,
      U3, `peter.${STAMP}@verify.invalid`, U4, `amina.${STAMP}@verify.invalid`,
      U5, B, `kipha.${STAMP}@verify.invalid`]);

  const roleIds = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "platform_analyst", "compliance_officer", "support_engineer", "billing_admin"]]
  )).rows;
  const rid = (k: string) => roleIds.find((r: any) => r.key === k)!.id;

  await oi(`insert into user_roles (user_id, role_id) values
     ($1,$2), ($3,$4), ($5,$6)`,
    [U1, rid("super_admin"), U2, rid("platform_analyst"), U3, rid("support_engineer")]);
  // The other desk's own admin, so the last-admin guard can be shown to count only
  // this tenant's seats.
  await oi("insert into user_roles (user_id, role_id) values ($1,$2)",
    [U5, rid("super_admin")]);
  // A delegation that has already lapsed: neither a duty nor a permission.
  await oi(`insert into user_roles (user_id, role_id, expires_at)
            values ($1,$2, now() - interval '1 day')`, [U2, rid("compliance_officer")]);
  // A company duty held by the same person, which a platform-duty rewrite must not
  // touch. It lives inside tenant A because roles RLS would hide a foreign role from
  // the desk entirely, and then this would prove nothing about the delete's scope.
  await oi(`insert into roles (id, tenant_id, key, name) values ($1,$2,$3,'Office clerk')`,
    [ROLES_OFFICE, A, `office_clerk_${STAMP}`]);
  await oi("insert into user_roles (user_id, role_id) values ($1,$2)", [U2, ROLES_OFFICE]);

  // Sessions: one live, one revoked, one expired — only the first is "on the desk".
  await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
             refresh_token_hash, expires_at, revoked_at)
            values
     ($1,$2,$3,$4, now()+interval '12 hours', $5,  now()+interval '2 hours', null),
     ($6,$2,$3,$7,  now()+interval '12 hours', $8,  now()+interval '2 hours', now()),
     ($9,$2,$3,$10, now()+interval '12 hours', $11, now()-interval '1 hour', null),
     ($12,$13,$3,$14,now()+interval '12 hours',$15, now()+interval '2 hours', null)`,
    [randomUUID(), U1, A, randomUUID(), `${STAMP}-H1`,
      randomUUID(), randomUUID(), `${STAMP}-H2`,
      randomUUID(), randomUUID(), `${STAMP}-H3`,
      randomUUID(), U2, randomUUID(), `${STAMP}-H4`]);

  for (const e of EVENTS) {
    await oi(`insert into audit_logs (id, ts, tenant_id, actor_user_id, actor_role,
               entity, action, request_id)
              values ($1,$2,$3,$4,'super_admin',$5,$6,$7)`,
      [randomUUID(), new Date(e.ts), e.tenant, e.actor, e.entity, e.action, `${STAMP}-req`]);
  }

  // Pictures: two live rows on U1 (the newest must win), one retired row on U3.
  await oi(`insert into documents (id, tenant_id, entity_type, entity_id, kind, file_name,
             mime_type, size_bytes, storage_path, created_at, deleted_at)
            values
     ($1,$2,'user',$3,'avatar','old.png','image/png',10,$4, now()-interval '1 day', null),
     ($5,$2,'user',$3,'avatar','new.png','image/png',10,$6, now(), null),
     ($7,$2,'user',$8,'avatar','gone.png','image/png',10,$9, now()-interval '3 days', now())`,
    [DOC_OLD, A, U1, `${STAMP}/old`, DOC_NEW, `${STAMP}/new`,
      DOC_RETIRED, U3, `${STAMP}/gone`]);

  // ============================
  // 3. The shipped statements as app_runtime, under the desk's tenant
  // ============================
  const aUrl = appUrl();
  if (!aUrl) {
    console.log("FAIL  app_runtime URL unavailable — nothing below was proven");
    failures++;
  } else {
    const app = new pg.Client({ connectionString: aUrl, ssl: { rejectUnauthorized: false } });
    await app.connect();
    const ai = (sql: string, params: any[] = []) => app.query(sql, params);

    /** One transaction with app.tenant_id set, always rolled back: no residue, ever. */
    async function asTenant<T>(tenant: string | null, fn: () => Promise<T>): Promise<T> {
      await ai("begin");
      await ai("select set_config('app.tenant_id', $1, true)", [tenant ?? ""]);
      try { return await fn(); } finally { await ai("rollback"); }
    }

    const roster = (await asTenant(A, () => ai(ROSTER_SQL, [A, null, null]))).rows;
    check("the roster runs as app_runtime inside the platform tenant's RLS",
      roster.length === 3, roster.map((r: any) => r.full_name).join(", "));
    check("the director in the same tenant is not platform staff",
      !roster.some((r: any) => r.user_id === U4));
    check("the other tenant's platform seat is invisible",
      !roster.some((r: any) => r.user_id === U5));
    check("a seat with no picture is still on the roster",
      roster.some((r: any) => r.user_id === U2 && r.avatar_document_id === null));
    check("the newest picture wins where two are live",
      roster.find((r: any) => r.user_id === U1)?.avatar_document_id === DOC_NEW,
      String(roster.find((r: any) => r.user_id === U1)?.avatar_document_id));
    check("a retired picture is not shown",
      roster.find((r: any) => r.user_id === U3)?.avatar_document_id === null);

    const r1 = roster.find((r: any) => r.user_id === U1);
    const r2 = roster.find((r: any) => r.user_id === U2);
    check("duties are the live platform role keys, with their display names",
      JSON.stringify(r1?.roles) === JSON.stringify(["super_admin"]) &&
      JSON.stringify(r2?.roles) === JSON.stringify(["platform_analyst"]) &&
      r2?.role_names?.[0] === "Read-only Analyst",
      `${JSON.stringify(r1?.roles)} / ${JSON.stringify(r2?.roles)} / ${JSON.stringify(r2?.role_names)}`);
    check("a lapsed delegation is neither a duty nor a permission",
      !(r2?.roles ?? []).includes("compliance_officer"), JSON.stringify(r2?.roles));

    const adminTruth = (await oi(
      `select count(distinct rp.permission_key)::int as n
         from user_roles ur join roles r on r.id = ur.role_id
         join role_permissions rp on rp.role_id = ur.role_id
        where ur.user_id = $1 and r.tenant_id is null and r.deleted_at is null
          and (ur.expires_at is null or ur.expires_at > now())`, [U1])).rows[0].n;
    check("permission_count is the distinct set of the seat's live roles",
      r1?.permission_count === adminTruth, `${r1?.permission_count} vs ${adminTruth}`);
    const analystTruth = (await oi(
      `select count(*)::int as n from role_permissions where role_id = $1`,
      [rid("platform_analyst")])).rows[0].n;
    check("and the same for a seat with one narrow duty",
      r2?.permission_count === analystTruth, `${r2?.permission_count} vs ${analystTruth}`);
    check("the analyst really holds fewer keys than the super admin",
      r2?.permission_count > 0 && r2?.permission_count < r1?.permission_count,
      `${r2?.permission_count} < ${r1?.permission_count}`);

    check("the 30-day and 7-day workload match the fixtures, not the policy",
      r1?.events_30d === u1In.length && r1?.events_7d === u1Seven.length,
      `got ${r1?.events_30d}/${r1?.events_7d} want ${u1In.length}/${u1Seven.length}`);
    check("an event from ten days ago is in the month and out of the week",
      r1?.events_30d > r1?.events_7d, `${r1?.events_7d} -> ${r1?.events_30d}`);
    const forgedTruth = (await oi(
      `select count(*)::int as n from audit_logs
        where actor_user_id = $1 and tenant_id = $2 and action = 'verify.staff.forged'`,
      [U1, B])).rows[0].n;
    check("an event stamped to another tenant exists but never counts on this desk",
      forgedTruth === 1 && r1?.events_30d === u1In.length,
      `forged rows ${forgedTruth}, counted ${r1?.events_30d} want ${u1In.length}`);
    check("active sessions counts only the one that is live",
      r1?.active_sessions === 1, String(r1?.active_sessions));
    check("a suspended seat is still on the roster, marked as such",
      roster.find((r: any) => r.user_id === U3)?.status === "suspended");
    check("the seat that signed in longest ago sorts last",
      roster[roster.length - 1].user_id === U3, roster.map((r: any) => r.full_name).join(" > "));

    const noTenant = (await asTenant(null, () => ai(ROSTER_SQL, [A, null, null]))).rows;
    check("with no tenant in the session the roster is empty, not global",
      noTenant.length === 0, String(noTenant.length));
    const wrongTenant = (await asTenant(B, () => ai(ROSTER_SQL, [A, null, null]))).rows;
    check("aiming the desk statement at another tenant yields nothing",
      wrongTenant.length === 0, String(wrongTenant.length));

    const byRole = (await asTenant(A, () => ai(ROSTER_SQL, [A, null, "support_engineer"]))).rows;
    check("the role filter narrows to that duty",
      byRole.length === 1 && byRole[0].user_id === U3, JSON.stringify(byRole.map((r: any) => r.email)));
    const byName = (await asTenant(A, () => ai(ROSTER_SQL, [A, "%Fatma%", null]))).rows;
    const byMail = (await asTenant(A, () => ai(ROSTER_SQL, [A, `%${STAMP}@verify.invalid`, null]))).rows;
    const byTitle = (await asTenant(A, () => ai(ROSTER_SQL, [A, "%engineer%", null]))).rows;
    const byNone = (await asTenant(A, () => ai(ROSTER_SQL, [A, "%zzz-nothing%", null]))).rows;
    check("search finds a name, an address fragment and a job title",
      byName.length === 1 && byMail.length === 3 && byTitle.length === 1 &&
      byTitle[0].user_id === U3, `${byName.length}/${byMail.length}/${byTitle.length}`);
    check("and a term that matches nothing returns nothing", byNone.length === 0);

    // ---------- the profile statements ----------
    const duties = (await asTenant(A, () => ai(DUTIES_SQL, [U2]))).rows;
    check("the profile lists live duties with the keys each grants",
      duties.length === 1 && duties[0].key === "platform_analyst" &&
      duties[0].permissions.length > 0, JSON.stringify(duties.map((d: any) => d.key)));
    check("every duty arrives with its permission keys",
      duties[0].permissions.every((p: any) => typeof p.key === "string"),
      JSON.stringify(duties[0].permissions[0]));
    const controlKeys = (await asTenant(A, () => ai(DUTIES_SQL, [U1]))).rows
      .flatMap((d: any) => d.permissions).filter((p: any) => String(p.key).startsWith("control."));
    check("the control duties carry their descriptions, so the panel can explain a role",
      controlKeys.length > 5 && controlKeys.every((p: any) => !!p.description),
      JSON.stringify(controlKeys.slice(0, 2)));

    const st = (await asTenant(A, () => ai(STATS_SQL, [U1, 30, A]))).rows[0];
    check("workload in window and in the window before it",
      st.in_window === u1In.length && st.previous === u1Prev.length,
      JSON.stringify({ got: [st.in_window, st.previous], want: [u1In.length, u1Prev.length] }));
    check("seven days is its own window", st.last_7 === u1Seven.length, String(st.last_7));
    check("entities touched counts distinct subjects",
      st.entities === u1Entities.length, `${st.entities} vs ${u1Entities.length}`);
    check("days active counts distinct Dar es Salaam days",
      st.days_active === u1DarDays.length, `${st.days_active} vs ${u1DarDays.length}`);
    check("the last event is the newest one, not the last row read",
      new Date(st.last_event).getTime() >= now - HOUR);

    const work = (await asTenant(A, () => ai(WORKLOAD_SQL, [U1, 30, A]))).rows;
    check("the day axis has exactly the requested number of buckets",
      work.length === 30, String(work.length));
    check("every bucket is a plain date string, never a shifted Date object",
      work.every((w: any) => /^\d{4}-\d{2}-\d{2}$/.test(w.day)), String(work[0]?.day));
    check("the axis ends today, in Dar es Salaam", work[work.length - 1].day === darDate(now));
    check("the buckets are contiguous",
      work.every((w: any, i: number) => i === 0 ||
        new Date(w.day + "T00:00:00Z").getTime() -
        new Date(work[i - 1].day + "T00:00:00Z").getTime() === DAY));
    const wantEdge = u1In.filter(e => darDate(e.ts) === edgeDay).length;
    check("an event at 00:01 in Dar es Salaam buckets on that day, not the UTC one before",
      (work.find((w: any) => w.day === edgeDay)?.events ?? -1) === wantEdge,
      `day ${edgeDay} got ${work.find((w: any) => w.day === edgeDay)?.events} want ${wantEdge}`);
    check("the series sums to the window the stats report",
      work.reduce((n: number, w: any) => n + w.events, 0) === st.in_window,
      `${work.reduce((n: number, w: any) => n + w.events, 0)} vs ${st.in_window}`);
    const shortWork = (await asTenant(A, () => ai(WORKLOAD_SQL, [U1, 7, A]))).rows;
    check("a shorter axis is honoured and drops the ten-day event",
      shortWork.length === 7 &&
      shortWork.reduce((n: number, w: any) => n + w.events, 0) === u1Seven.length,
      `${shortWork.length} buckets`);

    const mix = (await asTenant(A, () => ai(DUTY_MIX_SQL, [U1, A, 30]))).rows;
    check("duty mix groups by action, largest first",
      mix.length === u1Actions.length &&
      mix.every((m: any, i: number) => i === 0 || m.events <= mix[i - 1].events),
      JSON.stringify(mix.map((m: any) => [m.action, m.events])));
    check("a 45-day-old event is outside a 30-day mix",
      !mix.some((m: any) => m.action === "verify.staff.long_ago"),
      JSON.stringify(mix.map((m: any) => m.action)));
    check("the forged cross-tenant event never reaches the mix",
      !mix.some((m: any) => m.action === "verify.staff.forged"));

    const log = (await asTenant(A, () => ai(WORK_LOG_SQL, [U1, A]))).rows;
    check("the work log is newest first and spans both windows",
      log.length === u1In.length + u1Prev.length &&
      new Date(log[0].ts) >= new Date(log[log.length - 1].ts), String(log.length));
    check("the work log carries no payload column at all",
      Object.keys(log[0]).every(k => !["before", "after", "ip", "user_agent"].includes(k)),
      Object.keys(log[0]).join(","));
    check("the work log holds only this tenant's rows for this actor",
      !log.some((l: any) => l.action === "verify.staff.forged"));
    const foreignLog = (await asTenant(A, () => ai(WORK_LOG_SQL, [U5, A]))).rows;
    check("another tenant's seat has no log here", foreignLog.length === 0);

    const held = (await asTenant(A, () => ai(ADMIN_HELD_SQL, [A, U1]))).rows[0];
    check("the desk knows it is looking at its only active Super Admin",
      held.total === 1 && held.this_seat === 1, JSON.stringify(held));
    const held2 = (await asTenant(A, () => ai(ADMIN_HELD_SQL, [A, U2]))).rows[0];
    check("and knows a different seat is not the one that would lock the panel",
      held2.total === 1 && held2.this_seat === 0, JSON.stringify(held2));
    const held3 = (await asTenant(A, () => ai(ADMIN_HELD_SQL, [A, U3]))).rows[0];
    check("a suspended seat does not count as an admin who can sign back in",
      held3.total === 1 && held3.this_seat === 0, JSON.stringify(held3));
    const heldB = (await asTenant(B, () => ai(ADMIN_HELD_SQL, [B, U5]))).rows[0];
    check("the other desk sees its own admin, so its guard is its own",
      heldB.total === 1 && heldB.this_seat === 1, JSON.stringify(heldB));
    const heldAcross = (await asTenant(A, () => ai(ADMIN_HELD_SQL, [A, U5]))).rows[0];
    check("a foreign admin is neither counted nor protected by this desk's guard",
      heldAcross.total === 1 && heldAcross.this_seat === 0, JSON.stringify(heldAcross));

    const cat = (await asTenant(A, () => ai(ROLE_CATALOG_SQL, [A]))).rows;
    const sa = cat.find((c: any) => c.key === "super_admin");
    check("the duty catalogue lists every platform role",
      cat.length >= 6, String(cat.length));
    check("and counts the seats holding each, on this desk only",
      sa?.holders === 1 && cat.find((c: any) => c.key === "platform_analyst")?.holders === 1 &&
      cat.find((c: any) => c.key === "customer_service_agent")?.holders === 0,
      `super_admin ${sa?.holders}`);
    check("a company's own role is not on the platform catalogue",
      !cat.some((c: any) => c.key === `office_clerk_${STAMP}`));
    check("each duty arrives with the keys it grants",
      sa.permissions.length > 10 && sa.permissions.every((p: any) => !!p.key),
      String(sa?.permissions?.length));

    const seat = (await asTenant(A, () => ai(SEAT_SQL, [U1, A]))).rows;
    check("a seat reads back inside its own tenant",
      seat.length === 1 && seat[0].email.includes(STAMP));
    const foreign = (await asTenant(A, () => ai(SEAT_SQL, [U5, A]))).rows;
    check("a foreign seat cannot be loaded, so no write can be aimed at it", foreign.length === 0);
    const director = (await asTenant(A, () => ai(SEAT_SQL, [U4, A]))).rows;
    check("a company's own director is not a platform seat", director.length === 0);
    const goneSeat = (await asTenant(A, () => ai(SEAT_SQL, [randomUUID(), A]))).rows;
    check("a random id is not a seat either", goneSeat.length === 0);

    const live = (await asTenant(A, () => ai(LIVE_ROLE_KEYS_SQL, [U2]))).rows;
    check("live role keys exclude the lapsed delegation",
      live.length === 1 && live[0].key === "platform_analyst", JSON.stringify(live));

    const av = (await asTenant(A, () => ai(AVATAR_SQL, [A, U1]))).rows;
    check("the avatar query returns the newest live picture and its storage path",
      av.length === 1 && av[0].id === DOC_NEW && String(av[0].storage_path).endsWith("/new"),
      JSON.stringify(av[0]));
    const avNone = (await asTenant(A, () => ai(AVATAR_SQL, [A, U3]))).rows;
    check("a retired picture reads as none, so the panel shows the monogram", avNone.length === 0);
    const sess = (await asTenant(A, () => ai(SESSIONS_SQL, [U1, A]))).rows[0];
    check("the session count agrees with the roster", sess.n === r1?.active_sessions,
      `${sess.n} vs ${r1?.active_sessions}`);

    // ---------- writes, each inside a transaction that is thrown away ----------
    const wrote = (await asTenant(A, () => ai(UPDATE_SEAT_SQL, [U2, "Analyst, marketplace", null, U1]))).rows;
    check("a job title can be set and the name kept when none is sent",
      wrote.length === 1 && wrote[0].job_title === "Analyst, marketplace" &&
      wrote[0].full_name === "Fatma Analyst", JSON.stringify(wrote[0]));
    const cleared = (await asTenant(A, () => ai(UPDATE_SEAT_SQL, [U2, null, null, U1]))).rows;
    check("and a job title can be cleared again", cleared[0]?.job_title === null);

    const known = (await asTenant(A, () =>
      ai(KNOWN_PLATFORM_ROLES_SQL, [["super_admin", "billing_admin", `office_clerk_${STAMP}`]]))).rows;
    check("a company role is not a platform duty, so it cannot be assigned from here",
      known.length === 2 && !known.some((k: any) => k.key === `office_clerk_${STAMP}`),
      JSON.stringify(known.map((k: any) => k.key)));

    // Read back inside the same transaction that is thrown away — a second one would
    // not see the write, and the check would be proving the rollback instead.
    const afterAssign = await asTenant(A, async () => {
      await ai(ASSIGN_ROLES_DELETE_SQL, [U2]);
      await ai(ASSIGN_ROLE_INSERT_SQL, [U2, U1, "billing_admin"]);
      await ai(ASSIGN_ROLE_INSERT_SQL, [U2, U1, "compliance_officer"]);
      const again = await ai(ROSTER_SQL, [A, "%Fatma%", null]);
      return { row: again.rows[0], perms: await ai(LIVE_ROLE_KEYS_SQL, [U2]) };
    });
    check("duties replace rather than stack, and the counts move with them",
      JSON.stringify(afterAssign.row?.roles) === JSON.stringify(["billing_admin", "compliance_officer"]) &&
      afterAssign.row.permission_count > 0 &&
      afterAssign.perms.rows.length === 2,
      JSON.stringify(afterAssign.row?.roles));

    const kept = await asTenant(A, async () => {
      await ai(ASSIGN_ROLES_DELETE_SQL, [U2]);
      const left = await ai(
        `select r.key, r.tenant_id from user_roles ur join roles r on r.id = ur.role_id
          where ur.user_id = $1`, [U2]);
      return left.rows;
    });
    check("rewriting a seat's platform duties leaves its company duties alone",
      kept.length === 1 && kept[0].key === `office_clerk_${STAMP}`,
      JSON.stringify(kept.map((k: any) => k.key)));

    const statusWrite = await asTenant(A, async () => {
      await ai(UPDATE_STATUS_SQL, [U3, "active", U1]);
      const u = await ai("select status from users where id = $1", [U3]);
      await ai(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
                  refresh_token_hash, expires_at)
                values ($1,$2,$3,$4, now()+interval '12 hours', $5, now()+interval '2 hours')`,
        [randomUUID(), U3, A, randomUUID(), `${STAMP}-H5`]);
      const rev = await ai(REVOKE_SEAT_SESSIONS_SQL, [U3, A]);
      return { status: u.rows[0].status, revoked: rev.rowCount };
    });
    check("status can change and every live session dies with it",
      statusWrite.status === "active" && statusWrite.revoked === 1, JSON.stringify(statusWrite));

    const avatarWrite = await asTenant(A, async () => {
      await ai(RETIRE_AVATAR_SQL, [A, U1, U1]);
      await ai(INSERT_AVATAR_SQL, [randomUUID(), A, U1, "probe.png", "image/png", 12,
        `${STAMP}/probe`, U1]);
      const list = await ai(`select id, deleted_at from documents
                              where tenant_id = $1 and entity_type = 'user'
                                and entity_id = $2 and kind = 'avatar'`, [A, U1]);
      const shown = await ai(ROSTER_SQL, [A, "%Juma%", null]);
      return {
        retired: list.rows.filter((r: any) => r.deleted_at).length,
        live: list.rows.filter((r: any) => !r.deleted_at).length,
        shown: shown.rows[0]?.avatar_document_id
      };
    });
    check("replacing a picture retires both live rows and shows only the new one",
      avatarWrite.retired === 2 && avatarWrite.live === 1 &&
      avatarWrite.shown !== DOC_NEW && avatarWrite.shown !== DOC_OLD,
      JSON.stringify(avatarWrite));

    const aimed = await asTenant(A, async () => {
      try {
        await ai(INSERT_AVATAR_SQL, [randomUUID(), A, U5, "x.png", "image/png", 1,
          `${STAMP}/x`, U1]);
        return "allowed";
      } catch (e: any) { return e.message ?? "error"; }
    });
    check("the documents policy cannot see a foreign entity_id — which is why every write starts from SEAT_SQL",
      aimed === "allowed", String(aimed).slice(0, 120));

    const hardDelete = await asTenant(A, async () => {
      try { await ai("delete from users where id = $1", [U3]); return "allowed"; }
      catch (e: any) { return e.message ?? "error"; }
    });
    check("the desk cannot delete a seat, only take it off the roster",
      hardDelete !== "allowed", String(hardDelete).slice(0, 120));

    const auditDelete = await asTenant(A, async () => {
      try { await ai("delete from audit_logs where request_id = $1", [`${STAMP}-req`]); return "allowed"; }
      catch (e: any) { return e.message ?? "error"; }
    });
    check("the work log this desk reads is append-only for it as well",
      auditDelete !== "allowed", String(auditDelete).slice(0, 120));

    // A roster shows a person's own name, work address and whether their second factor
    // is on — that is its purpose. What must never ride along is an encrypted customer
    // identity, its search hash, or a forensic payload column.
    const rosterKeys = Object.keys(roster[0]);
    const LEAKY = ["encrypted", "_search", "nida", "phone", "password", "passwd", "secret",
      "token", "otp_code", "pin", "passport", "visa", "address", "before", "after", "ip"];
    const leak = rosterKeys.filter(k => LEAKY.some(p => k.toLowerCase().includes(p)));
    check("a roster row carries no encrypted identity, hash or payload column",
      leak.length === 0, `${leak.join(",")} of ${rosterKeys.join(",")}`);

    await app.end();
  }

  // ============================
  // 4. Teardown, as the owner
  // ============================
  await oi(`delete from documents where tenant_id = any($1)`, [[A, B]]);
  await oi(`delete from sessions where tenant_id = any($1)`, [[A, B]]);
  await oi("delete from user_roles where role_id = $1", [ROLES_OFFICE]);
  await oi(`delete from user_roles where user_id = any($1)`, [[U1, U2, U3, U4, U5]]);
  await oi("delete from roles where id = $1", [ROLES_OFFICE]);
  await oi(`delete from users where tenant_id = any($1)`, [[A, B]]);
  await oi(`delete from tenants where id = any($1)`, [[A, B]]);
  const residue = (await oi(
    `select (select count(*) from users where tenant_id = any($1))::int as u,
            (select count(*) from documents where tenant_id = any($1))::int as d,
            (select count(*) from sessions where tenant_id = any($1))::int as s,
            (select count(*) from tenants where id = any($1))::int as t`, [[A, B]])).rows[0];
  check("no fixture seat, picture, session or tenant survives the run",
    residue.u === 0 && residue.d === 0 && residue.s === 0 && residue.t === 0,
    JSON.stringify(residue));
  const trailLeft = (await oi(
    `select count(*)::int as n from audit_logs where request_id = $1`, [`${STAMP}-req`])).rows[0].n;
  check("the only residue is the probe trail itself, which names itself",
    trailLeft === EVENTS.length, String(trailLeft));

  await owner.end();
  if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
  console.log("platform staff desk verified");
}

main().catch((e) => { console.error(e); process.exit(1); });
