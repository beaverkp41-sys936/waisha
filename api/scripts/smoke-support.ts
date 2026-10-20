/**
 * The borrowed seat over HTTP — smoke for #177 (migration 106, api/src/routes/
 * control-support.routes.ts, api/src/security/support.ts).
 *
 * verify-support-sql.ts proves the column, the CHECK and the definer. This proves the parts
 * only the wire can show: that the door is a duty key and not a token, that the view reads the
 * company it was aimed at and no other, that every write it attempts dies at the global guard
 * while the same seat's own token writes freely, that the crash intake and the way back stay
 * open inside it, that the desk's cookie — not the borrowed bearer — closes a view, and that
 * entering and leaving each leave a line in two books.
 *
 * The fixtures are this run's own: two platform desks, two companies and the seats inside them,
 * all swept by id at the end. The platform the real office sits on is never written to, and its
 * audit count is read before and after to show that. `audit_logs` is never deleted — the guard
 * refuses it for the owner too, so this run's support lines stay in the fixture tenants on
 * purpose, exactly as every earlier smoke leaves its own.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-support.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const MARK = `sp${STAMP}`;
const TENANT_SWEEP = "Support Smoke %";
const EMAIL_SWEEP = `smoke.support.%@waisha.test`;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

async function call(path: string, opts: { token?: string; ck?: string; method?: string; body?: any } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    ...(opts.body === undefined ? {} : {
      body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)
    }),
    headers: {
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.ck ? { Cookie: opts.ck } : {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
const code = (j: any) => j?.error?.code ?? j?.code;

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const roleIds = (await oi(
    `select id, key from roles where tenant_id is null
      and key = any($1)`, [["super_admin", "platform_analyst", "director", "shipper"]]
  )).rows;
  const rid = (k: string) => roleIds.find((r: any) => r.key === k)?.id;
  if (!rid("super_admin") || !rid("director") || !rid("shipper"))
    throw new Error("the global roles this view depends on are missing");

  // The live platform book: read only, to prove nothing here lands in it.
  const livePlat = (await oi(
    `select id from tenants where type = 'platform' and deleted_at is null
      and id not in (select tenant_id from users where email like $1)
     order by created_at limit 1`, [EMAIL_SWEEP])).rows[0]?.id;
  const liveAuditBefore = livePlat ? (await oi(
    "select count(*)::int as n from audit_logs where tenant_id = $1", [livePlat])).rows[0].n : 0;

  // ---------------- fixtures ----------------
  const TC = randomUUID();    // this run's platform desk
  const TB = randomUUID();    // another platform desk, no business here
  const CO = randomUUID();    // the company whose view gets borrowed
  const CO2 = randomUUID();   // a second company, to show the read is bound
  const SUS = randomUUID();   // blocked company: nothing to borrow
  const CLS = randomUUID();   // closed company: nothing to borrow
  const SK = randomUUID();    // a seeker book: not a company desk
  const NOSEAT = randomUUID();// a company with only portal seats inside

  const uCS = randomUUID();    // super_admin: holds control.impersonate
  const uAn = randomUUID();    // platform_analyst: reads the desk, cannot borrow
  const uFor = randomUUID();   // super_admin of the other desk
  const uDir = randomUUID();   // CO's director: the seat the view wears
  const uShip = randomUUID();  // CO's shipper seat: portal-only, not borrowable
  const uCo2 = randomUUID();   // CO2's director
  const uNose = randomUUID();  // NOSEAT's only seat, portal-only

  const tok = (who: string) => `sp-smoke-${who}-${MARK}`;
  const ck = (who: string) => `waisha_control=${tok(who)}`;

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
      // 082's register, not a "client_errors" table — and the crash this run reports is
      // anonymous, so it is swept by its message marker rather than by tenant.
      await oi(`delete from app_errors
                 where tenant_id = any($1::uuid[]) or message like $2`, [all, `%${MARK}%`]);
      await oi(`delete from clients where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where actor_user_id = any($1::uuid[])`, [uids]);
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await oi(`delete from rate_limits where bucket like 'support-open%' or bucket like 'ip:%'`);

  await oi(`insert into tenants (id, type, name, status) values
      ($1,'platform',$2,'active'), ($3,'platform',$4,'active'),
      ($5,'transporter',$6,'active'), ($7,'transporter',$8,'active'),
      ($9,'transporter',$10,'suspended'), ($11,'transporter',$12,'active'),
      ($13,'seeker',$14,'active'), ($15,'transporter',$16,'active')`,
    [TC, `Support Smoke Platform ${STAMP}`, TB, `Support Smoke Foreign ${STAMP}`,
      CO, `Support Smoke Cargo Ltd`, CO2, `Support Smoke Cargo Two`,
      SUS, `Support Smoke Blocked Co`, CLS, `Support Smoke Closed Co`,
      SK, `Support Smoke Seeker`, NOSEAT, `Support Smoke Empty Co`]);
  await oi(`update tenants set deleted_at = now(), status = 'expired' where id = $1`, [CLS]);

  const seat = (id: string, tenant: string, type: string, name: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,$3,$4,$5,'active',$6, now() - interval '2 hours', now() - interval '200 days')`,
      [id, tenant, type, name,
       `smoke.support.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`,
       type === "platform"]);
  await seat(uCS, TC, "platform", "Peace Platform");
  await seat(uAn, TC, "platform", "Nia Analyst");
  await seat(uFor, TB, "platform", "Faraji Otherdesk");
  await seat(uDir, CO, "director", "Daudi Director");
  await seat(uShip, CO, "shipper", "Siti Shipper");
  await seat(uCo2, CO2, "director", "Cosmo Director");
  await seat(uNose, NOSEAT, "shipper", "Nia Nobody");

  await oi(`insert into user_roles (user_id, role_id) values
      ($1,$2),($3,$4),($5,$2),($6,$7),($8,$9),($10,$7),($11,$9)`,
    [uCS, rid("super_admin"), uAn, rid("platform_analyst"), uFor,
      uDir, rid("director"), uShip, rid("shipper"), uCo2, uNose]);

  await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
        refresh_token_hash, user_agent, ip, expires_at)
      values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-support','127.0.0.1',
        now() + interval '2 hours')`,
    [randomUUID(), uCS, TC, randomUUID(), sha256(tok("cs"))]);
  await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
        refresh_token_hash, user_agent, ip, expires_at)
      values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-support','127.0.0.1',
        now() + interval '2 hours')`,
    [randomUUID(), uAn, TC, randomUUID(), sha256(tok("an"))]);
  await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
        refresh_token_hash, user_agent, ip, expires_at)
      values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-support','127.0.0.1',
        now() + interval '2 hours')`,
    [randomUUID(), uFor, TB, randomUUID(), sha256(tok("for"))]);
  // A control cookie for a seat that is not a platform seat — 099 turns it away.
  await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
        refresh_token_hash, user_agent, ip, expires_at)
      values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-support','127.0.0.1',
        now() + interval '2 hours')`,
    [randomUUID(), uDir, CO, randomUUID(), sha256(tok("dir-ck"))]);

  // One client in each company, so a read can only be the caller's own book.
  const CL_CO = randomUUID(), CL_CO2 = randomUUID();
  await oi(`insert into clients (id, tenant_id, name, created_by, updated_by)
      values ($1,$2,$3,$4,$4),($5,$6,$7,$8,$8)`,
    [CL_CO, CO, `Support Smoke Client One ${STAMP}`, uDir,
      CL_CO2, CO2, `Support Smoke Client Two ${STAMP}`, uCo2]);

  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);

  let bearer = "";
  let sessionId = "";

  try {
    // ---------------- the door ----------------
    phase("the door: a duty key, a platform cookie, a company desk");
    check("the desk's own permission probe lists the impersonation duty for a super_admin",
      (await call("/control/auth/permissions", { ck: ck("cs") })).json
        ?.permissions?.includes("control.impersonate") === true);
    check("an anonymous request never reaches the tenant check",
      (await call("/control/support/sessions", { method: "POST", body: { tenantId: CO } })).status === 401);
    check("a company seat cannot open a control desk at all (099)",
      (await call("/control/support/sessions",
        { ck: ck("dir-ck"), method: "POST", body: { tenantId: CO } })).status === 401);
    const noDuty = await call("/control/support/sessions",
      { ck: ck("an"), method: "POST", body: { tenantId: CO } });
    check("a platform seat without the duty key is refused",
      noDuty.status === 403 && code(noDuty.json) === "FORBIDDEN", noDuty.text);

    const unknown = await call("/control/support/sessions",
      { ck: ck("cs"), method: "POST", body: { tenantId: randomUUID() } });
    check("an unknown company is a 404, not a session", unknown.status === 404, unknown.text);
    const plat = await call("/control/support/sessions",
      { ck: ck("cs"), method: "POST", body: { tenantId: TC } });
    check("the platform's own book is not a view to borrow",
      plat.status === 400, plat.text);
    const seeker = await call("/control/support/sessions",
      { ck: ck("cs"), method: "POST", body: { tenantId: SK } });
    check("a seeker marketplace is not a company desk either", seeker.status === 400, seeker.text);
    const blocked = await call("/control/support/sessions",
      { ck: ck("cs"), method: "POST", body: { tenantId: SUS } });
    check("a blocked company has no view to borrow", blocked.status === 409, blocked.text);
    const closed = await call("/control/support/sessions",
      { ck: ck("cs"), method: "POST", body: { tenantId: CLS } });
    check("a closed company has none either", closed.status === 409, closed.text);
    const nobody = await call("/control/support/sessions",
      { ck: ck("cs"), method: "POST", body: { tenantId: NOSEAT } });
    check("a company whose only seats are portal seats answers 409", nobody.status === 409, nobody.text);
    const foreignSeat = await call("/control/support/sessions",
      { ck: ck("cs"), method: "POST", body: { tenantId: CO, asUserId: uCo2 } });
    check("naming a seat from another company is a 404, not a borrow",
      foreignSeat.status === 404, foreignSeat.text);
    const portalSeat = await call("/control/support/sessions",
      { ck: ck("cs"), method: "POST", body: { tenantId: CO, asUserId: uShip } });
    check("naming a portal-only seat is a 404: it sits at no staff surface",
      portalSeat.status === 404, portalSeat.text);

    // ---------------- opening ----------------
    phase("a view opens, and says who is in it");
    const opened = await fetch(`${API}/control/support/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ck("cs") },
      body: JSON.stringify({ tenantId: CO })
    });
    const oj = await opened.json();
    bearer = String(oj?.accessToken ?? "");
    sessionId = String(oj?.sessionId ?? "");
    check("the desk hands back a bearer, a session id and an end time",
      opened.status === 200 && !!bearer && !!sessionId, Object.keys(oj ?? {}));
    const mins = (new Date(oj?.expiresAt).getTime() - Date.now()) / 60_000;
    check("the window is a visit: fifteen minutes, not a shift",
      mins > 13 && mins <= 15.5, Math.round(mins * 10) / 10);
    check("it names the company and the director's seat it is wearing",
      oj?.tenant?.id === CO && oj?.seat?.id === uDir && !!oj?.seat?.duties?.length,
      { tenant: oj?.tenant, seat: oj?.seat });
    const cleared = (opened.headers.getSetCookie?.() ?? []).join(" ");
    check("the portal refresh cookie is cleared on the way out, so this tab keeps one identity",
      /waisha_refresh=;/.test(cleared) && /path=\/api\/v1\/auth/i.test(cleared),
      cleared.slice(0, 220));

    const row = (await oi(
      `select user_id, tenant_id, actor_user_id, expires_at, family_expires_at, revoked_at,
              refresh_token_hash <> '' as has_hash
         from sessions where id = $1`, [sessionId])).rows[0];
    check("the session row is the company's own seat, marked with the platform holder",
      row?.user_id === uDir && row?.tenant_id === CO && row?.actor_user_id === uCS &&
        row?.revoked_at === null && row?.has_hash === true, row);
    const audited = await oi(
      `select tenant_id, actor_user_id, action, "after"->>'tenant_id' as named
         from audit_logs where entity = 'sessions' and entity_id = $1 order by ts`,
      [sessionId]);
    check("entering is written in the company's book and the platform's, and nowhere else",
      audited.rowCount === 2 &&
        audited.rows.every((r: any) => r.action === "support.session.opened" &&
          r.actor_user_id === uCS) &&
        audited.rows.map((r: any) => r.tenant_id).sort().join() === [CO, TC].sort().join(),
      audited.rows);

    const listMine = await call("/control/support/sessions", { ck: ck("cs") });
    check("the actor's own list shows the open view of that company",
      (listMine.json?.sessions ?? []).some((s: any) => s.id === sessionId && s.tenant_id === CO),
      listMine.json?.sessions?.length);
    const listTheirs = await call("/control/support/sessions", { ck: ck("for") });
    check("another platform desk's list is empty: the list is the actor's own",
      (listTheirs.json?.sessions ?? []).length === 0, listTheirs.json);

    // ---------------- the view reads ----------------
    phase("the view reads what the company reads");
    const who = await call("/support/session", { token: bearer });
    check("the banner's own read names the company, the seat and the holder",
      who.json?.borrowed === true && who.json?.tenantName?.startsWith("Support Smoke Cargo") &&
        who.json?.seatName === "Daudi Director" && who.json?.actorName === "Peace Platform" &&
        who.json?.windowMinutes === 15, who.json);
    const readCO = await call("/clients", { token: bearer });
    check("a company read answers, and shows only that company's rows",
      readCO.status === 200 && Array.isArray(readCO.json) &&
        readCO.json.length === 1 && readCO.json[0].id === CL_CO, readCO.json);
    check("the read never carries the encrypted phone, only whether one is stored",
      readCO.json?.[0] && !("phone" in readCO.json[0]) && "has_phone" in readCO.json[0],
      Object.keys(readCO.json?.[0] ?? {}));
    const ownDir = await mint(uDir, CO, ["director"]);
    const asSelf = await call("/support/session", { token: ownDir });
    check("the same company's own seat is told it is not borrowed",
      asSelf.json?.borrowed === false, asSelf.json);

    // ---------------- the wall ----------------
    phase("nothing in the view is saved");
    const post = await call("/clients", { token: bearer, body: { name: `Support Smoke Refused ${STAMP}` } });
    check("a create is refused at the guard, by name",
      post.status === 403 && code(post.json) === "SUPPORT_READONLY", post.text);
    const put = await call(`/clients/${CL_CO}`, { token: bearer, method: "PUT", body: { name: "Renamed by support" } });
    check("an edit is refused", put.status === 403 && code(put.json) === "SUPPORT_READONLY", put.text);
    const del = await call(`/clients/${CL_CO}`, { token: bearer, method: "DELETE" });
    check("a delete is refused", del.status === 403 && code(del.json) === "SUPPORT_READONLY", del.text);
    const untouched = await oi(
      `select name from clients where id = $1 and tenant_id = $2`, [CL_CO, CO]);
    check("and the company's book is unchanged",
      untouched.rowCount === 1 && untouched.rows[0].name === `Support Smoke Client One ${STAMP}`,
      untouched.rows);
    const selfPost = await call("/clients", { token: ownDir, body: { name: `Support Smoke Own Write ${STAMP}` } });
    check("the same seat's own token writes freely — the wall is the mark, not the route",
      selfPost.status === 201, selfPost.text);
    // The intake is schema-bound and strict (errors.routes.ts): an unrecognised body is not
    // a 400, it is a quiet 202 with recorded:0 — so ask for one recorded item and read it back.
    const err = await call("/client-errors", {
      token: bearer,
      body: { errors: [{
        message: `support view crash ${MARK}`,
        source: "boundary", path: "/app/clients"
      }] }
    });
    check("the crash intake stays open inside a support view",
      err.status === 202 && err.json?.recorded === 1, err.text);
    check("and the report reached the register",
      (await oi(`select count(*)::int as n from app_errors where message like $1`,
        [`%${MARK}%`])).rows[0].n === 1);

    // ---------------- the way back ----------------
    phase("giving it back");
    const bearerClose = await call(`/control/support/sessions/${sessionId}/close`,
      { token: bearer, method: "POST", body: {} });
    check("the borrowed bearer alone cannot close the view it lives in",
      bearerClose.status === 401, bearerClose.text);
    const analystClose = await call(`/control/support/sessions/${sessionId}/close`,
      { ck: ck("an"), method: "POST", body: {} });
    check("a platform seat without the duty key cannot give somebody else's view back",
      analystClose.status === 403, analystClose.text);
    const foreignClose = await call(`/control/support/sessions/${sessionId}/close`,
      { ck: ck("for"), method: "POST", body: {} });
    check("another desk's cookie finds no view of theirs", foreignClose.status === 404, foreignClose.text);

    const close = await call(`/control/support/sessions/${sessionId}/close`,
      { ck: ck("cs"), method: "POST", body: {} });
    check("the holder's cookie closes it", close.status === 200 && close.json?.ok === true, close.text);
    const after = await oi(
      `select revoked_at, revoked_reason from sessions where id = $1`, [sessionId]);
    check("the session row is revoked with the reason the desk chose",
      !!after.rows[0]?.revoked_at && after.rows[0]?.revoked_reason === "support_closed", after.rows);
    const audited2 = await oi(
      `select tenant_id, action from audit_logs
        where entity = 'sessions' and entity_id = $1 and action = 'support.session.closed'`,
      [sessionId]);
    check("leaving is written in both books too",
      audited2.rowCount === 2 &&
        audited2.rows.map((r: any) => r.tenant_id).sort().join() === [CO, TC].sort().join(),
      audited2.rows);
    const ended = await call("/support/session", { token: bearer });
    check("the banner's read reports the view as ended rather than naming nothing",
      ended.json?.borrowed === true && ended.json?.ended === true, ended.json);
    const again = await call(`/control/support/sessions/${sessionId}/close`,
      { ck: ck("cs"), method: "POST", body: {} });
    check("closing twice says it was already closed rather than failing",
      again.status === 200 && again.json?.alreadyClosed === true, again.text);
    const listAfter = await call("/control/support/sessions", { ck: ck("cs") });
    check("the actor's list no longer holds it",
      !(listAfter.json?.sessions ?? []).some((s: any) => s.id === sessionId), listAfter.json);

    // ---------------- the limiter ----------------
    phase("one button, ten visits, then the clock");
    // The door phase already spent several hits in this bucket, so the row exists: write the
    // count rather than insert it, on the same epoch-aligned window the definer uses (001).
    await oi(`insert into rate_limits (bucket, window_start, count) values
        ($1, to_timestamp(floor(extract(epoch from now())/900)*900), 10)
       on conflict (bucket, window_start) do update set count = 10`,
      [`support-open:uid:${uCS}`]);
    const limited = await call("/control/support/sessions",
      { ck: ck("cs"), method: "POST", body: { tenantId: CO2 } });
    check("the tenth view in a quarter hour is refused before another row is written",
      limited.status === 429 && code(limited.json) === "RATE_LIMITED", limited.text);
    check("and nothing was opened for it",
      (await oi("select 1 from sessions where actor_user_id = $1 and tenant_id = $2", [uCS, CO2])).rowCount === 0);

    // ---------------- nobody else's book ----------------
    phase("the wall still stands");
    // CO2 only ever appeared as a refused target (the foreign seat, then the limiter), so it
    // must hold no borrowed row and no line in its own audit book.
    check("the company that was aimed at but never opened holds no borrowed session",
      (await oi(`select count(*)::int as n from sessions
                  where tenant_id = $1 and actor_user_id is not null`, [CO2])).rows[0].n === 0);
    check("and nothing was ever written in its own audit book",
      (await oi(`select count(*)::int as n from audit_logs where tenant_id = $1`, [CO2])).rows[0].n === 0);
    const marked = await oi(
      `select count(*)::int as n from sessions where user_id = $1 and actor_user_id is not null`, [uDir]);
    check("the seat that was worn gained exactly the one borrowed view and no copy of it",
      marked.rows[0].n === 1, marked.rows[0]);
    check("while its own ordinary session stayed unmarked — the column is written only by the desk",
      (await oi(`select actor_user_id from sessions
                  where refresh_token_hash = $1`, [sha256(tok("dir-ck"))])).rows[0]?.actor_user_id === null);
    const liveAuditAfter = livePlat ? (await oi(
      "select count(*)::int as n from audit_logs where tenant_id = $1", [livePlat])).rows[0].n : 0;
    check("the live platform office's own audit book gained nothing",
      liveAuditAfter === liveAuditBefore, { liveAuditBefore, liveAuditAfter });
  } finally {
    await oi(`delete from rate_limits where bucket like 'support-open%'`);
    await sweep();
    const left = await oi(
      `select (select count(*) from tenants where name like $1) as tenants,
              (select count(*) from users u where u.email like $2) as seats,
              (select count(*) from sessions s where s.user_agent = 'smoke-support'
                 or s.actor_user_id in (select id from users where email like $2)) as sessions,
              (select count(*) from clients where name like 'Support Smoke %') as clients`,
      [TENANT_SWEEP, EMAIL_SWEEP]);
    console.log("teardown:", left.rows[0]);
    await owner.end();
  }

  console.log(`\n${failures ? "FAILURES: " + failures : "smoke-support: all checks passed"}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
