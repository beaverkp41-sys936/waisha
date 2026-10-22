/**
 * Live proof for the customer service register and the command center's copy desk
 * (migrations 099–103 and 123: api/src/routes/control-tickets.routes.ts,
 * api/src/routes/control-content.routes.ts, api/src/content/fields.ts).
 *
 * Every statement the two desks export is executed here verbatim — never re-typed — as
 * app_runtime with the platform tenant bound, inside one transaction that is thrown away.
 * A typecheck cannot see a column list, a parameter count or a grant, and the API's own role
 * has BYPASSRLS, so the only way to see what `app_runtime` is actually allowed to do is to
 * log in as it. Only the host and database come from the operator URL; the password is
 * APP_DB_PASSWORD, which belongs to the runtime role alone.
 *
 * Things this exists to catch:
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
 * A sixth, added for 123: that the desk's own queue number and the two working-minute
 * deadlines survive being run by the API role rather than by the operator. The minter
 * escalates through its definer owner to write the desk's counter, the clock functions do not
 * escalate at all, and the only way to see which of the two `app_runtime` may reach is to ask
 * it. The clock is then pinned against a call whose ring time is written in this file, so the
 * date a Friday-evening caller is owed is read off the desk's own week, not off the minute the
 * gate happened to run.
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
  ALLOCATE_SQL, CALLER_HISTORY_SQL, COMPANY_HQ_REGION_SQL, COMPANY_SQL, DEPARTMENT_LOAD_SQL,
  ESCALATE_SQL, FIRST_RESPONSE_SQL, INSERT_EVENT_SQL, INSERT_TICKET_SQL,
  MINT_DESK_NUMBER_SQL, MY_DEPARTMENTS_SQL, OPEN_DEPARTMENT_SQL, POINT_ROUTED_SQL, PRIORITY_SQL,
  RESOLVE_SQL, ROUTE_MATCH_SQL, STAMP_DESK_NUMBER_SQL, TICKETS_COUNT_SQL, TICKETS_SQL,
  TICKET_CLOCK_SQL, TICKET_EVENTS_SQL, TICKET_SQL, TOMBSTONE_SQL, WORK_SQL
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

/**
 * 123's clock is only worth asserting against a week this file owns, so the probe desks get
 *  one written here: the office's published Mon–Fri/Sat-morning week, a desk that never shuts
 *  and a desk that never opens. Times are Dar es Salaam wall clock, the way a desk reads its
 *  own board — 2026-03-02 is a Monday, 03-06 a Friday, 03-07 a Saturday, 03-08 a Sunday.
 */
const OFFICE_WEEK = {
  mon: { open: "08:00", close: "17:30" }, tue: { open: "08:00", close: "17:30" },
  wed: { open: "08:00", close: "17:30" }, thu: { open: "08:00", close: "17:30" },
  fri: { open: "08:00", close: "17:30" }, sat: { open: "09:00", close: "13:00" },
  sun: null
};
const ALWAYS_OPEN = Object.fromEntries(Object.keys(OFFICE_WEEK)
  .map((d) => [d, { open: "00:00", close: "23:59" }]));
const NEVER_OPEN = Object.fromEntries(Object.keys(OFFICE_WEEK).map((d) => [d, null]));
/** A Friday evening, after the office week has shut for the day. */
const FRIDAY_EVENING = "2026-03-06 18:00";

/** The gate's own fixture writes. The register's statements below are imported and run
 *  verbatim; these three exist because there is no route that says "make a desk whose week the
 *  office has not published", and a gate that moved a real desk would be measuring a clock that
 *  desk does not keep. Everything sits on the platform tenant inside the rolled-back
 *  transaction, and `sort` 990 keeps the probe desks off the top of the board. */
const PROBE_DESK_SQL = `
  insert into platform_departments (tenant_id, key, name, purpose, sort,
        first_response_minutes, resolve_minutes, business_hours, max_open_tickets)
  values ($1,$2,$3,'Written by the customer-service gate and rolled back with it.',990,
          $4,$5,$6::jsonb,$7)
  returning id, upper(key) as key, name, first_response_minutes, resolve_minutes,
            business_hours, max_open_tickets`;
const PROBE_RING_SQL = `
  update support_tickets set ts = $3::timestamp at time zone 'Africa/Dar_es_Salaam'
   where id = $1 and tenant_id = $2 and deleted_at is null`;
const PROBE_CLOCK_READ_SQL = `
  select to_char(ts at time zone 'Africa/Dar_es_Salaam','YYYY-MM-DD HH24:MI') as rang,
         to_char(response_due_at at time zone 'Africa/Dar_es_Salaam','YYYY-MM-DD HH24:MI')
           as owed_answer,
         to_char(resolution_due_at at time zone 'Africa/Dar_es_Salaam','YYYY-MM-DD HH24:MI')
           as owed_fix,
         status, after_hours, dept_ref, first_response_at,
         department_id, allocated_by, escalated_from_id, numbered_by
    from support_tickets where id = $1 and tenant_id = $2 and deleted_at is null`;
const PROBE_RULE_SQL = `
  insert into support_ticket_routes (tenant_id, name, department_id, categories, precedence,
                                     note, created_by)
  values ($1,$2,$3,'{cargo_clearing}',20,'Written by the customer-service gate.',$4)
  returning id, name, department_id`;

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

    // The mark's block is keyed `login.brand` (105 named it when it sat on the sign-in card;
    // 116 moved it back into the bar without renaming the row). It is still a copy row the
    // runtime role may write and may not delete, which is the only thing the section below is
    // about, so the key is looked up rather than hardcoded.
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
      "system_error", SUBJECT, BODY, "urgent", null, U, "sw"]);
    const tk = ins.rows[0];
    check("a logged incidence mints its number from the sequence and starts open",
      /^CS-\d{4}-\d{5,}$/.test(tk.ref) && tk.status === "open", tk.ref);
    check("…and the language the desk heard it in is kept, because a routing rule matches on it",
      tk.language === "sw", tk.language);

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
      T, null, null, null, null, null, `%${MARK}%`, null, null, 60, null, 60, 0]);
    const hit = list.rows.find((r: any) => r.id === tk.id);
    check("the queue finds it by that marker and shows no encrypted column at all",
      !!hit && !("reporter_phone_encrypted" in hit) && hit.has_phone === true,
      hit ? `columns=${Object.keys(hit).length} has_phone=${hit.has_phone}` : "not found");
    check("and no row of the queue can carry the number in plain text either",
      list.rows.every((r: any) => !JSON.stringify(r).includes(PHONE)));
    const cnt = await c.query(TICKETS_COUNT_SQL, [
      T, null, null, null, null, null, `%${MARK}%`, null, null, 60, null]);
    check("the header counts the same filter the rows come from",
      cnt.rows[0].n === list.rows.length && cnt.rows[0].pressing >= 1,
      JSON.stringify(cnt.rows[0]));
    check("…and it says how many of them no desk has yet given a queue number, which is the "
      + "figure the board needs before it can promise one",
      cnt.rows[0].unnumbered >= 1 && cnt.rows[0].no_clock >= 1 && cnt.rows[0].unanswered >= 1,
      JSON.stringify(cnt.rows[0]));

    const byPhone = await c.query(TICKETS_SQL, [
      T, null, null, null, null, null, null, searchHash(PHONE), null, 365, null, 60, 0]);
    check("?phone= finds the caller through the hash alone",
      byPhone.rows.length === 1 && byPhone.rows[0].id === tk.id, `${byPhone.rowCount} rows`);
    check("…and the row the queue hands back carries the two promises and the answer stamp, "
      + "none of which a list should invent",
      byPhone.rows[0].response_due_at === null && byPhone.rows[0].resolution_due_at === null
      && byPhone.rows[0].first_response_at === null && byPhone.rows[0].response_state === "none",
      JSON.stringify({ r: byPhone.rows[0].response_due_at, s: byPhone.rows[0].response_state }));

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

    const work = await c.query(WORK_SQL, [tk.id, T, "in_progress", false]);
    check("a department that holds it can say work has started",
      work.rows[0].status === "in_progress");
    check("…and saying so is the human act that stops the answer clock, not the logging of it",
      !!work.rows[0].first_response_at, work.rows[0].first_response_at);
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
      T, null, null, null, null, null, `%${MARK}%`, null, null, 60, null, 60, 0]);
    const survivor = await c.query("select deleted_at from support_tickets where id = $1", [tk.id]);
    check("and the queue stops showing it while the row and its evidence survive",
      afterGone.rows.length === 0 && !!survivor.rows[0].deleted_at);

    // ---------- the desk's own number and the clock it starts (123) ----------
    // The probe desks below are written by the gate rather than borrowed from the office's own
    // chart: a gate that moved a real desk's week would be reporting a clock that desk does not
    // keep. Each one is rolled back with everything else.
    let probeNo = 0;
    const probeDesk = async (label: string, terms: {
      answer?: number | null; fix?: number | null; week?: object; ceiling?: number | null
    } = {}) => {
      probeNo++;
      const made = await c.query(PROBE_DESK_SQL, [
        T, `zzcsgate${probeNo}`, `Gate ${label} (${MARK})`,
        terms.answer === undefined ? 60 : terms.answer,
        terms.fix === undefined ? 480 : terms.fix,
        JSON.stringify(terms.week ?? OFFICE_WEEK), terms.ceiling ?? null]);
      return made.rows[0] as { id: string; key: string; name: string };
    };
    /** A call exactly as the register writes one, then put back on the phone so its ring time is
     *  a date this file owns. `ts` is what every deadline below is counted from. */
    const probeTicket = async (label: string, departmentId: string | null, ringAt?: string) => {
      probeNo++;
      const made = await c.query(INSERT_TICKET_SQL, [
        T, "Gate Reporter", "", null, "", "phone_call", null, `Gate probe co (${MARK})`,
        "cargo_clearing", `The desk clock probe: ${label} (${MARK})`,
        "Written by the verifier behind the customer-service gate.", "normal",
        departmentId, U, "en"]);
      const row = made.rows[0];
      if (ringAt) await c.query(PROBE_RING_SQL, [row.id, T, ringAt]);
      return row as { id: string; ref: string; status: string; department_id: string | null };
    };
    /** The row read back as the wall clock a desk would write on its own board. */
    const clockRead = async (id: string) => (await c.query(PROBE_CLOCK_READ_SQL, [id, T])).rows[0];

    const office = await probeDesk("office week", { week: OFFICE_WEEK });
    const rang = await probeTicket("numbered on an office desk", office.id, FRIDAY_EVENING);
    const mint = (await c.query(MINT_DESK_NUMBER_SQL, [office.id])).rows[0].minted;
    check("the API role may ask a desk for its next queue number, and the definer writes the "
      + "counter for it: EXECUTE is the whole of the door",
      mint?.status === "ok" && Number(mint?.number) === 1 && mint?.ref === `${office.key}-1`, mint);
    const stamped = await c.query(STAMP_DESK_NUMBER_SQL, [
      rang.id, T, mint.number, mint.ref, mint.department_id]);
    check("…and the number is written whole — figure, readable form, and the desk that issued it",
      stamped.rowCount === 1 && stamped.rows[0].dept_ref === `${office.key}-1`
      && stamped.rows[0].numbered_by === office.id, stamped.rows[0]);
    const restamped = await c.query(STAMP_DESK_NUMBER_SQL, [rang.id, T, 2, `${office.key}-2`, office.id]);
    check("a call the caller has already been quoted never gets a second number, whichever desk "
      + "it ends up standing on", restamped.rowCount === 0, restamped.rowCount);

    await c.query("savepoint half_a_number");
    let halfNumber = "no error raised";
    try {
      await c.query(`update support_tickets set dept_ref = $3 where id = $1 and tenant_id = $2`,
        [rang.id, T, `${office.key}-77`]);
    } catch (e: any) { halfNumber = e.message.slice(0, 70); }
    await c.query("rollback to savepoint half_a_number");
    check("half a number is refused by the table: a form without the minting desk is not a fact",
      /check|constraint/.test(halfNumber), halfNumber);

    const firstClock = await c.query(TICKET_CLOCK_SQL, [rang.id, T, true]);
    const owedOn = await clockRead(rang.id);
    check("a Friday-evening call to a desk that shuts at 17:30 is owed an answer from the minute "
      + "it next opens, not from the minute a clerk got to it",
      firstClock.rowCount === 1 && owedOn.owed_answer === "2026-03-07 10:00", owedOn);
    check("…and eight working hours on the same desk waits out Saturday's half day before "
      + "Monday's morning: 2026-03-09 12:00",
      owedOn.owed_fix === "2026-03-09 12:00", owedOn.owed_fix);
    check("…so the call is marked as having come in out of hours, which is a fact about the phone "
      + "call and stays true",
      firstClock.rows[0].after_hours === true && owedOn.after_hours === true, firstClock.rows[0]);
    check("the clock read hands back the desk it started, in the key the register spells numbers "
      + "with, and the terms it was counted under",
      firstClock.rows[0].department_id === office.id
      && firstClock.rows[0].department_key === office.key
      && Number(firstClock.rows[0].first_response_minutes) === 60, firstClock.rows[0]);

    await c.query(`update platform_departments set first_response_minutes = 5 where id = $1 `
      + `and tenant_id = $2`, [office.id, T]);
    const secondClock = await c.query(TICKET_CLOCK_SQL, [rang.id, T, false]);
    check("a promise that has already started is not restarted by the next hand that touches the "
      + "row — coalesce is the statement",
      secondClock.rows[0].response_due_at.getTime()
        === firstClock.rows[0].response_due_at.getTime(),
      { before: firstClock.rows[0].response_due_at, after: secondClock.rows[0].response_due_at });
    check("…and an act that is not the arrival cannot make an out-of-hours call look like it came "
      + "in at opening time",
      secondClock.rows[0].after_hours === true, secondClock.rows[0].after_hours);

    const round = await probeDesk("open all day", { answer: 60, fix: null, week: ALWAYS_OPEN });
    const roundCall = await probeTicket("counted from the ring", round.id, FRIDAY_EVENING);
    await c.query(MINT_DESK_NUMBER_SQL, [round.id]);
    await c.query(TICKET_CLOCK_SQL, [roundCall.id, T, true]);
    check("on a desk that never shuts, an hour promised is owed at 19:00 the same Friday evening: "
      + "the clock counts from the ring",
      (await clockRead(roundCall.id)).owed_answer === "2026-03-06 19:00", await clockRead(roundCall.id));

    const bare = await probeDesk("no promise", { answer: null, fix: null });
    const bareCall = await probeTicket("a desk that set no clock", bare.id, FRIDAY_EVENING);
    const bareClock = await c.query(TICKET_CLOCK_SQL, [bareCall.id, T, true]);
    check("a desk that has set no answer time is given no deadline, rather than one the platform "
      + "invented on its behalf",
      bareClock.rows[0].response_due_at === null
      && bareClock.rows[0].resolution_due_at === null, bareClock.rows[0]);
    const bareRead = await clockRead(bareCall.id);
    check("…but it is still marked as having rung outside the desk's week: the hour a call came in "
      + "at is a fact about the phone, not a consequence of the promise a desk never set",
      bareRead.after_hours === true && bareRead.owed_answer === null, bareRead);

    const shut = await probeDesk("shut week", { week: NEVER_OPEN });
    const shutCall = await probeTicket("a desk that never opens", shut.id, FRIDAY_EVENING);
    const shutClock = await c.query(TICKET_CLOCK_SQL, [shutCall.id, T, true]);
    check("a desk whose week contains no open time promises no date at all — the clock gives up "
      + "rather than inventing one",
      shutClock.rows[0].response_due_at === null && shutClock.rows[0].after_hours === true,
      shutClock.rows[0]);

    // ---------- who takes the call when nobody chose ----------
    const ruleTarget = await probeDesk("routing target", { ceiling: 3 });
    await c.query(PROBE_RULE_SQL, [T, `Gate cargo rule (${MARK})`, ruleTarget.id, U]);
    const matched = (await c.query(ROUTE_MATCH_SQL, [
      T, "phone_call", "cargo_clearing", "normal", "en", null])).rows[0].matched;
    check("the register asks the rules who takes a call nobody named, and gets a desk rather than "
      + "a guess",
      matched?.status === "rule" && matched?.department_id === ruleTarget.id
      && matched?.department_key === ruleTarget.key, matched);
    check("…with the ceiling that desk set and the work it is holding, so the clerk can be told "
      + "before the call lands",
      Number(matched?.max_open_tickets) === 3 && Number(matched?.open_tickets) === 0, matched);
    const unrouted = (await c.query(ROUTE_MATCH_SQL, [T, "email", "complaint", "low", "en", null]))
      .rows[0].matched;
    check("a call no rule covers is answered with no_rule, not with the nearest desk",
      unrouted?.status === "no_rule", unrouted);
    check("…and the mint refuses a desk that is not on the chart, so a retired team cannot hand "
      + "out numbers",
      (await c.query(MINT_DESK_NUMBER_SQL, [uuidv7()])).rows[0].minted?.status === "unavailable");

    // A rule named the desk; no person has said they are on it. 101's CHECK allows exactly this.
    const pointed = await probeTicket("routed but nobody has started", null, FRIDAY_EVENING);
    const sat = await c.query(POINT_ROUTED_SQL, [pointed.id, T, ruleTarget.id]);
    check("a routed call takes the desk and stays open: the number says whose problem it is, the "
      + "state says nobody has started",
      sat.rowCount === 1 && sat.rows[0].status === "open"
      && sat.rows[0].department_id === ruleTarget.id, sat.rows[0]);
    const pointedRead = await clockRead(pointed.id);
    check("…and it holds no allocation, because inventing one would credit a person who has not "
      + "picked the phone up",
      pointedRead.allocated_by === null && pointedRead.status === "open", pointedRead);
    const movedAgain = await c.query(POINT_ROUTED_SQL, [pointed.id, T, office.id]);
    check("…so a second rule cannot quietly re-point a call that already has a desk",
      movedAgain.rowCount === 0, movedAgain.rowCount);

    // ---------- the answer stamp, and the two acts that clear it ----------
    const untouched = await probeTicket("a note with nobody on it", null, FRIDAY_EVENING);
    const noDesk = await c.query(FIRST_RESPONSE_SQL, [untouched.id, T]);
    check("a note on an incidence no desk holds matches no row: a note in the margin is not an "
      + "answer to the caller", noDesk.rowCount === 0, noDesk.rowCount);
    const answered = await c.query(FIRST_RESPONSE_SQL, [pointed.id, T]);
    check("the first human act on a call a desk holds stops the answer clock",
      answered.rowCount === 1 && !!answered.rows[0].first_response_at, answered.rows[0]);
    const answeredTwice = await c.query(FIRST_RESPONSE_SQL, [pointed.id, T]);
    check("…and a second act cannot improve it: the stamp is the first one, coalesce is the "
      + "statement",
      answeredTwice.rows[0].first_response_at.getTime()
        === answered.rows[0].first_response_at.getTime(), answeredTwice.rows[0]);

    const reopened = await c.query(WORK_SQL, [pointed.id, T, "in_progress", true]);
    check("a reopen clears the answer stamp — the caller says it is not fixed, and the desk's "
      + "first answer belongs to the attempt that failed",
      reopened.rows[0].status === "in_progress" && reopened.rows[0].first_response_at === null,
      reopened.rows[0]);
    const keptDeadlines = await c.query(WORK_SQL, [pointed.id, T, "in_progress", false]);
    check("…while the two deadlines ride through it untouched: a desk cannot erase its own breach "
      + "by declaring a second attempt",
      keptDeadlines.rows[0].response_due_at === null
      && keptDeadlines.rows[0].resolution_due_at === null
      && keptDeadlines.rows[0].dept_ref === reopened.rows[0].dept_ref, keptDeadlines.rows[0]);

    // ---------- up the chain ----------
    const wrongDesk = await c.query(ESCALATE_SQL, [rang.id, T, bare.id, office.id, U]);
    check("an escalation is a compare-and-swap: if the desk moved between the read and the write, "
      + "nobody is credited with a call it does not hold",
      wrongDesk.rowCount === 0, wrongDesk.rowCount);
    const above = await probeDesk("the desk above", { answer: 30, fix: 240 });
    const went = await c.query(ESCALATE_SQL, [rang.id, T, office.id, above.id, U]);
    check("handing it up keeps everything the caller was told: the register's number, the desk's "
      + "queue number and both promises",
      went.rowCount === 1 && went.rows[0].dept_ref === `${office.key}-1`
      && went.rows[0].escalated_from_id === office.id && !!went.rows[0].escalated_at, went.rows[0]);
    const afterEscalate = await c.query(TICKET_CLOCK_SQL, [rang.id, T, false]);
    check("…and the new desk starts a clock only where none had started: the promise the first "
      + "desk was measured against does not move because it failed",
      afterEscalate.rows[0].response_due_at.getTime()
        === firstClock.rows[0].response_due_at.getTime()
      && afterEscalate.rows[0].department_id === above.id, afterEscalate.rows[0]);
    const escalatedRead = await clockRead(rang.id);
    check("…the row says who failed to answer, which is the only figure the desk above is being "
      + "asked to take over",
      escalatedRead.department_id === above.id && escalatedRead.escalated_from_id === office.id,
      escalatedRead);

    // ---------- the two figures the register's own guards read ----------
    const full = await probeDesk("at its ceiling", { ceiling: 1 });
    await probeTicket("one call on a full desk", full.id, FRIDAY_EVENING);
    const deskRow = (await c.query(OPEN_DEPARTMENT_SQL, [full.id, T])).rows[0];
    check("the desk read carries both figures the hand-over guard needs, so a full desk can be "
      + "named in the refusal",
      Number(deskRow.live_tickets) === 1 && Number(deskRow.max_open_tickets) === 1
      && deskRow.escalation_department_id === null, deskRow);
    const region = await c.query(COMPANY_HQ_REGION_SQL, [uuidv7()]);
    check("a company with no head office on file gives a region rule nothing to match on, rather "
      + "than a wildcard it did not ask for",
      region.rowCount === 0, region.rows[0]);

    await c.query(INSERT_EVENT_SQL, [
      T, rang.id, rang.ref, U, "super_admin", "127.0.0.1", REQ, "routed",
      null, `${above.name} (by rule "Gate cargo rule")`, office.id, above.id,
      "Routed by the gate.", JSON.stringify({ rule_id: matched.rule_id })]);
    await c.query(INSERT_EVENT_SQL, [
      T, rang.id, rang.ref, U, "super_admin", "127.0.0.1", REQ, "escalated",
      office.name, above.name, office.id, above.id,
      "Escalated by the gate.", JSON.stringify({ kept_number: `${office.key}-1` })]);
    const counted = await c.query(
      `select count(*)::int as n from support_ticket_events e
        join support_ticket_routes r on r.id::text = e.detail->>'rule_id' and r.tenant_id = e.tenant_id
        where e.ticket_id = $1 and e.action = 'routed'`, [rang.id]);
    check("the register has a word for a rule doing it and a word for the desk above doing it, "
      + "and the routed line is the one the rules board counts",
      counted.rows[0].n === 1, counted.rows[0]);

    const byQueueNumber = await c.query(TICKETS_SQL, [
      T, null, null, null, null, null, `%${office.key}-1%`, null, null, 365, null, 60, 0]);
    check("the queue can be searched by the number the caller was read out, which is the only "
      + "reason a desk number exists",
      byQueueNumber.rows.length === 1 && byQueueNumber.rows[0].id === rang.id
      && byQueueNumber.rows[0].response_state === "breached",
      byQueueNumber.rows.map((r: any) => `${r.dept_ref}:${r.response_state}`));
    check("…and it shows which desk minted the number, not only which one is holding the call "
      + "now",
      byQueueNumber.rows[0].numbered_by_name === office.name
      && byQueueNumber.rows[0].department_name === above.name,
      { n: byQueueNumber.rows[0].numbered_by_name, d: byQueueNumber.rows[0].department_name });
    const noClockRows = await c.query(TICKETS_SQL, [
      T, null, null, null, null, null, `%desk clock probe%`, null, null, 365, "no_clock", 60, 0]);
    check("the clock filter finds the calls nobody has promised anything about",
      noClockRows.rows.length >= 3
      && noClockRows.rows.every((r: any) => r.response_state === "none"
        && r.resolution_state === "none"),
      noClockRows.rows.map((r: any) => `${r.subject.slice(0, 26)}:${r.response_state}`).join(" | "));
    const lateRows = await c.query(TICKETS_SQL, [
      T, null, null, null, null, null, `%desk clock probe%`, null, null, 365, "late", 60, 0]);
    check("…and the one that is past both promises is the first thing the filter hands back",
      lateRows.rows.some((r: any) => r.id === rang.id)
      && lateRows.rows.every((r: any) => r.response_due_at < new Date()
        || r.resolution_due_at < new Date()),
      lateRows.rows.map((r: any) => `${r.dept_ref ?? "-"}`).join(" | "));
    // The chain is written on the row, not guessed by the route: the desk that just took the
    // call has to be able to say who it would hand on to if it cannot answer either.
    await c.query(`update platform_departments set escalation_department_id = $2 `
      + `where id = $1 and tenant_id = $3`, [above.id, bare.id, T]);
    const oneDetail = await c.query(TICKET_SQL, [rang.id, T]);
    check("the detail read carries the desk's own terms next to the dates they produced, so a "
      + "panel can explain a deadline without a second query",
      oneDetail.rows[0].first_response_minutes === 30 && oneDetail.rows[0].resolve_minutes === 240
      && oneDetail.rows[0].escalation_key === bare.key
      && oneDetail.rows[0].numbered_by_key === office.key,
      { fr: oneDetail.rows[0].first_response_minutes, up: oneDetail.rows[0].escalation_name });
    check("…and the two promises are read as the desk's own words, from the same CASE the list "
      + "uses, so the header and the row cannot disagree",
      oneDetail.rows[0].response_state === "breached"
      && oneDetail.rows[0].resolution_state === "breached",
      `${oneDetail.rows[0].response_state}/${oneDetail.rows[0].resolution_state}`);

    const probeCount = (await c.query(TICKETS_COUNT_SQL, [
      T, null, null, null, null, null, "%desk clock probe%", null, null, 365, null])).rows[0];
    const lateCount = (await c.query(TICKETS_COUNT_SQL, [
      T, null, null, null, null, null, "%desk clock probe%", null, null, 365, "late"])).rows[0];
    const clockCount = (await c.query(TICKETS_COUNT_SQL, [
      T, null, null, null, null, null, "%desk clock probe%", null, null, 365, "no_clock"])).rows[0];
    const probeRows = (await c.query(TICKETS_SQL, [
      T, null, null, null, null, null, "%desk clock probe%", null, null, 365, null, 200, 0])).rows;
    check("the header counts the same filter the rows come from, clock predicate and all",
      probeCount.n === probeRows.length && lateCount.n === lateRows.rows.length
      && clockCount.n === noClockRows.rows.length && lateCount.n >= 1,
      { rows: probeCount.n, late: lateCount.n, no_clock: clockCount.n });

    const load = await c.query(DEPARTMENT_LOAD_SQL, [T]);
    const probeRow = load.rows.find((r: any) => r.id === office.id);
    check("the desk board counts each desk's promises, its no-clock calls and the ones still "
      + "waiting for a number",
      typeof probeRow?.overdue === "number" && typeof probeRow?.no_clock === "number"
      && typeof probeRow?.unnumbered === "number"
      && typeof probeRow?.desk_is_open_now === "boolean",
      probeRow && JSON.stringify({ o: probeRow.overdue, n: probeRow.no_clock,
        u: probeRow.unnumbered, l: probeRow.live_tickets }));
    const bareRow = load.rows.find((r: any) => r.id === bare.id);
    check("…so a desk with a call on it and no clock set is visible as exactly that",
      Number(bareRow?.live_tickets) === 1 && Number(bareRow?.no_clock) === 1
      && Number(bareRow?.unnumbered) === 1, bareRow);
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
              where value::text ilike '%' || $3 || '%') as b,
            (select count(*)::int from platform_departments where name ilike $1) as d,
            (select count(*)::int from support_ticket_routes where name ilike $1) as r`,
    [`%${MARK}%`, REQ, MARK]);
  await after.end();
  check("the rollback left nothing behind — incidences, acts, audit, copy, probe desks and rules "
    + "included",
    residue.rows[0].t === 0 && residue.rows[0].e === 0 && residue.rows[0].a === 0 &&
    residue.rows[0].b === 0 && residue.rows[0].d === 0 && residue.rows[0].r === 0,
    JSON.stringify(residue.rows[0]));

  console.log(`\n${checks} checks, ${failures} failure(s) — marker ${MARK}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
