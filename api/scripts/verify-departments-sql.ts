/**
 * Live proof for #130c — the platform's own org chart (migration 084).
 *
 * There is no definer to interrogate here: the whole design claim is that ordinary tenant
 * RLS inside the platform tenant is enough, because every row on this desk belongs to that
 * one community. Only running these exact statements as app_runtime under a tenant setting
 * proves it — the dev owner URL bypasses RLS and would false-pass every isolation probe
 * below. The statements are imported from control-departments.routes.ts and executed
 * verbatim, never re-typed.
 *
 * Three things this script exists to catch, because none of them is visible in a typecheck:
 *  - the two partial unique indexes (one live membership per seat, one head per desk) and
 *    the fact that a cover which ran out still holds its slot — which is why the desk
 *    settles old paper before it places anybody;
 *  - that a seat which is not platform, or not this tenant, cannot be placed or moved;
 *  - that the duty register cannot be edited through the door that opened it.
 *
 * Fixtures are built and torn down by the owner (app_runtime has no DELETE anywhere). Every
 * app_runtime write runs inside a transaction that is thrown away, so nothing a person owns
 * is touched — and the fixture tenants are the script's own, never a live platform desk.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-departments-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  DEPARTMENTS_SQL, UNASSIGNED_SQL, CLOSED_DEPARTMENTS_SQL, DEPT_SUMMARY_SQL, DEPARTMENT_SQL,
  DEPARTMENT_ANY_SQL, DEPT_LIVE_SEATS_SQL, PLATFORM_SEATS_SQL, SEAT_NAME_SQL,
  SEAT_MEMBERSHIPS_SQL, INSERT_MEMBERSHIPS_SQL, RELEASE_SEAT_MEMBERSHIPS_SQL,
  RELEASE_DEPT_MEMBERSHIPS_SQL, SETTLE_EXPIRED_COVERS_SQL, DEMOTE_HEAD_MEMBERSHIP_SQL,
  PROMOTE_MEMBERSHIP_SQL, INSERT_DEPARTMENT_SQL, UPDATE_DEPARTMENT_SQL, CLOSE_DEPARTMENT_SQL,
  REOPEN_DEPARTMENT_SQL, SET_HEAD_SQL, KEY_TAKEN_SQL, REGISTER_SQL, REGISTER_COUNT_SQL,
  INSERT_TRANSITION_SQL
} from "../src/routes/control-departments.routes.js";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else {
    failures++;
    console.log("FAIL ", label, (typeof detail === "string" ? detail
      : JSON.stringify(detail)).slice(0, 400));
  }
}

const STAMP = "VD" + Date.now().toString(36).toUpperCase();
const A = randomUUID();          // this desk's own platform tenant (fixture)
const B = randomUUID();          // a second platform tenant, to prove the chart cannot see it
const P1 = randomUUID();         // head of the support desk, permanent
const P2 = randomUUID();         // a cover at support, ending in three days
const P3 = randomUUID();         // head of billing by a cover that ran out two days ago
const P4 = randomUUID();         // billing seat whose cover ran out six weeks ago
const P5 = randomUUID();         // platform seat on the other tenant
const STAFF = randomUUID();      // a company seat inside A: never on this chart
const ACTOR = P1;

const D1 = randomUUID();  // support  — open
const D2 = randomUUID();  // billing  — open
const D3 = randomUUID();  // retired  — already closed, for the reopen path

const HOUR = 3600000, DAY = 24 * HOUR;
/** Dar es Salaam keeps UTC+3 all year, so the shift is the whole conversion. */
function darDate(ms: number): string {
  const d = new Date(ms + 3 * HOUR);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const FUTURE = darDate(Date.now() + 20 * DAY);

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

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  /**
   * The script's fixtures are found by the name they were born with, so a run that crashed
   * before section 4 cannot leave a platform tenant behind for the next run to read as if
   * 084 had made it. app_runtime holds no DELETE on any of these tables, so only the owner
   * URL can do this — and only to tenants whose ids this script minted.
   */
  async function sweepFixtures(): Promise<number> {
    const ids = (await oi(
      `select id from tenants
        where name like 'Verify Chart Platform %' or name like 'Verify Foreign Platform %'`
    )).rows.map((r: any) => r.id);
    if (!ids.length) return 0;
    const seats = (await oi(`select id from users where tenant_id = any($1)`, [ids]))
      .rows.map((r: any) => r.id);
    await oi(`delete from platform_duty_transitions where tenant_id = any($1)`, [ids]);
    await oi(`delete from platform_seat_departments where tenant_id = any($1)`, [ids]);
    await oi(`delete from platform_departments where tenant_id = any($1)`, [ids]);
    if (seats.length) {
      await oi(`delete from user_roles where user_id = any($1)`, [seats]);
      await oi(`delete from sessions where user_id = any($1)`, [seats]);
      await oi(`delete from users where id = any($1)`, [seats]);
    }
    await oi(`delete from tenants where id = any($1)`, [ids]);
    return ids.length;
  }
  const leftovers = await sweepFixtures();
  if (leftovers) console.log(`     swept ${leftovers} tenant(s) left behind by an earlier crashed run`);

  // ================================================================
  console.log("\n--- 1 · what 084 left in the catalog ---");

  const shape = await oi(
    `select c.relname, c.relrowsecurity,
            (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
            (select lower(string_agg(distinct tp.privilege_type, ',' order by tp.privilege_type))
               from information_schema.table_privileges tp
              where tp.table_name = c.relname and tp.grantee = 'app_runtime') as granted,
            (select count(*) from information_schema.table_privileges tp
              where tp.table_name = c.relname
                and tp.grantee in ('public','anon','authenticated','service_role')) as leaked
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1)
      order by c.relname`,
    [["platform_departments", "platform_duty_transitions", "platform_seat_departments"]]);
  check("all three tables exist", shape.rows.length === 3, shape.rows.map((r) => r.relname));
  const byName = new Map(shape.rows.map((r: any) => [r.relname, r]));
  for (const name of ["platform_departments", "platform_seat_departments"]) {
    const t = byName.get(name)!;
    check(`${name}: row security on, one tenant policy, no delete`,
      t.relrowsecurity === true && Number(t.policies) === 1
      && t.granted === "insert,select,update" && Number(t.leaked) === 0, t);
  }
  const reg = byName.get("platform_duty_transitions")!;
  check("the register: two policies (select and insert), so nothing can be rewritten",
    reg.relrowsecurity === true && Number(reg.policies) === 2
    && reg.granted === "insert,select" && Number(reg.leaked) === 0, reg);
  const regCmds = (await oi(
    `select p.polcmd from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relname = 'platform_duty_transitions' order by p.polcmd`)).rows.map((r) => r.polcmd);
  check("…and they are exactly /r and /a, never /w or /d",
    regCmds.join("") === "ar", regCmds.join(""));
  const guard = (await oi(
    `select t.tgname, p.proname from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_proc p on p.oid = t.tgfoid
      where c.relname = 'platform_duty_transitions' and not t.tgisinternal`)).rows;
  check("043's append-only trigger is bolted to the register",
    guard.some((r) => /no_mutation/.test(r.tgname) && r.proname === "prevent_job_mutation"), guard);

  const idx = (await oi(
    `select indexname, indexdef from pg_indexes where schemaname = 'public'
        and tablename in ('platform_departments','platform_seat_departments')`)).rows;
  const defs = idx.map((r: any) => r.indexdef);
  check("a key is unique per live tenant, so two desks cannot share one",
    defs.some((d) => /UNIQUE/.test(d) && /tenant_id, key/.test(d) && /deleted_at IS NULL/.test(d)),
    defs.filter((d) => /UNIQUE/.test(d)));
  check("one live membership per seat per desk, and one head per desk",
    defs.some((d) => /UNIQUE/.test(d) && /user_id, department_id/.test(d)
      && /released_at IS NULL/.test(d) && !/standing/.test(d))
    && defs.some((d) => /UNIQUE/.test(d) && /department_id/.test(d)
      && /standing = 'head'/.test(d)), defs.filter((d) => /UNIQUE/.test(d)));

  const cons = (await oi(
    `select conrelid::regclass::text as t, pg_get_constraintdef(oid) as def from pg_constraint
      where contype = 'c' and conrelid = any(array[
        'platform_departments'::regclass,'platform_seat_departments'::regclass,
        'platform_duty_transitions'::regclass])`)).rows;
  const cd = cons.map((r: any) => `${r.t}: ${r.def}`.toUpperCase());
  check("a key is lowercase and a name is a name",
    cd.some((d) => /PLATFORM_DEPARTMENTS: CHECK \(\(KEY ~ '\^\[A-Z\]\[A-Z0-9_\]/.test(d))
    && cd.some((d) => /CHAR_LENGTH\(TRIM\(BOTH FROM NAME\)\) >= 2/.test(d)
      && /CHAR_LENGTH\(TRIM\(BOTH FROM NAME\)\) <= 70/.test(d)), cd.filter((d) => /NAME|KEY/.test(d)));
  check("a cover must outlast its own first hour — that is what the API guard protects",
    cd.some((d) => /ENDS_AT > \(STARTS_AT \+ '01:00:00'::INTERVAL\)/.test(d)), cd);
  check("standing is member or head, and the register's nine actions are the whole vocabulary",
    cd.some((d) => /STANDING = ANY/.test(d) && /'HEAD'/.test(d) && /'MEMBER'/.test(d))
    && cd.some((d) => /'SEAT_JOINED'/.test(d) && /'HEAD_RELEASED'/.test(d)
      && /'DEPARTMENT_REOPENED'/.test(d)), cd.filter((d) => /STANDING|SEAT_JOINED/.test(d)));
  check("a transition without a sentence nobody would defend is not accepted",
    cd.some((d) => /CHAR_LENGTH\(TRIM\(BOTH FROM REASON\)\) >= 4/.test(d)
      && /CHAR_LENGTH\(TRIM\(BOTH FROM REASON\)\) <= 300/.test(d)), cd.filter((d) => /REASON/.test(d)));

  const perm = (await oi(
    `select p.key, coalesce(array_agg(r.key order by r.key) filter (where r.tenant_id is null), '{}') as roles
       from permissions p
       left join role_permissions rp on rp.permission_key = p.key
       left join roles r on r.id = rp.role_id
      where p.key like 'control.departments%'
      group by p.key`)).rows;
  const viewRow = perm.find((p: any) => p.key === "control.departments.view");
  const manageRow = perm.find((p: any) => p.key === "control.departments.manage");
  check("reading the chart is a duty four seats hold, and reshaping it is super_admin's alone",
    (viewRow?.roles ?? []).length === 4 &&
    ["super_admin", "compliance_officer", "platform_analyst", "support_engineer"]
      .every((k) => (viewRow.roles as string[]).includes(k))
    && (manageRow?.roles ?? []).length === 1 && manageRow.roles[0] === "super_admin",
    perm.map((p: any) => `${p.key}=${p.roles.join("|")}`));

  // Counted whether open or closed: a desk the office shuts later stays a row, so this check
  // is about the seed having happened once, not about how many desks are still standing.
  const SEEDED = ["support", "compliance", "billing", "operations", "marketplace", "engineering"];
  const seeded = (await oi(
    `select t.id as tenant, count(p.id) filter (where p.key = any($1))::int as desks
       from tenants t left join platform_departments p on p.tenant_id = t.id
      where t.type = 'platform' and t.deleted_at is null
      group by t.id`, [SEEDED])).rows;
  check("every live platform tenant was handed the six starting desks, and no key twice",
    seeded.length > 0 && seeded.every((r: any) => r.desks === 6),
    seeded.map((r: any) => `${String(r.tenant).slice(0, 8)}=${r.desks}`));
  const keys = (await oi(
    `select distinct key from platform_departments where key = any($1)`, [SEEDED])).rows;
  check("…named for what they own: support, compliance, billing, operations, marketplace, engineering",
    keys.length === 6, keys.map((k: any) => k.key));

  // ================================================================
  console.log("\n--- 2 · a desk of our own, built by the owner ---");

  // The fixtures below are minted fresh for this run; anything left by an earlier crash was
  // already swept at the top of main().

  await oi(`insert into tenants (id, type, name, status) values
      ($1,'platform',$2,'active'), ($3,'platform',$4,'active')`,
    [A, `Verify Chart Platform ${STAMP}`, B, `Verify Foreign Platform ${STAMP}`]);

  await oi(`insert into users (id, tenant_id, user_type, email, full_name, job_title, status,
             totp_enabled, last_login_at, created_at)
            values
     ($1,$2,'platform',$3,'Amina Head','Compliance lead','active',true, now()-interval '3 hours', now()-interval '400 days'),
     ($4,$2,'platform',$5,'Beti Cover',null,'active',true, now()-interval '90 minutes', now()-interval '200 days'),
     ($6,$2,'platform',$7,'Cass Past','Billing',    'active',true, now()-interval '12 days',  now()-interval '300 days'),
     ($8,$2,'platform',$9,'Daudi Lapsed',null,      'active',false,null,                      now()-interval '100 days'),
     ($10,$11,'platform',$12,'Ephant Otherdesk',null,'active',false,null,                     now()-interval '5 days'),
     ($13,$2,'staff',$14,'Faida Company',null,     'active',false,null,                      now()-interval '5 days')`,
    [P1, A, `amina.${STAMP}@verify.invalid`, P2, `beti.${STAMP}@verify.invalid`,
      P3, `cass.${STAMP}@verify.invalid`, P4, `daudi.${STAMP}@verify.invalid`,
      P5, B, `ephan.${STAMP}@verify.invalid`, STAFF, `faida.${STAMP}@verify.invalid`]);

  const roleIds = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "platform_analyst", "support_engineer"]])).rows;
  const rid = (k: string) => roleIds.find((r: any) => r.key === k)!.id;
  await oi(`insert into user_roles (user_id, role_id) values
      ($1,$2), ($3,$4), ($5,$6), ($7,$2)`,
    [P1, rid("super_admin"), P2, rid("platform_analyst"), P3, rid("support_engineer"), P5]);
  // A duty that lapsed: the chart's duty list must not quote it.
  await oi(`insert into user_roles (user_id, role_id, expires_at) values ($1,$2, now()-interval '1 day')`,
    [P2, rid("super_admin")]);

  await oi(`insert into platform_departments
      (id, tenant_id, key, name, purpose, head_user_id, sort, created_by, updated_by, deleted_at, deleted_by)
      values
     ($1,$2,'support','Verify Support','Answers companies about onboarding.', $3,10,$3,$3,null,null),
     ($4,$2,'billing','Verify Billing','Owns what a company is charged.',      $5,20,$3,$3,null,null),
     ($6,$2,'retired','Verify Retired','A desk somebody shut on purpose.',    null,90,$3,$3,
        now() - interval '5 days', $3)`,
    [D1, A, P1, D2, P3, D3]);

  // The two covers that ran out are backdated through their own starts_at, because 084's
  // check refuses an end that is not at least an hour after the start — which is precisely
  // the rule the API's cover-date guard exists to keep from becoming a 500.
  await oi(`insert into platform_seat_departments
      (id, tenant_id, user_id, department_id, standing, starts_at, ends_at, note, assigned_by,
       assigned_at, released_at)
      values
     ($1,$2,$3,$4,'head',   now()-interval '80 days', null,
        'Runs the desk.',                 $3, now()-interval '80 days', null),
     ($5,$2,$6,$4,'member', now()-interval '2 days',  now() + interval '3 days',
        'While Amina is away.',           $3, now()-interval '2 days',  null),
     ($7,$2,$8,$9,'head',   now()-interval '30 days', now() - interval '2 days',
        'Acting head during the leave.',  $3, now()-interval '30 days', null),
     ($10,$2,$11,$9,'member', now()-interval '8 weeks', now() - interval '6 weeks',
        'A cover nobody mentioned.',      $3, now()-interval '8 weeks', null)`,
    [randomUUID(), A, P1, D1, randomUUID(), P2, randomUUID(), P3, D2, randomUUID(), P4]);

  const fixtureNotes = await oi(
    `select (select count(*)::int from platform_seat_departments where tenant_id = $1) as rows,
            (select count(*)::int from platform_departments where tenant_id = $1) as desks`, [A]);
  check("four memberships across two open desks and one closed one",
    fixtureNotes.rows[0].rows === 4 && fixtureNotes.rows[0].desks === 3, fixtureNotes.rows[0]);

  // ================================================================
  console.log("\n--- 3 · the shipped statements, as the role that runs them ---");

  const aUrl = appUrl();
  if (!aUrl) {
    console.log("FAIL  app_runtime URL unavailable — nothing below was proven");
    failures++;
  } else {
    const app = new pg.Client({ connectionString: aUrl, ssl: { rejectUnauthorized: false } });
    await app.connect();

    /**
     * One transaction with app.tenant_id set, always thrown away. Every block below starts
     * from the committed fixtures, so a mutation proved in one block cannot make the next
     * one pass for the wrong reason.
     */
    async function asTenant<T>(tenant: string,
      fn: (q: (sql: string, params?: any[]) => Promise<any>) => Promise<T>): Promise<T> {
      const q = (sql: string, params: any[] = []) => app.query(sql, params);
      await app.query("begin");
      await app.query("select set_config('app.tenant_id', $1, true)", [tenant]);
      try { const out = await fn(q); await app.query("rollback"); return out; }
      catch (e) { await app.query("rollback").catch(() => null); throw e; }
    }
    /** Run a statement that is meant to fail, on its own savepoint, and hand back the message. */
    async function raises(q: any, sql: string, params: any[] = []): Promise<string> {
      await q("savepoint probe");
      try {
        const r = await q(sql, params);
        await q("rollback to savepoint probe");
        return r.rowCount === null ? "" : `NO-ERROR rows=${r.rowCount}`;
      } catch (e: any) {
        await q("rollback to savepoint probe");
        return String(e.message ?? e);
      }
    }

    // ---------- the read side ----------
    const chart = await asTenant(A, (q) => q(DEPARTMENTS_SQL, [A]));
    const rows = chart.rows as any[];
    check("the chart reads as app_runtime inside the tenant's own RLS",
      rows.length === 2 && rows[0].key === "support" && rows[1].key === "billing",
      rows.map((r) => `${r.key}/${r.sort}`));
    const support = rows[0];
    check("…with the head first and the cover second, named and stood",
      support.seat_count === 2 && support.live_covers === 1
      && support.seats[0].standing === "head" && support.seats[0].full_name === "Amina Head"
      && support.seats[1].full_name === "Beti Cover" && !!support.seats[1].ends_at,
      support.seats.map((s: any) => `${s.full_name}/${s.standing}`));
    check("a seat carries its duties, and a lapsed delegation is not one",
      support.seats[0].duties.join() === "super_admin"
      && support.seats[1].duties.join() === "platform_analyst",
      support.seats.map((s: any) => s.duties.join("+")));
    check("a cover that ran out is not a seat: billing shows nobody, though two rows exist",
      rows[1].seat_count === 0 && rows[1].head_name === "Cass Past"
      && rows[1].live_covers === 0, rows[1]);
    check("the head is named from the department row, not from a membership",
      support.head_name === "Amina Head" && support.head_user_id === P1,
      { h: support.head_name, id: support.head_user_id });
    check("no credential, contact or encrypted column rides on a chart row",
      Object.keys(support).concat(Object.keys(support.seats[0]))
        .every((k) => !/email|password|token|secret|nida|phone|_search|ip\b/.test(k.toLowerCase())),
      Object.keys(support).concat(Object.keys(support.seats[0])));

    const un = await asTenant(A, (q) => q(UNASSIGNED_SQL, [A]));
    check("the unplaced list is the platform seats the chart has not placed, expired covers included",
      un.rows.length === 2 && un.rows.every((r: any) => r.user_id !== STAFF),
      un.rows.map((r: any) => r.full_name));

    const closed = await asTenant(A, (q) => q(CLOSED_DEPARTMENTS_SQL, [A]));
    check("a closed desk is listed with who shut it, not hidden",
      closed.rows.length === 1 && closed.rows[0].key === "retired"
      && closed.rows[0].closed_by === "Amina Head" && closed.rows[0].register_rows === 0,
      closed.rows);

    const sum = (await asTenant(A, (q) => q(DEPT_SUMMARY_SQL, [A, 30]))).rows[0];
    check("the header counts what the desk can see, not the rows underneath",
      sum.departments === 2 && sum.placed_seats === 2 && sum.live_covers === 1
      && sum.covers_ending_7d === 1 && sum.seats === 4 && sum.register_rows === 0, sum);

    // ---------- a foreign tenant is invisible, in both directions ----------
    const foreign = await asTenant(B, (q) => q(DEPARTMENTS_SQL, [B]));
    check("the other platform tenant sees none of this chart",
      foreign.rows.length === 0, foreign.rows.map((r: any) => r.key));
    const cross = await asTenant(B, (q) => q(DEPARTMENT_SQL, [D1, B]));
    check("…and cannot even read one desk by its id", cross.rowCount === 0, cross.rows);
    const crossWrite = await asTenant(B, (q) =>
      q(UPDATE_DEPARTMENT_SQL, [D1, B, "Stolen", null, null, P5]));
    check("…and a rewrite aimed at another tenant's id changes nothing",
      crossWrite.rowCount === 0, crossWrite.rows);

    // ---------- placing: the collision the settle exists for ----------
    const collision = await asTenant(A, (q) =>
      raises(q, INSERT_MEMBERSHIPS_SQL, [A, D2, ACTOR, [P3], null, "Straight back in.", "member"]));
    check("placing a seat whose cover ran out collides with its own old paper — the failure the settle clears",
      /unique constraint/.test(collision), collision.slice(0, 160));

    const placed = await asTenant(A, async (q) => {
      const settled = await q(SETTLE_EXPIRED_COVERS_SQL, [D2, ACTOR]);
      const ins = await q(INSERT_MEMBERSHIPS_SQL, [A, D2, ACTOR, [P3, P4, P5, STAFF], null,
        "Back on the desk.", "member"]);
      const live = await q(DEPT_LIVE_SEATS_SQL, [D2]);
      const un = await q(UNASSIGNED_SQL, [A]);
      return {
        settled: settled.rowCount, ins: ins.rowCount,
        live: (live.rows as any[]).map((r) => `${r.full_name}/${r.standing}`),
        unplaced: (un.rows as any[]).map((r) => r.full_name)
      };
    });
    check("settling releases exactly the two covers that ran out", placed.settled === 2, placed);
    check("…and the same place then lands the two real seats and nothing else",
      placed.ins === 2, placed);
    check("both come back as members, with nobody's expired headship resurrected",
      placed.live.sort().join("|") === "Cass Past/member|Daudi Lapsed/member", placed.live);
    check("…while a placed seat leaves the unplaced list in the same breath",
      placed.unplaced.length === 0, placed.unplaced);

    const refused = await asTenant(A, async (q) => {
      const r = await q(INSERT_MEMBERSHIPS_SQL, [A, D1, ACTOR, [P5, STAFF], null,
        "Neither of these belongs here.", "member"]);
      const ids = await q(PLATFORM_SEATS_SQL, [[P5, STAFF], A]);
      const live = await q(DEPT_LIVE_SEATS_SQL, [D1]);
      return { placed: r.rowCount, ids: ids.rowCount, live: live.rowCount };
    });
    check("a foreign platform seat and a company seat are both unplaceable, without an error to hide",
      refused.placed === 0 && refused.ids === 0 && refused.live === 2, refused);

    // ---------- one head per desk, and the whole handover in one transaction ----------
    const head = await asTenant(A, async (q) => {
      // P3 sits nowhere live at support, so this insert really reaches the index — a seat
      // already at the desk is dropped by the statement's own guard and never gets that far.
      const dupHead = await raises(q, INSERT_MEMBERSHIPS_SQL,
        [A, D1, ACTOR, [P3], null, "A second head.", "head"]);
      const stepped = await q(DEMOTE_HEAD_MEMBERSHIP_SQL, [D1, ACTOR]);
      const promoted = await q(PROMOTE_MEMBERSHIP_SQL, [P2, D1, ACTOR, FUTURE]);
      // Read back the instant the date became, in the one timezone the desk speaks: the day a
      // cover was named has to survive the trip through Postgres as that day at 23:59 Dar es
      // Salaam, whatever zone the server runs in.
      const cover = (await q(`select to_char(m.ends_at at time zone 'Africa/Dar_es_Salaam',
                                    'YYYY-MM-DD HH24:MI') as local
                                from platform_seat_departments m
                               where m.user_id = $1 and m.department_id = $2
                                 and m.released_at is null`, [P2, D1])).rows[0];
      await q(SET_HEAD_SQL, [D1, P2, ACTOR]);
      const chart = (await q(DEPARTMENTS_SQL, [A])).rows[0];
      const members = (await q(SEAT_MEMBERSHIPS_SQL, [P2])).rows;
      const seat = (await q(SEAT_NAME_SQL, [P2])).rows[0];
      const released = await q(RELEASE_SEAT_MEMBERSHIPS_SQL, [P2, ACTOR]);
      const still = (await q(DEPT_LIVE_SEATS_SQL, [D1])).rows;
      const emptied = await q(RELEASE_DEPT_MEMBERSHIPS_SQL, [D1, ACTOR]);
      const seatsNow = (await q(DEPARTMENTS_SQL, [A])).rows[0].seat_count;
      return { dupHead, stepped: stepped.rowCount, promoted: promoted.rowCount, chart, members,
        seat, cover: cover?.local, releasedRows: released.rowCount,
        releasedStanding: released.rows[0]?.standing,
        releasedDept: released.rows[0]?.department_id, still, emptied: emptied.rowCount, seatsNow };
    });
    check("a second head in one desk is refused by the index, not by a convention",
      /one_head|unique constraint/.test(head.dupHead), head.dupHead.slice(0, 160));
    check("the old head steps down rather than being thrown off the desk",
      head.stepped === 1 && head.chart.seats.some((s: any) => s.full_name === "Amina Head"
        && s.standing === "member"), head.chart.seats.map((s: any) => `${s.full_name}/${s.standing}`));
    check("…and the new one is promoted in place, with the acting cover dated to the close of the day",
      head.promoted === 1 && head.chart.seats[0].full_name === "Beti Cover"
      && head.chart.seats[0].standing === "head" && head.cover === `${FUTURE} 23:59`,
      { promoted: head.promoted, seats: head.chart.seats.map((s: any) => `${s.full_name}/${s.standing}`),
        cover: head.cover });
    check("the desk's head and the membership's standing are written and read together",
      head.chart.head_name === "Beti Cover" && head.seat.full_name === "Beti Cover"
      && head.members.length === 1 && head.members[0].standing === "head"
      && head.members[0].is_cover === true, { h: head.chart.head_name, m: head.members });
    check("a seat released from everywhere reports the headship it took with it",
      head.releasedRows === 1 && head.releasedStanding === "head"
      && head.releasedDept === D1 && head.members.length === 1,
      { n: head.releasedRows, s: head.releasedStanding, d: head.releasedDept });
    check("…while the desk keeps its remaining seat, now unserved by a head",
      head.still.length === 1 && head.still[0].standing === "member"
      && head.still[0].full_name === "Amina Head", head.still);
    check("closing a desk empties its seats in one statement",
      head.emptied === 1 && head.seatsNow === 0, head);

    // ---------- open, rename, close, reopen ----------
    const desks = await asTenant(A, async (q) => {
      const taken = await q(KEY_TAKEN_SQL, [A, "support", null]);
      const self = await q(KEY_TAKEN_SQL, [A, "support", D1]);
      const clash = await raises(q, INSERT_DEPARTMENT_SQL, [A, "support", "Duplicate", "", 10, ACTOR]);
      const made = await q(INSERT_DEPARTMENT_SQL, [A, "verify_market", "Verify Market",
        "Owns what the public sees.", 50, ACTOR]);
      const renamed = await q(UPDATE_DEPARTMENT_SQL, [made.rows[0].id, A, null, null, 7, ACTOR]);
      const cleared = await q(UPDATE_DEPARTMENT_SQL, [made.rows[0].id, A, null, "", null, ACTOR]);
      const shut = await q(CLOSE_DEPARTMENT_SQL, [made.rows[0].id, A, ACTOR]);
      const invisible = await q(DEPARTMENT_SQL, [made.rows[0].id, A]);
      const anyState = await q(DEPARTMENT_ANY_SQL, [made.rows[0].id, A]);
      const back = await q(REOPEN_DEPARTMENT_SQL, [made.rows[0].id, A, ACTOR]);
      const foreignKey = await raises(q, INSERT_DEPARTMENT_SQL, [B, "verify_market", "Mine", "", 1, P5]);
      return { taken, self, clash, made: made.rows[0], keepName: renamed.rows[0],
        cleared: cleared.rows[0].purpose, shut: shut.rowCount, invisible: invisible.rowCount,
        closedFlag: anyState.rows[0]?.deleted_at !== null, back: back.rowCount, foreignKey };
    });
    check("a key already in use is found before the insert, and the index proves it",
      desks.taken.rowCount === 1 && desks.self.rowCount === 0
      && /unique constraint/.test(desks.clash), { t: desks.taken.rowCount, c: desks.clash.slice(0, 120) });
    check("a new desk is born with its own id, key and order",
      desks.made.key === "verify_market" && desks.made.is_active === true, desks.made);
    check("an absent name, purpose or sort keeps what was there — coalesce, not blank",
      desks.keepName.name === "Verify Market" && desks.keepName.sort === 7
      && desks.cleared === "", desks.keepName);
    check("closing hides the desk from the live read and stamps who did it",
      desks.shut === 1 && desks.invisible === 0 && desks.closedFlag, desks);
    check("reopening brings the same id back — the history never pointed at a new row",
      desks.back === 1, desks);

    // ---------- the register ----------
    const log = await asTenant(A, async (q) => {
      const a1 = await q(INSERT_TRANSITION_SQL, [A, P1, ACTOR, "super_admin", "203.0.113.7",
        `${STAMP}-req`, "seat_joined", "Amina Head", "Verify Billing", "Verify Support",
        D2, D1, "Back to her first desk.", JSON.stringify({ cover: false })]);
      const a2 = await q(INSERT_TRANSITION_SQL, [A, P3, ACTOR, "super_admin", null, null,
        "head_appointed", "Cass Past", null, "Verify Billing", null, D2,
        "Named while Amina was away.", JSON.stringify({ acting: true })]);
      const short = await raises(q, INSERT_TRANSITION_SQL, [A, P1, ACTOR, null, null, null,
        "seat_moved", null, null, null, null, null, "why", "{}"]);
      const verb = await raises(q, INSERT_TRANSITION_SQL, [A, P1, ACTOR, null, null, null,
        "seat_promoted", null, null, null, null, null, "not a word this desk uses", "{}"]);
      const otherTenant = await raises(q, INSERT_TRANSITION_SQL, [B, P1, ACTOR, null, null, null,
        "seat_moved", null, null, null, null, null, "a move that belongs somewhere else", "{}"]);
      const all = await q(REGISTER_SQL, [A, null, null, null, 30, 50]);
      const byAction = await q(REGISTER_SQL, [A, "head_appointed", null, null, 30, 50]);
      const bySeat = await q(REGISTER_SQL, [A, null, P1, null, 30, 50]);
      const byWord = await q(REGISTER_SQL, [A, null, null, "%first desk%", 30, 50]);
      const count = await q(REGISTER_COUNT_SQL, [A, null, null, null, 30]);
      const last7 = await q(REGISTER_COUNT_SQL, [A, null, null, null, 7]);
      const narrow = await q(REGISTER_SQL, [A, null, null, null, 30, 1]);
      const edit = await raises(q, "update platform_duty_transitions set reason = 'edited' where true");
      const purge = await raises(q, "delete from platform_duty_transitions where true");
      return { a1: a1.rows[0], a2: a2.rows[0], short, verb, otherTenant, all: all.rows,
        byAction: byAction.rows, bySeat: bySeat.rows, byWord: byWord.rows, count: count.rows[0],
        last7: last7.rows[0], narrow: narrow.rowCount, edit, purge };
    });
    check("a transition comes back with its own id and the instant it was made",
      !!log.a1?.id && !!log.a1?.ts, log.a1);
    check("the register keeps both labels as they were said, and the desk ids beside them",
      log.bySeat[0]?.from_label === "Verify Billing" && log.bySeat[0]?.to_label === "Verify Support"
      && log.bySeat[0]?.from_department_id === D2 && log.bySeat[0]?.actor_name === "Amina Head"
      && log.bySeat[0]?.ip === "203.0.113.7", log.bySeat[0]);
    check("a two-word reason is refused by the table itself",
      /violates check constraint/.test(log.short), log.short.slice(0, 120));
    check("…and so is an action this desk has never heard of",
      /violates check constraint/.test(log.verb), log.verb.slice(0, 120));
    check("a register row for a tenant you are not standing in cannot be written",
      /row-level security/.test(log.otherTenant), log.otherTenant.slice(0, 140));
    check("the filters the desk offers each pick the right one of the two",
      log.all.length === 2 && log.byAction.length === 1 && log.byAction[0].user_id === P3
      && log.bySeat.length === 1 && log.bySeat[0].action === "seat_joined"
      && log.byWord.length === 1, log.all.map((r: any) => `${r.action}/${r.seat_name}`));
    check("the count and the rows cannot disagree, in either window",
      log.count.n === 2 && log.count.last_7 === 2 && log.last7.n === 2
      && log.narrow === 1, log.count);
    check("the register is append-only through the door that opened it",
      /permission denied/.test(log.edit) && /permission denied/.test(log.purge),
      { edit: log.edit.slice(0, 90), purge: log.purge.slice(0, 90) });

    // Every block above throws its transaction away, so this one has to carry both instants
    // itself: the register's ts is now() by default and now() does not move inside a
    // transaction, so the older act is written with its own timestamp on purpose. That leaves
    // two acts from the same second beside one from an hour ago, which is the only shape that
    // can prove both halves of the desk's ordering.
    const later = await asTenant(A, async (q) => {
      await q(`insert into platform_duty_transitions
                 (tenant_id, user_id, actor_user_id, actor_role, action, seat_name,
                  from_label, reason, ts)
               values ($1,$2,$3,'super_admin','department_updated','Amina Head',
                  'Verify Support','An act made an hour before the other two.',
                  now() - interval '1 hour')`, [A, P1, ACTOR]);
      const batch = [];
      for (const [who, name] of [[P1, "Amina Head"], [P3, "Cass Past"]] as any[]) {
        const r = await q(INSERT_TRANSITION_SQL, [A, who, ACTOR, "super_admin", null, null,
          "seat_joined", name, null, "Verify Support", null, D1,
          "Both written in the same instant as the desk closed.", "{}"]);
        batch.push(r.rows[0].id);
      }
      const all = await q(REGISTER_SQL, [A, null, null, null, 30, 50]);
      const again = await q(REGISTER_SQL, [A, null, null, null, 30, 50]);
      return { batch, all: all.rows as any[], again: again.rows.map((r: any) => r.id) };
    });
    check("an act from an hour ago sorts behind the two made today",
      later.all.length === 3 && later.all[2].ts.getTime() < later.all[0].ts.getTime()
      && later.all[1].ts.getTime() === later.all[0].ts.getTime(),
      later.all.map((r: any) => r.ts.toISOString()));
    check("…and one instant keeps the same order on every read, so a page cannot shuffle",
      later.batch.length === 2
      && later.again.join() === later.all.map((r: any) => r.id).join()
      && later.all[0].id !== later.all[1].id,
      { ids: later.all.map((r: any) => r.id), again: later.again });

    const tombstone = await asTenant(A, async (q) => ({
      desks: await raises(q, "delete from platform_departments where true"),
      seats: await raises(q, "delete from platform_seat_departments where true"),
      users: await raises(q, "delete from users where id = $1", [P4])
    }));
    check("nothing on this desk can be deleted by the app role, so history survives a reorganisation",
      /permission denied/.test(tombstone.desks) && /permission denied/.test(tombstone.seats)
      && /permission denied/.test(tombstone.users), tombstone);
  }

  // ================================================================
  console.log("\n--- 4 · nothing survives the run ---");

  const readResidue = async () => (await oi(
    `select (select count(*)::int from platform_duty_transitions where tenant_id = any($1)) as moves,
            (select count(*)::int from platform_seat_departments where tenant_id = any($1)) as memberships,
            (select count(*)::int from platform_departments where tenant_id = any($1)) as desks,
            (select count(*)::int from user_roles ur where ur.user_id = any($2)) as duties,
            (select count(*)::int from users where tenant_id = any($1)) as seats,
            (select count(*)::int from tenants where id = any($1)) as tenants`,
    [[A, B], [P1, P2, P3, P4, P5, STAFF]])).rows[0] as any;

  const before = await readResidue();
  // Every write block above ran inside a transaction that was thrown away, so the only rows
  // still on disk are the ones the owner inserted on purpose — and none of them is a move the
  // register was asked to keep.
  check("what is still there is exactly the owner's fixtures: no block committed a row",
    before.moves === 0 && before.memberships === 4 && before.desks === 3
    && before.duties === 5 && before.seats === 6 && before.tenants === 2, before);

  const swept = await sweepFixtures();
  const after = await readResidue();
  check("the sweep found its own two tenants and took everything with them",
    swept === 2 && after.moves === 0 && after.memberships === 0 && after.desks === 0
    && after.duties === 0 && after.seats === 0 && after.tenants === 0, { swept, after });

  await owner.end();
  console.log(`\n${failures ? "FAILURES: " + failures : "084 department desk verified."}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
