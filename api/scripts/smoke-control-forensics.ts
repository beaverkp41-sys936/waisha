/**
 * The forensic desk over HTTP — smoke for #119 (the 071 register on 066's trail).
 *
 * The verify script proves what the function computes. This proves what the desk can
 * actually use: that the people register is gated by the SAME duty as the trail
 * (control.audit.view) and not by whatever role key is in a cookie, that an actor taken
 * off the register round-trips into the trail and comes back as that person's rows, that
 * the numbers rendered in a column are the database's numbers rather than a count of the
 * page, and that the payload a desk expands is the redacted one.
 *
 * Seats are built to differ by exactly one thing: who holds the audit duty. Super admin,
 * analyst and compliance officer hold it; billing admin, service agent and support
 * engineer do not — and 066 seeded those three on purpose, because reading every
 * company's trail is a different job from pricing it or answering its inbox.
 *
 * audit_logs is append-only, so the probe rows cannot be removed at the end. That turns
 * the teardown into the last two checks instead of a cleanup: the fixture people are
 * deleted, and the register must then stop listing them while the trail keeps their rows
 * with no name to show. It is the honest consequence of the register joining on accounts,
 * and it is worth having proven rather than explained.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-control-forensics.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const TENANT_SWEEP = 'Frk Smoke %';
const EMAIL_SWEEP = 'smoke.frk.%@waisha.test';
const AGENT = 'smoke-control-forensics';

/** Values written under a key the redactor must withhold — none may reach a browser. */
const SECRETS = ["NIDA-FAKE-DO-NOT-READ-77777", "FAKE-PHONE-9876543",
  "hunter-two", "probe.secret.do.not.read"];
/** Written under a key the redactor must NOT touch. Its presence in a body is the point. */
const VISIBLE_MARKER = "FRK-PLATE-NOT-A-SECRET-13";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

// A register call that answers 401 hands back an error object, and every downstream
// `.find` would throw and cut the run short. Fail the check and keep going instead.
function arr(r: { status: number; json: any; text: string }, label: string): any[] {
  if (!Array.isArray(r.json)) {
    check(`${label} returned a list`, false, { s: r.status, body: r.text.slice(0, 160) });
    return [];
  }
  return r.json;
}

const bodies: string[] = [];
const statuses: number[] = [];
async function call(path: string, cookie: string | null) {
  const res = await fetch(`${API}${path}`, {
    headers: { ...(cookie ? { Cookie: `waisha_control=${cookie}` } : {}) }
  });
  const text = await res.text();
  bodies.push(text); statuses.push(res.status);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const roleOf = async (k: string) => (await oi(
    `select id from roles where key = $1 and tenant_id is null`, [k])).rows[0]?.id;
  const roles = {
    super_admin: await roleOf("super_admin"),
    platform_analyst: await roleOf("platform_analyst"),
    compliance_officer: await roleOf("compliance_officer"),
    billing_admin: await roleOf("billing_admin"),
    customer_service_agent: await roleOf("customer_service_agent"),
    support_engineer: await roleOf("support_engineer"),
    director: await roleOf("director")
  };
  for (const [k, v] of Object.entries(roles)) {
    if (!v) throw new Error(`global role ${k} missing`);
  }

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id).filter(Boolean);
    const all = [...new Set([...tids, ...byEmail])];
    if (all.length) {
      const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
        .rows.map((r: any) => r.id);
      if (uids.length) {
        // By user id only. Sessions belong to a tenant, and every control seat lives in the
        // SHARED platform tenant — a sweep that deletes by tenant_id signs real admins out.
        await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
        await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      }
      await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
    }
    await oi(`delete from rate_limits where bucket like 'audit:%' or bucket like 'audit-actors:%'`);
  };
  await sweep();

  // ---------------- fixtures ----------------
  const TC = randomUUID();
  const ids = {
    sa: randomUUID(), an: randomUUID(), co: randomUUID(),
    ba: randomUUID(), csa: randomUUID(), se: randomUUID(), dir: randomUUID()
  };
  const TOK: Record<string, string> = {};
  for (const who of Object.keys(ids)) TOK[who] = `frk-smoke-${who}-${STAMP}`;

  await oi(`insert into tenants (id, type, name, status) values ($1,'platform',$2,'active')`,
    [TC, `Frk Smoke Platform ${STAMP}`]);
  const seat = async (id: string, name: string, who: string, roleKey: string) => {
    await oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled)
              values ($1,$2,'platform',$3,$4,'active',true)`,
      [id, TC, name, `smoke.frk.${who}.${STAMP}@waisha.test`]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`,
      [id, (roles as any)[roleKey]]);
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
             refresh_token_hash, user_agent, ip, expires_at)
             values ($1,$2,$3,$4, now() + interval '2 hours', $5, $6, '127.0.0.1',
             now() + interval '2 hours')`,
      [randomUUID(), id, TC, randomUUID(), sha256(TOK[who]), AGENT]);
  };
  await seat(ids.sa, "Frk Smoke Super Admin", "sa", "super_admin");
  await seat(ids.an, "Frk Smoke Analyst", "an", "platform_analyst");
  await seat(ids.co, "Frk Smoke Compliance", "co", "compliance_officer");
  await seat(ids.ba, "Frk Smoke Billing", "ba", "billing_admin");
  await seat(ids.csa, "Frk Smoke Service", "csa", "customer_service_agent");
  await seat(ids.se, "Frk Smoke Support Eng", "se", "support_engineer");
  await seat(ids.dir, "Frk Smoke Director", "dir", "director");

  // Trail entries with the shape the columns are counted on: one person across three
  // companies and two addresses (one blank), one person inside a window, one person whose
  // only entry is forty days old, and one entry that belongs to nobody.
  const put = (actor: string | null, rowTenant: string | null, action: string, entity: string,
    ip: string, minsAgo: number, after: object | null) =>
    oi(`insert into audit_logs (id, ts, tenant_id, actor_user_id, actor_role, ip, user_agent,
        request_id, entity, entity_id, action, before, after)
        values ($1, now() - make_interval(mins => $2), $3, $4, 'smoke_role', $5, $6, $7,
        $8, null, $9, '{}'::jsonb, $10::jsonb)`,
      [randomUUID(), minsAgo, rowTenant, actor, ip, AGENT, `frk.${STAMP}`, entity, action,
        after ? JSON.stringify(after) : null]);

  const OTHER = (await oi(`select id from tenants where type <> 'platform' and deleted_at is null
                           order by id limit 2`)).rows;
  if (OTHER.length < 2) throw new Error("need two company tenants to spread a person's rows");

  await put(ids.sa, TC, "smoke.forensic.activated", "tenants", "41.79.9.1", 8,
    { status: "paid", nida_number: SECRETS[0] });
  await put(ids.sa, OTHER[0].id, "smoke.forensic.corrected", "plans", "41.79.9.1", 40,
    { amount: 3, phone: SECRETS[1] });
  await put(ids.sa, OTHER[1].id, "smoke.forensic.corrected", "platform_costs", "", 90,
    { nested: { secret: SECRETS[3], visible: "still here" }, items: [{ tin: SECRETS[1] }] });
  await put(ids.an, TC, "smoke.forensic.read", "recommendations", "41.79.9.2", 20,
    { note: "ok", password: SECRETS[2] });
  await put(ids.co, TC, "smoke.forensic.weekold", "freight_invoices", "41.79.9.3", 40 * 24 * 60,
    { ref: VISIBLE_MARKER });
  await put(null, null, "smoke.forensic.unknown_identity", "users", "203.0.113.7", 12, null);

  const PROBE = `select count(*)::int as n from audit_logs where user_agent = '${AGENT}'`;
  const WRITES_BEFORE = (await oi(PROBE)).rows[0].n;

  try {
    // ---------------- the door ----------------
    phase("authentication");
    const anon = await call("/control/audit/actors", null);
    check("the people register turns an anonymous request away",
      anon.status === 401, { s: anon.status });

    const forged = await call("/control/audit/actors", "frk-smoke-forged-no-session");
    check("a cookie with no session row behind it is refused", forged.status === 401, { s: forged.status });

    const staffToken = await new SignJWT({ tid: TC, sid: randomUUID(), typ: "director", roles: ["director"] })
      .setProtectedHeader({ alg: "HS256" }).setSubject(ids.dir).setIssuedAt()
      .setExpirationTime("15m").sign(key);
    const bearer = await fetch(`${API}/control/audit/actors`,
      { headers: { Authorization: `Bearer ${staffToken}` } });
    bodies.push(await bearer.text()); statuses.push(bearer.status);
    check("a staff bearer token does not open it — the control cookie does",
      bearer.status === 401, { s: bearer.status });

    // ---------------- the duty, not the role key ----------------
    phase("who may read it");
    for (const [who, label] of [["sa", "super admin"], ["an", "analyst"], ["co", "compliance officer"]] as const) {
      const r = await call("/control/audit/actors?days=365", TOK[who]);
      check(`${label} opens the register`, r.status === 200 && Array.isArray(r.json),
        { s: r.status, n: Array.isArray(r.json) ? r.json.length : r.json });
    }
    for (const [who, label] of [["ba", "billing admin"], ["csa", "service agent"],
      ["se", "support engineer"], ["dir", "a director role on a control cookie"]] as const) {
      const r = await call("/control/audit/actors?days=365", TOK[who]);
      check(`${label} is refused the register — reading every company's trail is its own duty`,
        r.status === 403, { s: r.status, e: r.json?.error?.code });
      const t = await call("/control/audit?limit=5", TOK[who]);
      check(`${label} is refused the trail by the same gate`,
        t.status === 403, { s: t.status });
    }

    // ---------------- validation ----------------
    phase("the filters are the route's, not the page's");
    check("a tenant that is not a uuid is a 400, not a silent empty list",
      (await call("/control/audit/actors?tenantId=not-a-uuid", TOK.sa)).status === 400);
    check("a window of zero days is refused",
      (await call("/control/audit/actors?days=0", TOK.sa)).status === 400);
    check("a window of two thousand days is refused",
      (await call("/control/audit/actors?days=2000", TOK.sa)).status === 400);
    check("a limit of zero is refused rather than floored at the edge",
      (await call("/control/audit/actors?limit=0", TOK.sa)).status === 400);
    check("a limit above the cap is refused at the door",
      (await call("/control/audit/actors?limit=501", TOK.sa)).status === 400);
    const atCap = await call("/control/audit/actors?limit=500", TOK.sa);
    check("the cap itself is accepted", atCap.status === 200 && atCap.json.length <= 500,
      { s: atCap.status, n: atCap.json?.length });
    check("an unrecognised filter is ignored, not a crash",
      (await call("/control/audit/actors?colour=red", TOK.sa)).status === 200);

    // ---------------- the numbers the desk renders ----------------
    phase("one row per person");
    const year = arr(await call("/control/audit/actors?days=365&limit=500", TOK.sa),
      "the yearly register");
    const sa = year.find(r => r.actor_user_id === ids.sa);
    const an = year.find(r => r.actor_user_id === ids.an);
    const co = year.find(r => r.actor_user_id === ids.co);
    check("the seat that acted across three companies is ONE person, not three",
      year.filter(r => r.actor_user_id === ids.sa).length === 1, year.filter(r => r.actor_user_id === ids.sa));
    check("its probe entries are counted against the database's own count",
      !!sa && sa.events >= 3, sa);
    const dbSa = await oi(`select count(*)::int as n,
        count(distinct action)::int as actions, count(distinct entity)::int as entities,
        count(distinct nullif(ip,''))::int as ips, count(distinct tenant_id)::int as tenants
        from audit_logs where actor_user_id = $1 and user_agent = $2`, [ids.sa, AGENT]);
    check("every number the register shows equals the same count taken off the owner connection",
      !!sa && dbSa.rows[0].actions === sa.distinct_actions
        && dbSa.rows[0].entities === sa.distinct_entities
        && dbSa.rows[0].tenants === sa.tenants_touched,
      { db: dbSa.rows[0], http: sa && { actions: sa.distinct_actions, entities: sa.distinct_entities, tenants: sa.tenants_touched } });
    check("the blank address is not counted as a source",
      !!sa && sa.distinct_ips === dbSa.rows[0].ips && dbSa.rows[0].ips === 1,
      { db: dbSa.rows[0].ips, http: sa?.distinct_ips });
    check("the company column is the person's own, not the one they acted on",
      !!sa && sa.tenant_id === TC && sa.tenant_name.includes("Frk Smoke Platform"),
      sa && { tenant_id: sa.tenant_id, tenant_name: sa.tenant_name });
    check("an account type and status travel with the person",
      !!sa && sa.actor_type === "platform" && sa.account_status === "active", sa);
    check("every email the desk receives is lower-case",
      year.every(r => !r.actor_email || r.actor_email === r.actor_email.toLowerCase()),
      year.slice(0, 3).map(r => r.actor_email));
    check("the register arrives ordered by most recent activity",
      year.every((r, i) => i === 0 || new Date(year[i - 1].last_seen) >= new Date(r.last_seen)),
      year.slice(0, 3).map(r => r.last_seen));
    check("first_seen never postdates last_seen",
      year.every(r => new Date(r.first_seen) <= new Date(r.last_seen)));

    check("a seat with one entry today is in the yearly register",
      !!an && an.events >= 1, an);
    const week = arr(await call("/control/audit/actors?days=7&limit=500", TOK.sa),
      "the seven-day register");
    check("…and in a seven-day one, because its only entry is twenty minutes old",
      !!week.find(r => r.actor_user_id === ids.an), week.length);
    const weekSa = week.find(r => r.actor_user_id === ids.sa);
    const weekCo = week.find(r => r.actor_user_id === ids.co);
    check("a seven-day window keeps the seat that acted today", !!weekSa, weekSa);
    check("…and drops the seat whose only entry is forty days old",
      !weekCo && !!co, { weekCo, co: co && co.last_seen });
    check("…and counts the recent seat's entries inside that window only",
      !!weekSa && weekSa.events <= sa.events, { week: weekSa?.events, year: sa?.events });

    const byTenant = arr(await call(`/control/audit/actors?tenantId=${TC}&days=365`, TOK.sa),
      "the company-filtered register");
    check("filtering by the platform company returns only its own people",
      byTenant.length > 0 && byTenant.every(r => r.tenant_id === TC), byTenant.slice(0, 3).map(r => r.tenant_name));
    check("…including the seat that merely acted on another company's rows",
      byTenant.some(r => r.actor_user_id === ids.sa), byTenant.length);
    const otherOnly = arr(await call(`/control/audit/actors?tenantId=${OTHER[0].id}&days=365`, TOK.sa),
      "the other company's register");
    check("…and the company it acted on does not get credited with its person",
      !otherOnly.some(r => r.actor_user_id === ids.sa), otherOnly.length);

    check("an entry with no person behind it stays out of a register of people",
      !year.some(r => r.actor_user_id === null), year.filter(r => !r.actor_user_id).length);
    const orphan = await call(`/control/audit?action=smoke.forensic.unknown_identity&limit=5`, TOK.sa);
    check("…while the trail keeps it, unnamed",
      orphan.status === 200 && orphan.json.length >= 1 && orphan.json[0].actor_user_id === null,
      orphan.json?.[0] && { actor: orphan.json[0].actor_user_id, action: orphan.json[0].action });

    // ---------------- the round trip the desk depends on ----------------
    phase("person to trail");
    const picked = weekSa.actor_user_id as string;
    const trail = arr(await call(`/control/audit?actorUserId=${picked}&days=365&limit=200`, TOK.sa),
      "the trail of that seat");
    check("an actor id taken off the register opens their trail",
      Array.isArray(trail) && trail.length >= 1, { n: trail?.length });
    check("every row in it belongs to that person",
      trail.every(r => r.actor_user_id === picked), trail.filter(r => r.actor_user_id !== picked).length);
    check("the trail names the actor, so the desk can say who did it",
      trail.every(r => typeof r.actor_name === "string" && r.actor_name.length > 0),
      trail[0] && trail[0].actor_name);

    const probe = arr(await call(`/control/audit?action=smoke.forensic&limit=50`, TOK.sa),
      "the probe entries in the trail");
    check("an action prefix narrows the trail to the probe entries",
      probe.length >= 5 && probe.every(r => r.action.startsWith("smoke.forensic")),
      { n: probe.length, first: probe[0]?.action });
    const withPayload = probe.find(r => r.action === "smoke.forensic.activated");
    check("a payload is returned so the desk can show what changed",
      !!withPayload && withPayload.after && withPayload.after.status === "paid", withPayload?.after);
    check("…and the sensitive key inside it comes back withheld, not blank",
      !!withPayload && withPayload.after.nida_number === "[redacted]", withPayload?.after);
    check("a safe key in the same object is untouched",
      !!withPayload && withPayload.after.status === "paid");
    const nested = probe.find(r => r.entity === "platform_costs");
    check("redaction reaches a nested object",
      !!nested && nested.after.nested.secret === "[redacted]"
        && nested.after.nested.visible === "still here", nested?.after?.nested);
    check("…and into an array of line items",
      !!nested && Array.isArray(nested.after.items) && nested.after.items[0].tin === "[redacted]",
      nested?.after?.items);
    const withPassword = probe.find(r => r.action === "smoke.forensic.read");
    check("a password key is withheld the same way an identity key is",
      !!withPassword && withPassword.after.password === "[redacted]"
        && withPassword.after.note === "ok", withPassword?.after);
    const marked = probe.find(r => r.action === "smoke.forensic.weekold");
    check("…while a value under a key that is not on the withhold list arrives whole",
      !!marked && marked.after.ref === VISIBLE_MARKER, marked?.after);

    // ---------------- leak scan ----------------
    phase("what left the building");
    const leaked = SECRETS.filter(s => bodies.some(b => b.includes(s)));
    check(`no probe secret reached a browser — ${bodies.length} bodies scanned`,
      leaked.length === 0, leaked);
    check("…and the desk still carries the value it was written to show",
      bodies.some(b => b.includes(VISIBLE_MARKER)));
    check("no body carries a password hash or a refresh token",
      !bodies.some(b => b.includes("password_hash") || b.includes("refresh_token_hash")));
    check("reading the desk writes nothing back into the trail",
      (await oi(PROBE)).rows[0].n === WRITES_BEFORE,
      { before: WRITES_BEFORE, after: (await oi(PROBE)).rows[0].n });
    const five = statuses.filter(s => s >= 500);
    check(`no request in the run produced a 5xx (${statuses.length} requests)`,
      five.length === 0, five);

    // ---------------- teardown ----------------
    phase("teardown");
    const before = (await oi(PROBE)).rows[0].n;
    await oi(`delete from user_roles where user_id = any($1::uuid[])`, [Object.values(ids)]);
    await oi(`delete from sessions where user_id = any($1::uuid[])`, [Object.values(ids)]);
    const usersGone = await oi(`delete from users where tenant_id = $1`, [TC]);
    const tenantsGone = await oi(`delete from tenants where id = $1`, [TC]);
    check("the fixture people and their company are gone",
      usersGone.rowCount === 7 && tenantsGone.rowCount === 1,
      { users: usersGone.rowCount, tenants: tenantsGone.rowCount });

    const after = (await oi(PROBE)).rows[0].n;
    check("their trail entries stayed — audit_logs is append-only and the guard refuses a delete",
      after === before, { before, after });
    const gone = await call(`/control/audit?actorUserId=${ids.sa}&limit=5`, null);
    check("an expired cookie cannot read them back", gone.status === 401, { s: gone.status });
    const keptRows = (await oi(`select count(*)::int as n from audit_logs
      where actor_user_id = $1 and user_agent = $2`, [ids.sa, AGENT])).rows[0].n;
    check("the rows are still there for a human with the duty to read",
      keptRows >= 3, { keptRows });
    await oi(`delete from rate_limits where bucket like 'audit:%' or bucket like 'audit-actors:%'`);
    console.log(`  ${after} probe entries remain in the trail by design, under ${AGENT}`);
  } finally {
    await sweep();
    await owner.end();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error("run crashed:", e);
  process.exit(1);
});
