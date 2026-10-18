/**
 * Live proof for migration 071 — the forensic actor register (task #119).
 *
 * A SECURITY DEFINER body is invisible to EXPLAIN and unvalidated at CREATE time, so the
 * only proof that a reader works is calling it. This one is called against fixtures that
 * are written inside ONE transaction and rolled back at the end: audit_logs is append-only
 * (its guard trigger covers UPDATE and DELETE, not INSERT), so a suite that committed its
 * probes would leave fake entries in the real trail forever. Nothing here outlives the run,
 * including the fixture account it creates to prove the soft-delete rule.
 *
 * The register's contract is a set of claims about grouping, and each needs a different
 * shape of data: one person across several companies (so `tenants_touched` counts the
 * companies named on their rows while the company column stays their own), an actor-less
 * row (so the register of people can be shown to exclude it while the trail keeps it), an
 * empty address (so the address count can be shown not to count it), a window edge, a
 * filter that must key on the person's own tenant rather than the row's, and a soft-
 * deleted account. A suite that only checked "it returns rows" would pass with any three of
 * those broken.
 *
 * Run: npx tsx scripts/verify-control-forensics-sql.ts   (DNS_FALLBACK=1 if DNS broken)
 */
import "dotenv/config";
import pg from "pg";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else {
    failures++;
    console.log("FAIL ", label,
      (typeof detail === "string" ? detail : JSON.stringify(detail ?? null) ?? "").slice(0, 700));
  }
}

const REGISTER = "platform_auth.list_audit_actors_for_control";
const OUT_COLS = [
  "actor_user_id", "actor_name", "actor_email", "actor_type", "account_status",
  "tenant_id", "tenant_name", "events", "distinct_actions", "distinct_entities",
  "distinct_ips", "tenants_touched", "first_seen", "last_seen"
];

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

  // ============================================================
  // 1. catalog posture
  // ============================================================
  console.log("\n-- catalog");
  check("071 is recorded as applied",
    !!(await owner.query(
      `select 1 from schema_migrations where name = '071_forensic_actor_register.sql'`)).rowCount);

  const fn = (await owner.query(
    `select p.prosecdef, p.proconfig, pg_get_function_arguments(p.oid) as args,
            pg_get_function_result(p.oid) as ret, p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = 'list_audit_actors_for_control'`)).rows;
  check("exactly one register function exists", fn.length === 1, fn.map(f => f.args));
  const body = fn[0] ?? { args: "", ret: "", prosecdef: false, proconfig: null };
  check("it is SECURITY DEFINER", body.prosecdef === true);
  check("its search_path is pinned",
    JSON.stringify(body.proconfig ?? '').includes("search_path=public"), body.proconfig);
  // pg renders the types in their long form, so the assertion reads the way the catalog
  // speaks rather than the way the migration was typed.
  check("it takes the four filters 071 declares",
    /p_tenant_id uuid/.test(body.args) && /p_from timestamp with time zone/.test(body.args)
      && /p_to timestamp with time zone/.test(body.args) && /p_limit integer/.test(body.args), body.args);
  check("every argument has a default, so the desk can send nulls positionally",
    (body.args.match(/DEFAULT/gi) ?? []).length === 4, body.args);
  for (const c of OUT_COLS) {
    check(`${c} is one of the returned columns`, new RegExp(`\\b${c}\\b`).test(body.ret), body.ret);
  }

  // The register is counts and clocks. A payload column here would be a second,
  // un-redacted path to the same rows the trail already protects.
  check("no payload column is returned",
    !/\bbefore\b|\bafter\b|\buser_agent\b|\brequest_id\b/i.test(body.ret), body.ret);

  const acl = (await owner.query(
    `select pg_get_userbyid(grantee) as who, privilege_type
       from aclexplode(coalesce((select proacl from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname='platform_auth' and p.proname='list_audit_actors_for_control'), '{}'::aclitem[]))`)).rows;
  const holders = acl.filter(a => a.privilege_type === "EXECUTE").map(a => a.who);
  check("app_runtime holds EXECUTE", holders.includes("app_runtime"), holders);
  check("nothing else holds EXECUTE — no public, no anon, no authenticated, no service_role",
    !holders.some(h => ["public", "anon", "authenticated", "service_role"].includes(h)), holders);
  check("the ACL has no grantor row for PUBLIC (a new definer belongs to PUBLIC until told)",
    !acl.some(a => a.who === "public"), acl);

  const idx = (await owner.query(
    `select indexname from pg_indexes where tablename = 'audit_logs'`)).rows.map(r => r.indexname);
  check("066's actor index is still what a person lookup runs on",
    idx.includes("idx_audit_actor_ts"), idx);

  // ============================================================
  // 2. behaviour, on fixtures that never commit
  // ============================================================
  console.log("\n-- behaviour (one transaction, rolled back)");
  await owner.query("begin");

  const platformTenant = (await owner.query(
    `select id from tenants where type = 'platform' order by id limit 1`)).rows[0];
  const companyTenants = (await owner.query(
    `select id from tenants where type <> 'platform' order by id limit 2`)).rows;
  check("a platform tenant and two company tenants exist to hang fixtures on",
    !!platformTenant && companyTenants.length === 2, { platformTenant, companyTenants });

  // Seats are created here and vanish with the rollback. That is deliberate: a real seat
  // already carries an unknown number of trail entries, so its counts would prove nothing,
  // while a brand-new account's every number is exact.
  let n = 0;
  const mkSeat = async (tenant: string, type: string, who: string) => (await owner.query(
    `insert into users (tenant_id, user_type, full_name, email, status)
     values ($1, $2, $3, $4, 'active') returning id, tenant_id`,
    [tenant, type, `VERIFY071 Seat ${++n}`, `v071.${who}${n}@verify.test`])).rows[0];

  const plat0 = await mkSeat(platformTenant.id, "platform", "plat");
  const comp0 = await mkSeat(companyTenants[0].id, "staff", "comp");
  const ghost0 = await mkSeat(companyTenants[0].id, "staff", "ghost");

  // A soft-deleted account must stay in the register: the person did the work while they
  // existed, and a forensic screen that hides them is worse than one that shows the status.
  await owner.query(`update users set deleted_at = now(), status = 'deactivated' where id = $1`, [ghost0.id]);

  const F = {
    platformSeat: { id: plat0.id, tenant: plat0.tenant_id },
    companySeat: { id: comp0.id, tenant: comp0.tenant_id, otherTenant: companyTenants[1].id },
    ghost: { id: ghost0.id, tenant: ghost0.tenant_id }
  };

  let seq = 0;
  const stamp = () => `verify071.${(++seq)}`;
  const log = (actor: string | null, rowTenant: string | null, action: string,
    entity: string, ip: string, minsAgo: number, before: object | null, after: object | null) =>
    owner.query(
      `insert into audit_logs (ts, tenant_id, actor_user_id, actor_role, ip, user_agent,
                                request_id, entity, entity_id, action, "before", "after")
       values (now() - make_interval(mins => $1), $2, $3, 'verify_role', $4, 'verify071',
               $5, $6, null, $7, $8, $9)`,
      [minsAgo, rowTenant, actor, ip, stamp(), entity, action, before, after]);

  // The platform seat: three entries, three actions, three entities and three companies named
  // on its rows — spread at 10 minutes, 26 hours and 70 days so the windows differ. One
  // entry carries an empty address, which the address count must not count.
  await log(F.platformSeat.id, F.platformSeat.tenant, "control.tenants.activated", "tenants", "41.79.1.1", 10,
    { status: "trial", note: "kept" }, { status: "active", note: "kept" });
  await log(F.platformSeat.id, F.companySeat.tenant, "control.plans.corrected", "plans", "41.79.1.1", 26 * 60,
    { amount: 1 }, { amount: 2 });
  await log(F.platformSeat.id, F.companySeat.otherTenant, "control.announcements.published", "system_announcements",
    "", 70 * 24 * 60, null, { title: "x" });

  // The company seat: five entries, one action, one company, one address, the newest last.
  for (let i = 0; i < 4; i++) {
    await log(F.companySeat.id, F.companySeat.tenant, "drivers.updated", "drivers", "196.10.2.2", 20 + i * 5,
      { nida_search: "hash-that-must-not-appear" }, { nida_search: "other-hash" });
  }
  await log(F.companySeat.id, F.companySeat.tenant, "drivers.created", "drivers", "196.10.2.2", 15,
    null, { full_name: "a driver" });

  // The soft-deleted account: one entry, sixty minutes old.
  await log(F.ghost.id, F.ghost.tenant, "documents.uploaded", "documents", "196.10.3.3", 60,
    null, { kind: "avatar" });

  // Not a person: an attempt against an identity that does not exist (step 8's shape).
  await log(null, null, "login_failed.unknown", "users", "203.0.113.9", 25, null, null);

  const all = (await owner.query(`select * from ${REGISTER}(null, null, null, 500)`)).rows;
  const mine = all.filter(r => [F.platformSeat.id, F.companySeat.id, F.ghost.id].includes(r.actor_user_id));

  check("one row per person, not one per person-and-company",
    mine.length === 3, mine.map(r => ({ id: r.actor_user_id.slice(0, 4), t: r.tenant_name })));

  const plat = mine.find(r => r.actor_user_id === F.platformSeat.id) ?? {};
  const comp = mine.find(r => r.actor_user_id === F.companySeat.id) ?? {};
  const gh = mine.find(r => r.actor_user_id === F.ghost.id) ?? {};

  check("the platform seat's three entries are counted", plat.events === 3, plat);
  check("its three distinct actions are counted", plat.distinct_actions === 3, plat);
  check("its three distinct entities are counted", plat.distinct_entities === 3, plat);
  check("it is shown touching three companies — the cross-tenant number a desk needs",
    plat.tenants_touched === 3, plat);
  check("the company on its row is its OWN company, not the one it acted on",
    plat.tenant_id === F.platformSeat.tenant, { want: F.platformSeat.tenant, got: plat.tenant_id });

  check("an empty address is not counted as a source", plat.distinct_ips === 1, plat);
  check("the company seat's single address counts once", comp.distinct_ips === 1, comp);
  check("the company seat's five entries are counted", comp.events === 5, comp);
  check("its two actions and one entity are counted",
    comp.distinct_actions === 2 && comp.distinct_entities === 1, comp);
  check("a company seat that only touched its own company reads as one, not several",
    comp.tenants_touched === 1, comp);

  check("a soft-deleted account stays in the register, with its status on the row",
    !!gh.actor_user_id && gh.account_status === "deactivated", gh);
  check("the register carries no payload and so leaked nothing of the redacted columns",
    !JSON.stringify(mine).includes("hash-that-must-not-appear"), JSON.stringify(mine).slice(0, 300));
  check("every email the register returns is lower-cased",
    mine.every(r => (r.actor_email ?? "") === (r.actor_email ?? "").toLowerCase()),
    mine.map(r => r.actor_email));

  check("an entry with no actor is not a person and stays out of the register",
    !all.some(r => String(r.actor_user_id) === "null" || r.actor_user_id === null),
    all.filter(r => !r.actor_user_id));
  const trail = (await owner.query(
    `select * from platform_auth.list_audit_for_control(null,null,null,'login_failed.unknown',null,null,null,5)`)).rows;
  check("…while the trail keeps it, with no actor to name",
    trail.length >= 1 && trail[0].actor_user_id === null, trail[0]);

  check("the list is ordered by most recent activity",
    all.every((r, i) => i === 0 || new Date(all[i - 1].last_seen) >= new Date(r.last_seen)),
    all.slice(0, 3).map(r => r.last_seen));

  // A seventy-day-old entry must not appear in a 30-day window for that same person, and a
  // 26-hour entry must not appear in a one-day one.
  const month = (await owner.query(
    `select * from ${REGISTER}(null, now() - interval '30 days', null, 500)`)).rows
    .find(r => r.actor_user_id === F.platformSeat.id);
  check("a 30-day window keeps this person but drops their 70-day entry",
    !!month && month.events === 2 && month.tenants_touched === 2,
    month && { events: month.events, touched: month.tenants_touched });

  const day = (await owner.query(
    `select * from ${REGISTER}(null, now() - interval '1 day', null, 500)`)).rows
    .find(r => r.actor_user_id === F.platformSeat.id);
  check("a 24-hour window drops the 26-hour entry too",
    !!day && day.events === 1 && day.distinct_actions === 1,
    day && { events: day.events, actions: day.distinct_actions });

  const nothing = (await owner.query(
    `select * from ${REGISTER}(null, now() + interval '1 day', null, 500)`)).rows;
  check("a window that has not opened yet answers empty rather than erroring",
    nothing.length === 0, nothing.length);

  // The filter is about the person: the company seat is found by its OWN tenant even though
  // every row it wrote names that same tenant, and is NOT found by an unrelated one.
  const byOwn = (await owner.query(
    `select * from ${REGISTER}($1, null, null, 500)`, [F.companySeat.tenant])).rows;
  check("filtering by a company finds its own people",
    byOwn.some(r => r.actor_user_id === F.companySeat.id), byOwn.length);
  const byOther = (await owner.query(
    `select * from ${REGISTER}($1, null, null, 500)`, [F.companySeat.otherTenant])).rows;
  check("filtering by a company a seat merely acted upon does not claim it as theirs",
    !byOther.some(r => r.actor_user_id === F.companySeat.id), byOther.length);
  check("…and the platform seat is not returned for a company tenant at all",
    !byOther.some(r => r.actor_user_id === F.platformSeat.id), byOther.length);

  const floored = (await owner.query(`select * from ${REGISTER}(null,null,null,0)`)).rows;
  const greedy = (await owner.query(`select * from ${REGISTER}(null,null,null,99999)`)).rows;
  const negative = (await owner.query(`select * from ${REGISTER}(null,null,null,-5)`)).rows;
  check("a limit of zero is floored to one, not to nothing", floored.length === 1, floored.length);
  check("a huge limit is capped at 500", greedy.length <= 500, greedy.length);
  check("a negative limit is floored, not an error", negative.length === 1, negative.length);

  const toOnly = (await owner.query(
    `select * from ${REGISTER}(null, null, now() - interval '50 minutes', 500)`)).rows
    .find(r => r.actor_user_id === F.platformSeat.id);
  check("the upper bound keeps only what happened before it",
    !!toOnly && toOnly.events === 2 && new Date(toOnly.last_seen) <= new Date(Date.now() - 50 * 60000),
    toOnly && { events: toOnly.events, last_seen: toOnly.last_seen });

  await owner.query("rollback");
  console.log("  fixtures rolled back — the trail kept nothing this run wrote");

  // ============================================================
  // 3. the live grant, as the API's own role
  // ============================================================
  console.log("\n-- as app_runtime");
  const app = new pg.Client({ connectionString: appUrl() ?? ownerUrl(), ssl: { rejectUnauthorized: false } });
  await app.connect();
  const live: any = await app.query(`select * from ${REGISTER}(null, null, null, 25)`).catch(e => e);
  check("app_runtime may execute the register (this is the route's only call)",
    Array.isArray(live.rows), live.message ?? live);
  if (Array.isArray(live.rows)) {
    check("a real window answers with real people", live.rows.length > 0, live.rows.length);
    check("the numbers are integers, not strings",
      live.rows.every((r: any) => typeof r.events === "number" && typeof r.tenants_touched === "number"),
      live.rows[0] && typeof live.rows[0].events);
    check("no payload key appears anywhere in a live answer",
      !JSON.stringify(live.rows).includes("\"before\""), JSON.stringify(live.rows[0] ?? {}).slice(0, 400));
    check("first_seen never postdates last_seen",
      live.rows.every((r: any) => new Date(r.first_seen) <= new Date(r.last_seen)),
      live.rows.slice(0, 3).map((r: any) => [r.first_seen, r.last_seen]));
    console.log(`  live register: ${live.rows.length} people, most recent ${live.rows[0]?.actor_name ?? "—"} `
      + `· ${live.rows[0]?.events ?? 0} entries`);
  }

  const asAnon = await app.query(
    `select has_function_privilege('anon', '${REGISTER}(uuid,timestamptz,timestamptz,int)', 'execute') as v`)
    .catch(() => ({ rows: [{ v: null }] }));
  check("anon holds no EXECUTE on the register", asAnon.rows[0].v === false, asAnon.rows[0]);
  const asAuthenticated = await app.query(
    `select has_function_privilege('authenticated', '${REGISTER}(uuid,timestamptz,timestamptz,int)', 'execute') as v`)
    .catch(() => ({ rows: [{ v: null }] }));
  check("a browser role holds no EXECUTE either",
    asAuthenticated.rows[0].v === false, asAuthenticated.rows[0]);

  await app.end();

  // ============================================================
  // 4. residue
  // ============================================================
  console.log("\n-- residue");
  const left = await owner.query(
    `select (select count(*) from audit_logs where user_agent = 'verify071') as entries,
            (select count(*) from users where email like 'v071.%@verify.test') as accounts`);
  check("not one probe entry survived the rollback", left.rows[0].entries === "0", left.rows[0]);
  check("the fixture account is gone too", left.rows[0].accounts === "0", left.rows[0]);

  await owner.end();

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error("run crashed:", e);
  process.exit(1);
});
