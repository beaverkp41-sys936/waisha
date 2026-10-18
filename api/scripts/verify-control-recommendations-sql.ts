/**
 * Live proof for migration 070 — the recommendation inbox (task #118).
 *
 * The rule every one of these scripts has been built on: EXPLAIN cannot see inside a
 * SECURITY DEFINER body and a plpgsql body is not validated at CREATE time, so both
 * definers are proven by calling them, and the table's CHECK constraints by trying to
 * break them.
 *
 * The interesting part is the split. 070 deliberately puts NO definer on the author's
 * write, because the row lives in the author's own tenant and RLS already holds that door.
 * So the checks come in two families: everything an author does is proven through
 * row-level security as app_runtime (own rows visible, a stranger's row invisible and
 * unwritable, DELETE refused for want of a grant), and everything the desk does is proven
 * through the definers (one list across every company, a decision written into somebody
 * else's tenant). A suite that mixed the two would pass while hiding a hole.
 *
 * An insert made here and the register call that must show it run on ONE connection: the
 * register bypasses RLS but not the transaction, so an uncommitted note is only ever
 * visible to the session that wrote it.
 *
 * Every refusal is attempted inside its own SAVEPOINT. A failed statement aborts a
 * Postgres transaction, so a suite that expected errors without one would spend its first
 * red check reporting that everything afterwards was broken.
 *
 * Run: npx tsx scripts/verify-control-recommendations-sql.ts   (DNS_FALLBACK=1 if DNS broken)
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

const REGISTER = "platform_auth.control_recommendation_register";
const DECIDE = "platform_auth.record_recommendation_decision";
const FUNCS = ["control_recommendation_register", "record_recommendation_decision"];
const STATUSES = ["new", "reviewing", "planned", "built", "declined"];

const WRITE_SEATS = ["checkpoint_clerk", "customer_service", "director", "dispatcher", "driver",
  "finance_officer", "fleet_manager", "general_manager", "hr_officer", "operations_manager",
  "seeker", "shipper", "shipper_portal", "trainee", "workshop_manager"];
const VIEW_ONLY_EXTRA = ["auditor", "billing_admin", "compliance_officer",
  "customer_service_agent", "platform_analyst", "support_engineer"];
const DESK_VIEW = ["compliance_officer", "customer_service_agent", "platform_analyst",
  "super_admin", "support_engineer"];
const DESK_MANAGE = ["customer_service_agent", "super_admin"];

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

/** Delete anything a previous — possibly crashed — run left behind, matched by fixture names. */
async function sweepFixtures(c: pg.Client, when: string) {
  const ids = (await c.query(
    `select id from tenants where name like 'VERIFY070 %'`)).rows.map(r => r.id);
  if (!ids.length) return;
  const notes = await c.query(`delete from recommendations where tenant_id = any($1::uuid[])`, [ids]);
  const users = await c.query(`delete from users where email like 'v070.%@verify.test'`);
  const tenants = await c.query(`delete from tenants where id = any($1::uuid[])`, [ids]);
  console.log(`  swept ${when}: ${notes.rowCount ?? 0} notes, ${users.rowCount ?? 0} users, `
    + `${tenants.rowCount ?? 0} tenants`);
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();
  // A run that crashed half way leaves its fixtures behind, and the register counts are
  // absolute — a second run on top of them reads as a broken definer. Sweep first.
  await sweepFixtures(owner, "before the run");

  // ============================================================
  // 1. catalog posture
  // ============================================================
  console.log("\n-- catalog");
  check("070 is recorded as applied",
    !!(await owner.query(
      `select 1 from schema_migrations where name = '070_recommendation_inbox.sql'`)).rowCount);

  const cols = (await owner.query(
    `select column_name, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'recommendations'
      order by ordinal_position`)).rows;
  check("the register exists with the 18 columns 070 declares",
    cols.length === 18, cols.map(c => c.column_name));
  for (const required of ["tenant_id", "author_user_id", "area", "title", "body", "status"]) {
    check(`${required} is NOT NULL`,
      cols.find(c => c.column_name === required)?.is_nullable === "NO", required);
  }
  check("priority, reply, the decided and replied pairs and deleted_at are the nullable ones",
    ["priority", "reply", "decided_by", "decided_at", "replied_by", "replied_at", "deleted_at"]
      .every(c => cols.find(x => x.column_name === c)?.is_nullable === "YES"));

  const rls = (await owner.query(
    `select relrowsecurity as on_ from pg_class
      where relname = 'recommendations' and relnamespace = 'public'::regnamespace`)).rows[0];
  check("RLS is enabled on recommendations", rls?.on_ === true, rls);

  const pols = (await owner.query(
    `select polcmd, pg_get_expr(polqual, polrelid) as using_,
            pg_get_expr(polwithcheck, polrelid) as check_
       from pg_policy where polname = 'recommendations_tenant'`)).rows;
  check("exactly one policy, FOR ALL, keyed on app.tenant_id on both sides",
    pols.length === 1 && pols[0].polcmd === "*"
    && String(pols[0].using_).includes("app.tenant_id")
    && String(pols[0].check_).includes("app.tenant_id"), pols);

  const tblAcl = (await owner.query(
    `select grantee, privilege_type from information_schema.table_privileges
      where table_schema = 'public' and table_name = 'recommendations'`)).rows;
  const runtime = tblAcl.filter(r => r.grantee === "app_runtime").map(r => r.privilege_type).sort();
  check("app_runtime holds SELECT, INSERT and UPDATE — and no DELETE",
    JSON.stringify(runtime) === JSON.stringify(["INSERT", "SELECT", "UPDATE"]), runtime);
  check("…so a withdrawn note stays on the record as an update, never an erased row",
    !runtime.includes("DELETE"), runtime);

  const idx = (await owner.query(
    `select indexname from pg_indexes where tablename = 'recommendations'`)).rows
    .map(r => r.indexname).sort();
  check("the three partial indexes exist (author, queue, area) on top of the key",
    idx.length === 4 && ["idx_recommendations_area", "idx_recommendations_author",
      "idx_recommendations_queue"].every(i => idx.includes(i)), idx);

  const shape = (await owner.query(
    `select p.proname, p.prosecdef, p.prorettype::regtype::text as returns,
            p.provolatile as vol,
            coalesce((select string_agg(x, ',') from unnest(p.proconfig) x
                       where x like 'search_path%'), '') as cfg
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [FUNCS])).rows;
  for (const f of FUNCS) {
    const row = shape.find(s => s.proname === f);
    check(`${f} exists in platform_auth`, !!row, shape.map(s => s.proname));
    if (!row) continue;
    check(`${f} is SECURITY DEFINER with a pinned search_path`,
      row.prosecdef === true && row.cfg === "search_path=public",
      { definer: row.prosecdef, cfg: row.cfg });
    check(`${f} returns a record, not a jsonb blob the desk would have to parse`,
      row.returns === "record", row.returns);
  }
  check("the register is STABLE and the decision VOLATILE",
    shape.find(s => s.proname === REGISTER.split(".")[1])?.vol === "s"
    && shape.find(s => s.proname === DECIDE.split(".")[1])?.vol === "v",
    shape.map(s => `${s.proname}:${s.vol}`));

  const fnAcl = (await owner.query(
    `select p.proname, pg_get_userbyid(ac.grantee) as grantee, ac.privilege_type
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
       lateral aclexplode(p.proacl) ac
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [FUNCS])).rows;
  for (const f of FUNCS) {
    const g = fnAcl.filter(a => a.proname === f);
    check(`app_runtime holds EXECUTE on ${f}`,
      g.some(a => a.grantee === "app_runtime" && a.privilege_type === "EXECUTE"),
      g.map(a => `${a.grantee}:${a.privilege_type}`));
    check(`${f} is not reachable from PUBLIC, anon, authenticated or service_role`,
      !g.some(a => ["public", "anon", "authenticated", "service_role"].includes(a.grantee)),
      g.map(a => `${a.grantee}:${a.privilege_type}`));
  }

  // ============================================================
  // 2. the duties
  // ============================================================
  console.log("\n-- duties");
  const keys = (await owner.query(
    `select key, coalesce(description, '') as description from permissions
      where key like '%recommend%' order by key`)).rows;
  check("all four keys exist, each with a sentence a person can read",
    keys.length === 4 && keys.every(k => k.description.length > 10), keys);

  const holdersOf = async (key: string) => (await owner.query(
    `select r.key from role_permissions rp join roles r on r.id = rp.role_id
      where rp.permission_key = $1 and r.tenant_id is null and r.deleted_at is null
      order by r.key`, [key])).rows.map((r: any) => r.key);

  const writeHolders = await holdersOf("recommendations.write");
  const viewHolders = await holdersOf("recommendations.view");
  const deskView = await holdersOf("control.recommendations.view");
  const deskManage = await holdersOf("control.recommendations.manage");

  check("every writing seat is the list 070 names",
    JSON.stringify(writeHolders) === JSON.stringify([...WRITE_SEATS].sort()), writeHolders);
  check("…and every writer can also read, so nobody sends into a void",
    writeHolders.every(w => viewHolders.includes(w)),
    writeHolders.filter(w => !viewHolders.includes(w)));
  check("the read-only seats hold the view but not the pen",
    VIEW_ONLY_EXTRA.every(v => viewHolders.includes(v) && !writeHolders.includes(v)),
    VIEW_ONLY_EXTRA.filter(v => !viewHolders.includes(v) || writeHolders.includes(v)));
  check("an auditor cannot gain a pen by reading its own outbox",
    viewHolders.includes("auditor") && !writeHolders.includes("auditor"));
  check("driver and trainee hold the pen — the two seats with no other way to be heard",
    writeHolders.includes("driver") && writeHolders.includes("trainee"), writeHolders);
  check("a seeker can send and read, on the same keys the staff portal uses",
    writeHolders.includes("seeker") && viewHolders.includes("seeker"));
  check("a shipper can too, since its complaint used to end as a phone call",
    writeHolders.includes("shipper") && writeHolders.includes("shipper_portal"));
  check("the desk reads the register with exactly the five seats 070 lists",
    JSON.stringify(deskView) === JSON.stringify([...DESK_VIEW].sort()), deskView);
  check("…and answers with exactly two",
    JSON.stringify(deskManage) === JSON.stringify([...DESK_MANAGE].sort()), deskManage);
  check("every desk manager can also read, so the panel never opens a door it cannot see",
    deskManage.every(m => deskView.includes(m)), deskManage);
  check("platform_analyst measures the inbox but does not close cards",
    deskView.includes("platform_analyst") && !deskManage.includes("platform_analyst"));
  check("super_admin's copy of each desk key came from this migration, not from 005",
    (await owner.query(
      `select count(*)::int as n from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'super_admin' and r.tenant_id is null
          and rp.permission_key in ('control.recommendations.view','control.recommendations.manage')`
    )).rows[0].n === 2);

  // ============================================================
  // 3. fixtures
  // ============================================================
  console.log("\n-- fixtures");
  const STAMP = Date.now().toString(36).toUpperCase();
  const tenantAName = `VERIFY070 A ${STAMP}`;
  const tenantBName = `VERIFY070 B ${STAMP}`;
  const tenantA = (await owner.query(
    `insert into tenants (id, name, type, status)
     values (gen_random_uuid(), $1, 'transporter', 'active') returning id`,
    [tenantAName])).rows[0].id;
  const tenantB = (await owner.query(
    `insert into tenants (id, name, type, status)
     values (gen_random_uuid(), $1, 'seeker', 'active') returning id`,
    [tenantBName])).rows[0].id;
  const mkUser = async (tid: string, type: string, name: string, job: string | null) =>
    (await owner.query(
      `insert into users (id, tenant_id, user_type, full_name, email, job_title, status)
       values (gen_random_uuid(), $1, $2, $3,
               'v070.' || substr(md5(random()::text), 1, 10) || '@verify.test', $4, 'active')
       returning id, email, full_name`, [tid, type, name, job])).rows[0];
  const dispatcher = await mkUser(tenantA, "staff", "Dala Mrema", "Dispatcher");
  const director = await mkUser(tenantA, "staff", "Neema Joseph", "Director");
  const seekerUser = await mkUser(tenantB, "seeker", "Baraka Ngowi", null);
  const actor = await mkUser(tenantA, "platform", "Verify Desk", null);

  /** created_at is set from an age in hours so the register's ordering is provable, not lucky. */
  const note = async (tid: string, authorId: string, area: string, title: string, body: string,
    extra: { age: number; status?: string; priority?: string; reply?: string;
      replied_by?: string; decided_by?: string }) => {
    const then = new Date(Date.now() - extra.age * 3600_000).toISOString();
    return (await owner.query(
      `insert into recommendations (tenant_id, author_user_id, area, title, body, created_at,
           status, priority, reply, replied_by, replied_at, decided_by, decided_at, created_by)
       values ($1,$2,$3,$4,$5, $6::timestamptz,
               coalesce($7::text,'new'), $8, $9, $10::uuid,
               case when $10::uuid is null then null else $6::timestamptz end,
               $11::uuid,
               case when $11::uuid is null then null else $6::timestamptz end,
               $2)
       returning id, created_at, status`,
      [tid, authorId, area, title, body, then, extra.status ?? null, extra.priority ?? null,
       extra.reply ?? null, extra.replied_by ?? null, extra.decided_by ?? null])).rows[0];
  };

  const rows = {
    aNew: await note(tenantA, dispatcher.id, "transport",
      "The trip form makes me retype the plate on every leg",
      "Plate, driver and route are already on the trip. On a three-leg day I type the same plate four times.",
      { age: 1 }),
    aTriaged: await note(tenantA, director.id, "billing",
      "Show which week a seeker payment reference belongs to",
      "When the office confirms a weekly pass I cannot tell from the invoice which week it opened.",
      { age: 5, status: "reviewing", priority: "high", decided_by: actor.id }),
    bAnswered: await note(tenantB, seekerUser.id, "marketplace",
      "Let me search by the ward the cargo is going to, not only where it starts",
      "Every job I have is destination-led. The search only takes the origin ward.",
      { age: 3, status: "planned", priority: "medium",
        reply: "Destination search is on the board for the next directory pass.",
        replied_by: actor.id, decided_by: actor.id }),
    bDeclined: await note(tenantB, seekerUser.id, "account",
      "Let me pick my own company name on the meter",
      "My account shows a placeholder company and I cannot change it.",
      { age: 4, status: "declined",
        reply: "A seeker account is one person, so there is no company name to show.",
        replied_by: actor.id, decided_by: actor.id })
  };
  const withdrawn = await note(tenantA, dispatcher.id, "other",
    "This one was mis-posted and pulled back",
    "Sent in error, then withdrawn before anybody read it.", { age: 0 });
  await owner.query(`update recommendations set deleted_at = now() where id = $1`, [withdrawn.id]);

  check("five notes on the register, one of them withdrawn",
    (await owner.query(
      `select count(*)::int as n from recommendations where tenant_id = any($1::uuid[])`,
      [[tenantA, tenantB]])).rows[0].n === 5);

  // The register is cross-tenant on purpose, so its counts are "our four plus whatever
  // other companies already had". Measuring that first keeps a live note from reading as
  // a broken definer.
  const base = (await owner.query(
    `select count(*)::int as n, count(*) filter (where status = 'new')::int as n_new
       from recommendations where deleted_at is null and tenant_id <> all($1::uuid[])`,
    [[tenantA, tenantB]])).rows[0];
  const EXPECT = 4 + base.n;
  const EXPECT_NEW = 1 + base.n_new;
  const fixture = new Set<string>([...Object.values(rows).map(r => r.id), withdrawn.id]);
  const ours = (list: any[]) => list.filter(r => fixture.has(r.id));
  if (base.n) console.log(`  (baseline: ${base.n} other companies' notes already on the register)`);

  // ============================================================
  // 4. the desk's register — as app_runtime, the way the route calls it
  // ============================================================
  console.log("\n-- the register");
  const app = new pg.Client({ connectionString: appUrl()!, ssl: { rejectUnauthorized: false } });
  await app.connect();
  await app.query("begin");

  let spCount = 0;
  /** Run one statement inside its own savepoint, so an expected refusal is survivable. */
  async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: boolean; out?: T; code: string; message: string }> {
    const name = `sp_${(spCount++).toString(36)}`;
    await app.query(`savepoint ${name}`);
    try {
      const out = await fn();
      await app.query(`release savepoint ${name}`);
      return { ok: true, out, code: "", message: "" };
    } catch (e: any) {
      await app.query(`rollback to savepoint ${name}`);
      return { ok: false, out: undefined, code: String(e?.code ?? ""),
        message: String(e?.message ?? "").split("\n")[0] };
    }
  }

  const readRegister = async (status: string | null = null, area: string | null = null,
    priority: string | null = null, q: string | null = null, limit: number | null = null) =>
    (await app.query(`select * from ${REGISTER}($1,$2,$3,$4,$5)`,
      [status, area, priority, q, limit])).rows;
  const allRaw = await readRegister();
  const all = ours(allRaw);
  check("the register answers across every company at once — the reason it is a definer",
    all.length === 4 && new Set(all.map(r => r.tenant_id)).size === 2,
    all.map((r: any) => `${r.company_name}:${r.status}`));
  check("…while the same session's bare read answers nothing, which is the failure 066 was written against",
    (await app.query(`select count(*)::int as n from recommendations`)).rows[0].n === 0);
  check("the withdrawn note is not on the register",
    !allRaw.some(r => r.id === withdrawn.id));
  check("matched and matched_new describe the filtered set, not the rows shown",
    all.every(r => r.matched === EXPECT && r.matched_new === EXPECT_NEW),
    all.map((r: any) => `${r.matched}/${r.matched_new} vs ${EXPECT}/${EXPECT_NEW}`));
  check("the desk is given who to call back: name, address, duty and company",
    all.every(r => r.author_name && r.author_email && r.company_name && r.company_type),
    all.map((r: any) => [r.author_name, r.author_email, r.company_name]));
  check("…and nothing wider — no phone, no NIDA, nothing from the company's own data",
    !Object.keys(all[0]).some(k => /phone|nida|password|token|secret|encrypt/.test(k)),
    Object.keys(all[0]));
  check("a seeker's own tenant type arrives, so the desk knows it is not a company",
    all.find(r => r.id === rows.bAnswered.id)?.company_type === "seeker");
  check("the author's job title travels with the note",
    all.find(r => r.id === rows.aTriaged.id)?.author_job_title === "Director");
  check("the reply carries the person who wrote it, not just the sentence",
    all.find(r => r.id === rows.bAnswered.id)?.replied_by_name === "Verify Desk");
  check("a triaged card with no answer says who triaged it",
    all.find(r => r.id === rows.aTriaged.id)?.decided_by_name === "Verify Desk"
    && all.find(r => r.id === rows.aTriaged.id)?.reply === null,
    all.find(r => r.id === rows.aTriaged.id));
  check("unread first, then newest — so the desk opens on what nobody has seen",
    JSON.stringify(all.map((r: any) => r.id)) === JSON.stringify([
      rows.aNew.id, rows.bAnswered.id, rows.bDeclined.id, rows.aTriaged.id]),
    all.map((r: any) => `${r.status}:${r.created_at}`));

  const byStatus = await readRegister("new");
  // The window counts run before LIMIT but after WHERE: a filter changes them. That is the
  // honest shape — the desk header says "in this view", not "on the register".
  check("status filter: only the 'new' note, and its own counts follow the filter",
    ours(byStatus).length === 1 && ours(byStatus)[0].author_name === "Dala Mrema"
    && byStatus.every(r => r.matched === base.n_new + 1 && r.matched_new === base.n_new + 1),
    byStatus.map((r: any) => [r.status, r.matched, r.matched_new]));
  const billing = await readRegister(null, "billing");
  check("area filter finds the one billing note, by its author",
    billing.length === 1 && billing[0].author_name === "Neema Joseph", billing);
  const urgent = await readRegister(null, null, "high");
  check("priority filter", urgent.length === 1 && urgent[0].priority === "high", urgent);
  const inBody = await readRegister(null, null, null, "destination-led");
  check("search reaches the body of a sentence",
    inBody.length === 1 && inBody[0].id === rows.bAnswered.id, inBody);
  const inTitle = await readRegister(null, null, null, "retype");
  check("…the title…", inTitle.length === 1 && inTitle[0].id === rows.aNew.id, inTitle);
  const inAuthor = await readRegister(null, null, null, "Baraka");
  check("…the author…",
    inAuthor.length === 2 && ours(inAuthor).length === 2, inAuthor.map((r: any) => r.author_name));
  const inCompany = await readRegister(null, null, null, tenantAName);
  check("…and the company",
    inCompany.length === 2 && ours(inCompany).length === 2,
    inCompany.map((r: any) => r.company_name));
  check("a search that matches nothing returns nothing rather than everything",
    (await readRegister(null, null, null, "zzz-not-a-word")).length === 0);
  check("a blank search is not a filter",
    (await readRegister(null, null, null, "   ")).length === EXPECT);
  const two = await readRegister(null, null, null, null, 2);
  check("a limit of 2 is honoured", two.length === 2 && ours(two).length === 2, two.length);
  check(`…and the counts still report all ${EXPECT}, not the two shown`,
    two.every(r => r.matched === EXPECT));
  check("a limit of 0 is clamped up to 1, never to the whole table",
    (await readRegister(null, null, null, null, 0)).length === 1);
  check("a limit of 9,999 is clamped down to the cap without erroring",
    (await readRegister(null, null, null, null, 9999)).length === Math.min(EXPECT, 500));
  check("a status outside the vocabulary filters to nothing instead of being ignored",
    (await readRegister("shipped")).length === 0);
  check("two calls in a row agree — the register is STABLE, not a random sample",
    JSON.stringify(await readRegister()) === JSON.stringify(allRaw));

  // ============================================================
  // 5. the author's side, which must be pure RLS
  // ============================================================
  console.log("\n-- row-level security for the author");
  const scoped = async (tid: string, sql: string, params: any[] = []) => {
    await app.query("select set_config('app.tenant_id', $1, true)", [tid]);
    return (await app.query(sql, params)).rows;
  };

  const ownA = await scoped(tenantA,
    `select id, author_user_id from recommendations where deleted_at is null`);
  check("company A reads its own two live notes and no others",
    ownA.length === 2
    && ownA.every(r => [dispatcher.id, director.id].includes(r.author_user_id)), ownA);
  check("company B reads its own two",
    (await scoped(tenantB,
      `select id from recommendations where deleted_at is null`)).length === 2);
  check("a company cannot read a named stranger's note even by id",
    (await scoped(tenantA, `select id from recommendations where id = $1`,
      [rows.bAnswered.id])).length === 0);
  check("an author's list is scoped to the author, not the whole company",
    (await scoped(tenantA,
      `select id from recommendations where author_user_id = $1 and deleted_at is null`,
      [dispatcher.id])).length === 1);

  const freshR = await attempt(() => scoped(tenantA,
    `insert into recommendations (tenant_id, author_user_id, area, title, body, created_by)
     values ($1, $2, 'transport', 'A note written through RLS',
             'Inserted the way the portal route inserts it, with no definer anywhere in sight.', $2)
     returning id, status, created_at`, [tenantA, dispatcher.id]));
  check("an author inserts with no SECURITY DEFINER anywhere on the path",
    freshR.ok && (freshR.out as any)[0].status === "new", freshR);
  const freshId = freshR.ok ? (freshR.out as any)[0].id : "";
  check("…and the same statement lands on the desk's register, uncommitted and all",
    (await readRegister()).some(r => r.id === freshId));

  const crossWrite = await attempt(() => scoped(tenantB,
    `insert into recommendations (tenant_id, author_user_id, area, title, body)
     values ($1, $2, 'other', 'Writing into somebody else''s company',
             'This session is scoped to company B and names company A as the tenant.')`,
    [tenantA, seekerUser.id]));
  check("a tenant cannot write a row into another tenant",
    !crossWrite.ok && crossWrite.code === "42501", crossWrite);

  const del = await attempt(() => scoped(tenantA,
    `delete from recommendations where id = $1`, [freshId]));
  check("DELETE is refused for want of a grant",
    !del.ok && del.code === "42501", del);
  const pull = await scoped(tenantA,
    `update recommendations set deleted_at = now() where id = $1 returning id`, [freshId]);
  check("…so withdrawal is exactly that: an update to deleted_at",
    pull.length === 1, pull);

  const otherUpdate = await scoped(tenantB,
    `update recommendations set status = 'built', decided_by = $2, decided_at = now()
      where id = $1 returning id`, [rows.aTriaged.id, seekerUser.id]);
  check("a company cannot triage a stranger's card through RLS either",
    otherUpdate.length === 0, otherUpdate);

  const badInserts: Array<[string, string]> = [
    ["a title too short to act on",
      `insert into recommendations (tenant_id, author_user_id, title, body)
       values ($1,$2,'no','and a body long enough to pass its own rule')`],
    ["a body too short to act on",
      `insert into recommendations (tenant_id, author_user_id, title, body)
       values ($1,$2,'A title long enough','short')`],
    ["an area outside the vocabulary",
      `insert into recommendations (tenant_id, author_user_id, area, title, body)
       values ($1,$2,'warehouse','A title long enough','and a body long enough to pass')`],
    ["a status outside the vocabulary",
      `insert into recommendations (tenant_id, author_user_id, title, body, status)
       values ($1,$2,'A title long enough','and a body long enough to pass','shipped')`],
    ["a priority outside the vocabulary",
      `insert into recommendations (tenant_id, author_user_id, title, body, priority)
       values ($1,$2,'A title long enough','and a body long enough to pass','urgent')`],
    ["a card that left 'new' with nobody attached to the decision",
      `insert into recommendations (tenant_id, author_user_id, title, body, status)
       values ($1,$2,'A title long enough','and a body long enough to pass','built')`],
    ["an answer with nobody who answered it",
      `insert into recommendations (tenant_id, author_user_id, title, body, reply)
       values ($1,$2,'A title long enough','and a body long enough to pass','We built it.')`]
  ];
  for (const [label, sql] of badInserts) {
    const r = await attempt(() => scoped(tenantA, sql, [tenantA, dispatcher.id]));
    check(`the table refuses ${label}`, !r.ok && r.code === "23514", r);
  }

  // ============================================================
  // 6. the desk's decision
  // ============================================================
  console.log("\n-- the decision");
  await app.query("select set_config('app.tenant_id', $1, true)", [tenantA]);
  const decide = (id: string, status: string | null, priority: string | null,
    reply: string | null, actorId: string | null) =>
    app.query(`select * from ${DECIDE}($1,$2,$3,$4,$5)`,
      [id, status, priority, reply, actorId]).then(r => r.rows[0]);
  const card = (id: string) => readRegister().then(rs => ours(rs).find(r => r.id === id));

  /** A call that is meant to succeed still gets a savepoint: if the writer ever refuses,
   *  the rest of the suite runs and the teardown still fires. */
  const win = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    const r = await attempt(fn);
    if (!r.ok) check(`${label} — the writer refused the call itself`, false, `${r.code} ${r.message}`);
    return r.out as T | undefined;
  };

  const badStatus = await attempt(() => decide(rows.aNew.id, "shipped", null, null, actor.id));
  check("a status outside the vocabulary is a sentence, not a 23514",
    !badStatus.ok && badStatus.code === "P0001" && /not a state/.test(badStatus.message), badStatus);
  const unknownId = await attempt(() =>
    decide("00000000-0000-0000-0000-000000000000", "new", null, null, actor.id));
  check("a card that is not on the register is refused by name",
    !unknownId.ok && /not on the register/.test(unknownId.message), unknownId);
  const goneAway = await attempt(() => decide(withdrawn.id, "reviewing", null, null, actor.id));
  check("…and a withdrawn one counts as not on it",
    !goneAway.ok && /not on the register/.test(goneAway.message), goneAway);
  const badPriority = await attempt(() => decide(rows.aNew.id, "new", "urgent", null, actor.id));
  check("priority is high, medium or low — or nothing yet",
    !badPriority.ok && /high, medium or low/.test(badPriority.message), badPriority);
  const shortReply = await attempt(() => decide(rows.aNew.id, "new", null, "ok", actor.id));
  check("an answer is a sentence of five characters or nothing at all",
    !shortReply.ok && /at least five/.test(shortReply.message), shortReply);
  const longReply = await attempt(() => decide(rows.bDeclined.id, "declined", null,
    "x".repeat(2001), actor.id));
  check("an answer longer than 2,000 characters is bounced as a sentence too",
    !longReply.ok && /2,000/.test(longReply.message), longReply);
  const noActor = await attempt(() => decide(rows.aNew.id, "reviewing", null, null, null));
  check("a decision without a seat behind it is refused before the constraint answers",
    !noActor.ok && /needs the seat/.test(noActor.message), noActor);

  const sweep: Array<{ ok: boolean; code: string; message: string }> = [];
  for (const s of STATUSES) {
    sweep.push(await attempt(() => decide(rows.aTriaged.id, s, null, null, actor.id)));
  }
  check("every state the migration allows is accepted by the writer, in both directions",
    sweep.every(r => r.ok), sweep.map(r => `${r.code} ${r.message}`));

  const opened = await win("opening a card", () => decide(rows.aNew.id, "reviewing", "medium", null, actor.id));
  check("opening a card moves its state and returns the row it wrote",
    opened?.status === "reviewing" && opened?.id === rows.aNew.id, opened);
  const afterOpen = await card(rows.aNew.id);
  check("…stamps who triaged it and when",
    afterOpen?.decided_by_name === "Verify Desk" && !!afterOpen?.decided_at, afterOpen);
  check("…but does not invent an answer the desk never wrote",
    afterOpen?.reply === null && afterOpen?.replied_by_name === null, afterOpen);
  check("…and hands the desk the priority it set", opened?.priority === "medium", opened);

  const sameAgain = await win("re-recording a state", () => decide(rows.aNew.id, "reviewing", null, null, actor.id));
  const afterSame = await card(rows.aNew.id);
  check("re-recording the same state changes nothing — including the triage stamp",
    sameAgain?.status === "reviewing"
    && new Date(afterSame?.decided_at).getTime() === new Date(afterOpen?.decided_at).getTime(),
    { first: afterOpen?.decided_at, again: afterSame?.decided_at });

  const answered = await win("building and answering a card", () => decide(rows.aNew.id, "built", "high",
    "Shipped in the September release — the plate now carries across every leg.", actor.id));
  check("a card can be built and answered in one act",
    answered?.status === "built" && answered?.priority === "high"
    && String(answered?.reply).startsWith("Shipped in"), answered);
  const afterAnswer = await card(rows.aNew.id);
  check("…with the answer signed and dated",
    afterAnswer?.replied_by_name === "Verify Desk" && !!afterAnswer?.replied_at);
  check("…and the priority the desk set earlier is kept, not dropped by omission",
    afterAnswer?.priority === "high", afterAnswer?.priority);

  const retracted = await win("retracting an answer", () => decide(rows.aNew.id, "reviewing", null, null, actor.id));
  const afterRetract = await card(rows.aNew.id);
  check("an explicit null answer retracts the sentence",
    retracted?.reply === null && afterRetract?.replied_by_name === null
    && afterRetract?.replied_at === null, afterRetract);

  const backToNew = await win("sending a card back to the queue", () => decide(rows.aNew.id, "new", null, null, null));
  check("a card can go back to unread, and only a non-'new' state demands an actor",
    backToNew?.status === "new", backToNew);

  const crossed = await win("writing into another company's card", () => decide(rows.bAnswered.id, "built", null,
    "Destination search is live — pick the ward the cargo is going to.", actor.id));
  check("the desk writes into a company it does not belong to, which is why it is a definer",
    crossed?.status === "built" && String(crossed?.reply).startsWith("Destination search is live"),
    crossed);
  const afterCross = await card(rows.bAnswered.id);
  check("…with no tenant parameter anywhere in the call",
    afterCross?.tenant_id === tenantB && afterCross?.company_type === "seeker",
    { tid: afterCross?.tenant_id, type: afterCross?.company_type });
  const seenByAuthor = await scoped(tenantB,
    `select reply, decided_at is not null as triaged from recommendations where id = $1`,
    [rows.bAnswered.id]);
  check("…and the author reads it back through plain RLS, no definer on that path either",
    seenByAuthor.length === 1 && seenByAuthor[0].reply === crossed?.reply
    && seenByAuthor[0].triaged === true, seenByAuthor);

  const afterAllRaw = await readRegister();
  const afterAll = ours(afterAllRaw);
  check("the unread count the header reads has moved with the desk's own decisions",
    afterAll.length === 4 && afterAll.every(r => r.matched === EXPECT)
    && afterAll.filter(r => r.status === "new").length === 1
    && afterAll[0].matched_new === EXPECT_NEW,
    afterAll.map((r: any) => `${r.status}:${r.matched_new} vs ${EXPECT_NEW}`));

  await app.query("rollback");
  await app.end();

  // ============================================================
  // 7. nothing is left behind
  // ============================================================
  console.log("\n-- teardown");
  await sweepFixtures(owner, "after the run");
  const residue = (await owner.query(
    `select (select count(*)::int from recommendations r
              join tenants t on t.id = r.tenant_id where t.name like 'VERIFY070 %') as notes,
            (select count(*)::int from tenants where name like 'VERIFY070 %') as tenants,
            (select count(*)::int from users where email like 'v070.%@verify.test') as users`
  )).rows[0];
  check("no fixture outlived the run — not a note, a user or a tenant",
    Object.values(residue).every(v => Number(v) === 0), residue);

  await owner.end();

  console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch(async e => {
  console.error(e);
  // A crash mid-run must not leave fixtures behind for the next one to misread.
  try {
    const c = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
    await c.connect();
    await sweepFixtures(c, "after a crash");
    await c.end();
  } catch (e2) {
    console.error("fixture sweep after the crash failed:", e2);
  }
  process.exit(1);
});
