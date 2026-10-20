/**
 * Live proof for the customer service register and the command center's copy desk
 * (migrations 099–103: api/src/routes/control-tickets.routes.ts,
 * api/src/routes/control-content.routes.ts, api/src/content/fields.ts).
 *
 * Every statement the two desks export is executed here verbatim — never re-typed — as
 * app_runtime with the platform tenant bound, inside one transaction that is thrown away.
 * A typecheck cannot see a column list, a parameter count or a grant, and the API's own role
 * has BYPASSRLS, so the only way to see what `app_runtime` is actually allowed to do is to
 * log in as it. Only the host and database come from the operator URL; the password is
 * APP_DB_PASSWORD, which belongs to the runtime role alone.
 *
 * Five things this exists to catch:
 *  - the register's honesty about PII (AGENTS.md): no list statement selects the encrypted
 *    callback number, yet `?phone=` still finds the caller through the HMAC hash alone, and
 *    only the detail read can decrypt it back;
 *  - that the two tables cannot be emptied — DELETE is refused on both, so a tombstone is the
 *    only way out and the register of acts is append-only;
 *  - that 101's state machine is in the table and not only in the route: `resolved` without a
 *    resolution sentence is refused at the CHECK, and a reference is minted from the sequence;
 *  - that 103 gave a withdrawal its own audit key, and re-tagged the ones written before it,
 *    so "closed" and "taken off the boards" are not the same word in Forensics;
 *  - that a `javascript:` address never passes the content validator, and that the company
 *    reader (102) names a foreign company without letting the session read the tenants row —
 *    which is exactly why it had to be SECURITY DEFINER.
 *
 * Nothing a person owns is touched: the run's marker goes into every row it writes, the
 * transaction is rolled back, and the residue is read afterwards on an operator connection
 * (bound to no tenant, app_runtime is told by the policies that there is nothing to see, and
 * a zero that came from a policy proves nothing).
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-customer-service-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { decryptField, encryptField, searchHash } from "../src/util/crypto.js";
import { writeAudit } from "../src/audit/audit.js";
import { uuidv7 } from "../src/util/uuid.js";
import { CONTENT_FIELDS, valueSchema } from "../src/content/fields.js";
import {
  CONTENT_BLOCKS_SQL, UPSERT_BLOCK_SQL
} from "../src/routes/control-content.routes.js";
import {
  ALLOCATE_SQL, CALLER_HISTORY_SQL, COMPANY_SQL, DEPARTMENT_LOAD_SQL,
  INSERT_EVENT_SQL, INSERT_TICKET_SQL, MY_DEPARTMENTS_SQL, OPEN_DEPARTMENT_SQL, PRIORITY_SQL,
  RESOLVE_SQL, TICKETS_COUNT_SQL, TICKETS_SQL, TICKET_EVENTS_SQL, TICKET_SQL, TOMBSTONE_SQL,
  WORK_SQL
} from "../src/routes/control-tickets.routes.js";

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

// One run, one marker: every row this script writes carries it, so the residue read is about
// this run and not about whatever the office has logged for real. The callback number is
// derived from the same clock so a `?phone=` count of one means the hash, not an empty table.
const MARK = "csg" + Date.now().toString(36);
const REQ = `verify-cs-${MARK}`;
const PHONE = `+2557${String(Date.now() % 100_000_000).padStart(8, "0")}`;
const SUBJECT = `The gate probe cannot allocate (${MARK})`;
const BODY = `Written by the verifier behind reference ${MARK}.`;
const BRAND_VALUE = `CS-GATE-VERIFY ${MARK}`;

async function main() {
  const base = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  const pw = process.env.APP_DB_PASSWORD;
  if (!base || !pw) throw new Error("MIGRATE_DATABASE_URL and APP_DB_PASSWORD are both needed");
  const u = new URL(base);

  // The ids to bind are themselves behind the policies, so they are read on an operator
  // connection first. Every statement under test then runs as app_runtime.
  const owner = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
  await owner.connect();
  const plat = await owner.query(
    "select id from tenants where type = 'platform' and deleted_at is null limit 1");
  // Prefer a seat that actually sits at a desk, so MY_DEPARTMENTS_SQL proves it finds the
  // membership instead of proving it returns an empty array.
  const seat = await owner.query(
    `select u.id from users u
       join platform_seat_departments m on m.user_id = u.id and m.released_at is null
      where u.user_type = 'platform' and u.status = 'active' and u.deleted_at is null
      limit 1`);
  const anySeat = seat.rowCount ? seat : await owner.query(
    "select id from users where user_type = 'platform' and status = 'active' and deleted_at is null limit 1");
  const company = await owner.query(
    "select id, name from tenants where type not in ('platform','seeker') and deleted_at is null limit 1");
  const seeker = await owner.query(
    "select id from tenants where type = 'seeker' and deleted_at is null limit 1");
  if (!plat.rowCount || !anySeat.rowCount) throw new Error("no platform tenant/seat to bind");
  const T = plat.rows[0].id;
  const U = anySeat.rows[0].id;

  // The pooler routes by the project reference carried in the user name, so the runtime role
  // has to wear the same suffix the operator's role does.
  const ref = u.username.includes(".") ? u.username.slice(u.username.indexOf(".") + 1) : "";
  const c = new pg.Client({
    host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1),
    user: ref ? `app_runtime.${ref}` : "app_runtime",
    password: pw, ssl: { rejectUnauthorized: false }
  });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.tenant_id', $1, true)", [T]);

    // ---------- the command center's copy desk (100) ----------
    const fields = CONTENT_FIELDS.filter((f) => f.group === "footer");
    const blocks = await c.query(CONTENT_BLOCKS_SQL, [T, fields.map((f) => f.key)]);
    check("the content read returns every seeded footer line in both locales",
      blocks.rows.length >= fields.length * 2,
      `${blocks.rows.length} rows for ${fields.length} keys`);

    // 105 moved the brand line out of the footer and onto the sign-in card, so the key this
    // gate writes is `login.brand`. It is still a copy row the runtime role may write and may
    // not delete, which is the only thing the section below is about.
    const brand = CONTENT_FIELDS.find((f) => f.key === "login.brand")!;
    const up1 = await c.query(UPSERT_BLOCK_SQL, [brand.key, "en", BRAND_VALUE, U]);
    check("a footer line upserts and returns the timestamp the desk shows as 'last by'",
      up1.rowCount === 1 && !!up1.rows[0].updated_at);
    await c.query(UPSERT_BLOCK_SQL, [brand.key, "en", `${BRAND_VALUE} again`, U]);
    const reread = await c.query(CONTENT_BLOCKS_SQL, [T, [brand.key]]);
    const enRow = reread.rows.find((r: any) => r.locale === "en");
    check("the same key+locale overwrites instead of duplicating, and keeps the newest value",
      reread.rows.filter((r: any) => r.locale === "en").length === 1 &&
      enRow?.value === `${BRAND_VALUE} again`,
      reread.rows.map((r: any) => `${r.key}.${r.locale}=${r.value}`).join(" "));
    check("the read carries who wrote it", !!enRow?.updated_by_name);
    const sw = reread.rows.find((r: any) => r.locale === "sw");
    check("an unwritten locale keeps its seed line rather than coming back empty",
      sw?.key === brand.key && !!sw?.value, sw ? `sw=${String(sw.value).slice(0, 40)}` : "no sw row");

    await c.query("savepoint no_delete_block");
    let blockDelete = "no error raised";
    try {
      await c.query("delete from content_blocks where key = $1 and locale = 'en'", [brand.key]);
    } catch (e: any) { blockDelete = e.message.slice(0, 60); }
    await c.query("rollback to savepoint no_delete_block");
    check("a published line cannot be deleted out from under the pages that show it",
      /permission denied/.test(blockDelete), blockDelete);

    const links = CONTENT_FIELDS.find((f) => f.key === "footer.links")!;
    for (const bad of ["javascript:alert(1)", " data:text/html,<script>1</script>",
      "JaVaScRiPt:alert(1)", "/relative/path", "example.co.tz/home"]) {
      check(`a footer link refuses: ${bad.slice(0, 28)}`,
        !valueSchema(links).safeParse([{ label: "Bad", href: bad }]).success);
    }
    // The scheme list is an allowlist (api/src/security/url.ts:40), so the clicks the footer
    // actually makes have to pass it — an over-strict guard would silently empty the bar.
    for (const good of ["https://waisha.co.tz", "http://waisha.co.tz",
      "mailto:hello@waisha.co.tz", "tel:+255713000111"]) {
      check(`a footer link accepts: ${good.slice(0, 28)}`,
        valueSchema(links).safeParse([{ label: "Good", href: good }]).success);
    }

    // ---------- the register (101) ----------
    const first = await c.query(
      `select id from platform_departments
        where tenant_id = $1 and deleted_at is null order by sort limit 1`, [T]);
    if (!first.rowCount) throw new Error("no open department — 084's seed did not run");
    const dept = await c.query(OPEN_DEPARTMENT_SQL, [first.rows[0].id, T]);
    if (!dept.rowCount) throw new Error("OPEN_DEPARTMENT_SQL did not find the live desk");
    const D = dept.rows[0];

    const ins = await c.query(INSERT_TICKET_SQL, [
      T, "Gate Reporter", `${MARK}@example.com`, encryptField(PHONE), searchHash(PHONE),
      "phone_call", company.rows[0]?.id ?? null, company.rowCount ? company.rows[0].name : "Gate Co",
      "system_error", SUBJECT, BODY, "urgent", null, U]);
    const tk = ins.rows[0];
    check("a logged incidence mints its number from the sequence and starts open",
      /^CS-\d{4}-\d{5,}$/.test(tk.ref) && tk.status === "open", tk.ref);

    const ev = await c.query(INSERT_EVENT_SQL, [
      T, tk.id, tk.ref, U, "super_admin", "127.0.0.1", REQ, "logged",
      null, tk.ref, null, null, "Logged by the verifier.", JSON.stringify({ via: MARK })]);
    check("the register accepts a line carrying the reason sentence", ev.rowCount === 1);
    await writeAudit(c, {
      tenantId: T, actorUserId: U, actorRole: "super_admin", ip: "127.0.0.1",
      requestId: REQ, entity: "support_tickets", entityId: tk.id,
      action: "control.tickets.logged", before: null, after: { ref: tk.ref }
    });
    check("audit_logs.entity_id takes a support_tickets uuid", true);

    const list = await c.query(TICKETS_SQL, [
      T, null, null, null, null, null, `%${MARK}%`, null, null, 60, 60, 0]);
    const hit = list.rows.find((r: any) => r.id === tk.id);
    check("the queue finds it by that marker and shows no encrypted column at all",
      !!hit && !("reporter_phone_encrypted" in hit) && hit.has_phone === true,
      hit ? `columns=${Object.keys(hit).length} has_phone=${hit.has_phone}` : "not found");
    check("and no row of the queue can carry the number in plain text either",
      list.rows.every((r: any) => !JSON.stringify(r).includes(PHONE)));
    const cnt = await c.query(TICKETS_COUNT_SQL, [
      T, null, null, null, null, null, `%${MARK}%`, null, null, 60]);
    check("the header counts the same filter the rows come from",
      cnt.rows[0].n === list.rows.length && cnt.rows[0].pressing >= 1,
      JSON.stringify(cnt.rows[0]));

    const byPhone = await c.query(TICKETS_SQL, [
      T, null, null, null, null, null, null, searchHash(PHONE), null, 365, 60, 0]);
    check("?phone= finds the caller through the hash alone",
      byPhone.rows.length === 1 && byPhone.rows[0].id === tk.id, `${byPhone.rowCount} rows`);

    const detail = await c.query(TICKET_SQL, [tk.id, T]);
    check("the detail read can decrypt the number it hid from the list",
      decryptField(detail.rows[0].reporter_phone_encrypted) === PHONE);
    const hist = await c.query(CALLER_HISTORY_SQL, [T, searchHash(PHONE)]);
    check("that caller's history is counted, not listed",
      hist.rows[0].calls === 1 && hist.rows[0].still_open === 1, JSON.stringify(hist.rows[0]));

    // ---------- the moves the desk offers (101, 102) ----------
    const alloc = await c.query(ALLOCATE_SQL, [tk.id, T, D.id, U]);
    check("handing it to a department takes it out of the open state",
      alloc.rows[0].status === "allocated" && !!alloc.rows[0].allocated_at);
    const moved = await c.query(ALLOCATE_SQL, [tk.id, T, null, U]);
    check("sending it back to the pool clears the allocation the CHECK insists on",
      moved.rows[0].status === "open" && moved.rows[0].allocated_at === null);
    await c.query(ALLOCATE_SQL, [tk.id, T, D.id, U]);

    const work = await c.query(WORK_SQL, [tk.id, T, "in_progress"]);
    check("a department that holds it can say work has started",
      work.rows[0].status === "in_progress");
    const prio = await c.query(PRIORITY_SQL, [tk.id, T, "normal"]);
    check("it can be re-rated", prio.rows[0].priority === "normal");
    const resolved = await c.query(RESOLVE_SQL,
      [tk.id, T, "resolved", "The verifier wrote the resolution.", U]);
    check("it settles only with the sentence about what was done",
      resolved.rows[0].status === "resolved" && !!resolved.rows[0].resolved_at);

    await c.query("savepoint no_resolution");
    let noRes = "no error raised";
    try {
      await c.query(
        `insert into support_tickets (tenant_id, ref, reporter_name, company_name, category,
           subject, body, status, department_id, resolved_by, created_by)
         values ($1,'CS-1999-999999','Gate Reporter','Gate Co','other','a subject here',
           'A body long enough for the CHECK.','resolved',$2,$3,$3)`, [T, D.id, U]);
    } catch (e: any) { noRes = e.message.slice(0, 80); }
    await c.query("rollback to savepoint no_resolution");
    check("resolved without a resolution is refused by the table, not only by the route",
      /check|constraint/.test(noRes), noRes);

    await c.query("savepoint no_ref_format");
    let badRef = "no error raised";
    try {
      await c.query(
        `insert into support_tickets (tenant_id, ref, reporter_name, company_name, category,
           subject, body, created_by)
         values ($1,'TK-7','Gate Reporter','Gate Co','other','a subject here',
           'A body long enough for the CHECK.',$2)`, [T, U]);
    } catch (e: any) { badRef = e.message.slice(0, 60); }
    await c.query("rollback to savepoint no_ref_format");
    check("a number that is not the register's shape is refused",
      /check|constraint/.test(badRef), badRef);

    await c.query("savepoint no_delete_ticket");
    let ticketDelete = "no error raised";
    try {
      await c.query("delete from support_tickets where id = $1", [tk.id]);
    } catch (e: any) { ticketDelete = e.message.slice(0, 60); }
    await c.query("rollback to savepoint no_delete_ticket");
    check("a logged incidence cannot be deleted, only withdrawn",
      /permission denied/.test(ticketDelete), ticketDelete);
    await c.query("savepoint no_event_update");
    let eventEdit = "no error raised";
    try {
      await c.query("update support_ticket_events set reason = 'rewritten' where ticket_id = $1",
        [tk.id]);
    } catch (e: any) { eventEdit = e.message.slice(0, 60); }
    await c.query("rollback to savepoint no_event_update");
    check("the register of acts cannot be rewritten after the fact",
      /permission denied|update|trigger|rule/.test(eventEdit), eventEdit);

    const closed = await c.query(RESOLVE_SQL, [tk.id, T, "closed", "Settled by the verifier.", U]);
    check("a resolved incidence can still be closed", closed.rows[0].status === "closed");

    // 103: a withdrawal is its own act, not a second meaning for "closed".
    const gone = await c.query(TOMBSTONE_SQL, [tk.id, T, U]);
    check("the tombstone takes it off the boards", gone.rowCount === 1);
    await c.query(INSERT_EVENT_SQL, [
      T, tk.id, tk.ref, U, "super_admin", "127.0.0.1", REQ, "withdrawn",
      "visible in the register", "withdrawn from the register",
      D.id, D.id, "Withdrawn by the verifier.", JSON.stringify({ withdrawn: true })]);
    const events = await c.query(TICKET_EVENTS_SQL, [tk.id, T]);
    check("both acts read back as their own words, oldest first, reason attached",
      events.rows.length === 2 && events.rows[0].action === "logged" &&
      events.rows[1].action === "withdrawn" &&
      events.rows[1].reason === "Withdrawn by the verifier.",
      events.rows.map((r: any) => `${r.action}:${r.reason}`).join(" | "));
    // Both lines were written by this one transaction, so they carry the same instant to the
    // microsecond — which is exactly why 104 gave the register a sequence instead of leaving
    // the story to be ordered by ts and a random uuid.
    const seqRows = await c.query(
      `select seq, action from support_ticket_events
        where ticket_id = $1 and tenant_id = $2 order by seq`, [tk.id, T]);
    check("104: two acts of one instant keep the order they were written, and app_runtime may read them",
      seqRows.rows.length === 2 && seqRows.rows[0].action === "logged" &&
      seqRows.rows[1].action === "withdrawn" &&
      Number(seqRows.rows[1].seq) > Number(seqRows.rows[0].seq) &&
      events.rows[0].ts.getTime() === events.rows[1].ts.getTime(),
      { ts: [events.rows[0].ts, events.rows[1].ts].map((d: any) => d?.toISOString()),
        seq: seqRows.rows.map((r: any) => r.seq) });
    await c.query("savepoint bad_action");
    let bogus = "no error raised";
    try {
      await c.query(INSERT_EVENT_SQL, [
        T, tk.id, tk.ref, U, "super_admin", "127.0.0.1", REQ, "closed_and_gone",
        null, null, null, null, "An action the register never meant.", "{}"]);
    } catch (e: any) { bogus = e.message.slice(0, 60); }
    await c.query("rollback to savepoint bad_action");
    check("103 widened the action list without opening it — an invented act is refused",
      /check|constraint/.test(bogus), bogus);
    const stillClosed = await c.query(
      `select count(*)::int as n from support_ticket_events
        where tenant_id = $1 and action = 'closed' and (detail->>'withdrawn') = 'true'`, [T]);
    check("nothing written before 103 is still claiming to be a closing",
      stillClosed.rows[0].n === 0, `${stillClosed.rows[0].n} row(s) to re-tag`);

    const afterGone = await c.query(TICKETS_SQL, [
      T, null, null, null, null, null, `%${MARK}%`, null, null, 60, 60, 0]);
    const survivor = await c.query("select deleted_at from support_tickets where id = $1", [tk.id]);
    check("and the queue stops showing it while the row and its evidence survive",
      afterGone.rows.length === 0 && !!survivor.rows[0].deleted_at);

    const load = await c.query(DEPARTMENT_LOAD_SQL, [T]);
    check("the desks are listed with what each one is holding",
      load.rows.length >= 1 && load.rows.every((r: any) => typeof r.working === "number"),
      load.rows.map((r: any) => `${r.name}:${r.working}/${r.unallocated}`).join(" "));
    const mine = await c.query(MY_DEPARTMENTS_SQL, [U, T]);
    check("a seat's own desks come back through the live membership predicate",
      mine.rows.length >= (seat.rowCount ? 1 : 0) &&
      mine.rows.every((r: any) => r.id && r.name && r.key),
      `${mine.rowCount} desk(s) for this seat`);

    const comp = await c.query(COMPANY_SQL, [company.rows[0]?.id ?? uuidv7()]);
    check("the company lookup names a company the register does not own",
      company.rowCount ? comp.rowCount === 1 : comp.rowCount === 0,
      comp.rowCount ? comp.rows[0].name : "(no non-platform tenant)");
    // The seeker id came from the operator connection: under the platform tenant's own policy
    // (tenants_self, 001) a foreign account is invisible to this session — which is why 102
    // had to be a definer rather than a plain join.
    if (seeker.rowCount) {
      const hidden = await c.query(COMPANY_SQL, [seeker.rows[0].id]);
      check("a seeker account is not offered to the desk as a company", hidden.rowCount === 0);
    }
    const other = await c.query("select id, name from tenants where type = 'seeker'");
    check("the register session cannot read a foreign tenant row itself", other.rowCount === 0,
      `${other.rowCount} row(s) visible to app_runtime under app.tenant_id=platform`);
    const lost = await c.query(COMPANY_SQL, [uuidv7()]);
    check("an id that is nobody comes back as no rows rather than an error", lost.rowCount === 0);

    await c.query("rollback");
  } finally {
    await c.query("rollback").catch(() => {});
    await c.end().catch(() => {});
    await owner.end().catch(() => {});
  }

  const after = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
  await after.connect();
  const residue = await after.query(
    `select (select count(*)::int from support_tickets where subject ilike $1) as t,
            (select count(*)::int from support_ticket_events where request_id = $2) as e,
            (select count(*)::int from audit_logs where request_id = $2) as a,
            (select count(*)::int from content_blocks
              where value::text ilike '%' || $3 || '%') as b`,
    [`%${MARK}%`, REQ, MARK]);
  await after.end();
  check("the rollback left nothing behind — incidences, acts, audit and copy included",
    residue.rows[0].t === 0 && residue.rows[0].e === 0 && residue.rows[0].a === 0 &&
    residue.rows[0].b === 0, JSON.stringify(residue.rows[0]));

  console.log(`\n${checks} checks, ${failures} failure(s) — marker ${MARK}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
