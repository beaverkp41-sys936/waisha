/**
 * Live proof for the borrowed seat (migration 106, api/src/routes/control-support.routes.ts,
 * api/src/security/support.ts).
 *
 * Task #177 crosses the tenant wall on purpose, so the gate is not "can it be done" — the
 * route already does it — but whether the mark that makes it visible survives the machinery
 * around it. Three things can only be seen in the database:
 *
 *  1. that `sessions.actor_user_id` really landed: the column, the FK that cascades with the
 *     platform seat that opened the view, the CHECK that refuses a borrowed row that is also
 *     somebody's own row, and the partial index the two actor lookups use;
 *  2. that the rotation path refuses a borrowed row BEFORE it reads its revocation state. The
 *     insert in 045 lists its columns and would carry a support session back as an ordinary
 *     one — write-capable and banner-free — so this is the leak the migration exists to close,
 *     and `rotate_refresh` is judged as the role that actually calls it;
 *  3. that the route's own statements bind what they claim to: a seat asked for by id from
 *     another company comes back empty, and a support row is only ever closed by the actor who
 *     opened it — the predicate that does that is in the WHERE clause, not in a check that
 *     happens to run first.
 *
 * Host and database come from the operator URL; the password is APP_DB_PASSWORD, the runtime
 * role's own. Sessions are written only with hashes of values handed to nobody, always already
 * revoked, always with the run marker in the user_agent, and deleted by that hash at the end.
 * No person's own session, tenant or seat is touched, and nothing in `audit_logs` is written.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-support-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { sha256 } from "../src/util/crypto.js";
import { uuidv7 } from "../src/util/uuid.js";
import {
  CLOSE_SQL, FIND_SQL, MINE_SQL, SUBJECT_SQL, TENANT_SQL
} from "../src/routes/control-support.routes.js";

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  checks++;
  if (ok) console.log("ok   ", label);
  else {
    failures++;
    console.log("FAIL ", label, (typeof detail === "string"
      ? detail : JSON.stringify(detail)).slice(0, 400));
  }
}

const MARK = "sv" + Date.now().toString(36);
const AGENT = `verify-support-${MARK}`;

async function main() {
  const base = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  const pw = process.env.APP_DB_PASSWORD;
  if (!base || !pw) throw new Error("MIGRATE_DATABASE_URL and APP_DB_PASSWORD are both needed");
  const u = new URL(base);
  const owner = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
  await owner.connect();

  // The pooler routes by the project reference carried in the user name, so the runtime role
  // has to wear the same suffix the operator's role does.
  const ref = u.username.includes(".") ? u.username.slice(u.username.indexOf(".") + 1) : "";
  const rt = new pg.Client({
    host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1),
    user: ref ? `app_runtime.${ref}` : "app_runtime",
    password: pw, ssl: { rejectUnauthorized: false }
  });
  await rt.connect();

  // Every session this script commits is found again by the hash it was written with, so the
  // teardown deletes exactly this run's rows — including the one a successful rotation mints.
  const hashes: string[] = [];
  try {
    // ---------- 1. what 106 put in the schema ----------
    const col = await owner.query(
      `select is_nullable, data_type from information_schema.columns
        where table_name = 'sessions' and column_name = 'actor_user_id'`);
    check("106 added sessions.actor_user_id as a nullable uuid",
      col.rowCount === 1 && col.rows[0].data_type === "uuid" && col.rows[0].is_nullable === "YES",
      col.rows[0]);

    const fk = await owner.query(
      `select c.conname, c.confdeltype from pg_constraint c
        where c.contype = 'f' and c.conrelid = 'sessions'::regclass and c.confrelid = 'users'::regclass
          and exists (select 1 from unnest(c.conkey) k
                        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
                       where a.attname = 'actor_user_id')`);
    check("the actor key cascades with the platform seat that opened the view",
      fk.rowCount === 1 && fk.rows[0].confdeltype === "c", fk.rows);

    const chk = await owner.query(
      `select convalidated from pg_constraint
        where conrelid = 'sessions'::regclass and conname = 'sessions_actor_is_not_subject'`);
    check("a borrowed row that is also its own subject is refused at the boundary",
      chk.rowCount === 1 && chk.rows[0].convalidated, chk.rows);

    const idx = await owner.query(
      `select indexdef from pg_indexes
        where tablename = 'sessions' and indexname = 'idx_sessions_actor'`);
    check("the actor index exists and skips the rows that name no actor",
      !!idx.rowCount && /where/i.test(idx.rows[0].indexdef), idx.rows[0]?.indexdef);

    // 001 left a one-argument rotate_refresh in the same schema; the route calls the
    // four-argument one, and the definer whose search_path and grants matter is that one.
    const fn = await owner.query(
      `select p.prosecdef, p.proconfig, p.proacl::text[] as acl,
              pg_get_function_arguments(p.oid) as args
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'platform_auth' and p.proname = 'rotate_refresh' and p.pronargs = 4`);
    check("rotate_refresh still runs as its definer with a fixed search_path",
      fn.rowCount === 1 && fn.rows[0].prosecdef &&
        JSON.stringify(fn.rows[0].proconfig ?? []).includes("search_path=public"), fn.rows[0]);
    // An empty grantee before the "=" is PUBLIC. A NULL proacl would mean the default, which
    // for a function includes PUBLIC — so the list has to be there and say nothing about it.
    const acl: string[] = fn.rows[0]?.acl ?? [];
    check("nobody executes it through PUBLIC, and the runtime role still can",
      !!fn.rows[0]?.acl && !acl.some((e) => e.startsWith("=") && /X/.test(e.split("/")[0])) &&
        acl.some((e) => e.startsWith("app_runtime") && /X/.test(e.split("/")[0])), acl);

    // ---------- the ids to bind ----------
    const company = await owner.query(
      `select t.id, t.name, t.type, t.status, t.deleted_at
         from tenants t
        where t.type = 'transporter' and t.deleted_at is null and t.status <> 'suspended'
          and exists (select 1 from users u
                       where u.tenant_id = t.id and u.user_type = 'director'
                         and u.status = 'active' and u.deleted_at is null)
        order by t.created_at limit 1`);
    if (!company.rowCount) throw new Error("no live transporter with a director to borrow");
    const TID: string = company.rows[0].id;

    const director = await owner.query(
      `select u.id, u.full_name from users u
        where u.tenant_id = $1 and u.user_type = 'director'
          and u.status = 'active' and u.deleted_at is null
        order by u.created_at limit 1`, [TID]);
    const SEAT: string = director.rows[0].id;
    const platSeat = await owner.query(
      `select u.id, u.tenant_id from users u
        where u.user_type = 'platform' and u.status = 'active' and u.deleted_at is null
        order by u.created_at limit 1`);
    const ACTOR: string = platSeat.rows[0].id;
    const OTHER: string = (await owner.query(
      `select u.id from users u
        where u.user_type = 'platform' and u.status = 'active' and u.deleted_at is null
          and u.id <> $1 order by u.created_at limit 1`, [ACTOR])).rows[0]?.id ?? "";

    // ---------- 2. the route's statements, as written ----------
    const ten = await owner.query(TENANT_SQL, [TID]);
    check("TENANT_SQL reads back the type, status and closure the desk refuses on",
      ten.rowCount === 1 && ten.rows[0].type === "transporter" && !ten.rows[0].deleted_at, ten.rows);

    const subj = await owner.query(SUBJECT_SQL, [TID, null]);
    check("SUBJECT_SQL finds the company's own seats and names their duties",
      subj.rowCount! > 0 && subj.rows.every((r: any) => Array.isArray(r.roles)) &&
        subj.rows[0].roles.length > 0,
      `${subj.rowCount} seats, first roles=${JSON.stringify(subj.rows[0]?.roles)}`);
    check("the director is first, so the borrowed view is the fullest one",
      subj.rows[0]?.user_type === "director", subj.rows.map((r: any) => r.user_type).join(","));

    const byId = await owner.query(SUBJECT_SQL, [TID, SEAT]);
    check("SUBJECT_SQL with a named seat returns that seat",
      byId.rowCount === 1 && byId.rows[0].id === SEAT, byId.rows);
    const crossed = await owner.query(SUBJECT_SQL, [TID, ACTOR]);
    check("SUBJECT_SQL never reaches a seat from another company",
      crossed.rowCount === 0, crossed.rows);

    // ---------- 3. a borrowed row, then given back ----------
    const borrowHash = sha256(`borrowed-${MARK}`);
    const borrowSid = uuidv7();
    hashes.push(borrowHash);
    const ins = await owner.query(
      `insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
           refresh_token_hash, user_agent, ip, expires_at, actor_user_id)
       values ($1,$2,$3,$4,now()+interval '15 minutes',$5,$6,null,now()+interval '15 minutes',$7)
       returning id`,
      [borrowSid, SEAT, TID, borrowSid, borrowHash, AGENT, ACTOR]);
    check("a borrowed session row writes for a real seat inside the company",
      ins.rowCount === 1, ins.rows);

    await owner.query(
      `insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
           refresh_token_hash, user_agent, expires_at, actor_user_id)
       values ($1,$2,$3,$4,now()+interval '15 minutes',$5,$6,now()+interval '15 minutes',$7)`,
      [uuidv7(), SEAT, TID, uuidv7(), sha256(`bad-${MARK}`), AGENT, SEAT])
      .then(() => check("actor = subject is refused before it can reach an audit", false, "the row was accepted"))
      .catch((e: any) => check("actor = subject is refused before it can reach an audit",
        e.code === "23514", `${e.code} ${e.message}`));

    const findMine = await owner.query(FIND_SQL, [borrowSid, ACTOR]);
    check("FIND_SQL returns the row to the person who opened it",
      findMine.rowCount === 1 && findMine.rows[0].user_id === SEAT && !!findMine.rows[0].tenant_name,
      findMine.rows);
    const findForeign = await owner.query(FIND_SQL, [borrowSid, OTHER || uuidv7()]);
    check("FIND_SQL shows nothing to another platform seat",
      findForeign.rowCount === 0, findForeign.rows);

    const mine = await owner.query(MINE_SQL, [ACTOR]);
    check("MINE_SQL lists the open views this actor holds, with the company and the seat",
      mine.rows.some((r: any) => r.id === borrowSid && r.tenant_id === TID && r.subject_name),
      mine.rows.slice(0, 3));

    const closeWrong = await owner.query(CLOSE_SQL, [borrowSid, OTHER || uuidv7()]);
    check("CLOSE_SQL revokes nothing when the actor does not match",
      closeWrong.rowCount === 0, closeWrong.rows);

    // A live borrowed row whose idle and expiry branches would both let it rotate: answering
    // `support` here proves the guard sits ahead of them, not that the row was already dead.
    const stolenHash = sha256(`stolen-${MARK}`);
    hashes.push(stolenHash);
    const rot = await rt.query(
      "select platform_auth.rotate_refresh($1,$2,$3,$4) as r",
      [borrowHash, stolenHash, "rot-probe", "203.0.113.9"]);
    check("a borrowed row cannot rotate: the definer answers 'support'",
      rot.rows[0]?.r?.status === "support", rot.rows[0]?.r);
    // The definer is called as the runtime role — that is the path the API walks. The rows it
    // leaves behind are read back as the owner: app_runtime sits behind RLS on sessions with no
    // tenant bound, so a runtime read would answer "no such row" whether the guard worked or not.
    const stillThere = await owner.query(
      "select actor_user_id, revoked_at from sessions where refresh_token_hash = $1", [borrowHash]);
    check("and it leaves the row exactly as it found it",
      stillThere.rowCount === 1 && stillThere.rows[0].actor_user_id === ACTOR &&
        stillThere.rows[0].revoked_at === null, stillThere.rows);
    const noChild = await owner.query(
      "select 1 from sessions where refresh_token_hash = $1", [stolenHash]);
    check("no replacement row is minted for a refused rotation",
      noChild.rowCount === 0, noChild.rowCount);

    // The same definer on an ordinary row: it rotates, and the row it mints has no actor — the
    // shape a borrowed session would have arrived at had the guard not been there.
    const plainHash = sha256(`plain-${MARK}`);
    const nextHash = sha256(`plain-next-${MARK}`);
    const plainSid = uuidv7();
    hashes.push(plainHash, nextHash);
    await owner.query(
      `insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
           refresh_token_hash, user_agent, ip, expires_at)
       values ($1,$2,$3,$4,now()+interval '12 hours',$5,$6,null,now()+interval '7 days')`,
      [plainSid, SEAT, TID, plainSid, plainHash, AGENT]);
    const ok = await rt.query(
      "select platform_auth.rotate_refresh($1,$2,$3,$4) as r",
      [plainHash, nextHash, "rot-probe-2", "203.0.113.9"]);
    const newId = ok.rows[0]?.r?.session_id;
    check("an ordinary row still rotates, exactly as 045 left it",
      ok.rows[0]?.r?.status === "ok" && !!newId, ok.rows[0]?.r);
    const fresh = await owner.query(
      "select actor_user_id, user_id, tenant_id from sessions where id = $1", [newId]);
    check("the replacement row carries no actor, for the same seat and company",
      fresh.rowCount === 1 && fresh.rows[0].actor_user_id === null &&
        fresh.rows[0].user_id === SEAT && fresh.rows[0].tenant_id === TID, fresh.rows);
    const retired = await owner.query(
      "select revoked_reason from sessions where id = $1", [plainSid]);
    check("and the row it replaced is marked rotated, not swept by anything else",
      retired.rows[0]?.revoked_reason === "rotated", retired.rows);

    const closed = await owner.query(CLOSE_SQL, [borrowSid, ACTOR]);
    check("CLOSE_SQL gives the view back for the actor who opened it",
      closed.rowCount === 1 && closed.rows[0].tenant_id === TID, closed.rows);
    const mineAfter = await owner.query(MINE_SQL, [ACTOR]);
    check("a revoked view leaves the actor's list of open views",
      !mineAfter.rows.some((r: any) => r.id === borrowSid), mineAfter.rowCount);

    // Seq scan off so this answers "can the partial index serve the lookup", not "how big does
    // sessions have to be before the planner notices it".
    await owner.query("set enable_seqscan = off");
    const plan = await owner.query(
      `explain (format json) select id from sessions
        where actor_user_id = $1 and created_at > now() - interval '1 day'`, [ACTOR]);
    await owner.query("reset enable_seqscan");
    check("the actor lookup is served by the partial index",
      JSON.stringify(plan.rows).includes("idx_sessions_actor"),
      JSON.stringify(plan.rows).slice(0, 200));
  } finally {
    const gone = await owner.query("delete from sessions where refresh_token_hash = any($1::text[])", [hashes]);
    console.log("teardown: sessions deleted", gone.rowCount, "of", hashes.length,
      "leftover by marker:", (await owner.query(
        "select count(*)::int as n from sessions where user_agent like $1", [`verify-support-${MARK}%`])).rows[0].n);
    await owner.end();
    await rt.end();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
