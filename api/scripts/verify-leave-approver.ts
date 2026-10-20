/**
 * Live proof for task #183 — a leave request is answered by the person it was sent to
 * (migration 108).
 *
 * The stage's whole claim is that a decision belongs to a person rather than to a permission,
 * and a claim like that only survives as long as the database keeps it:
 *
 *  1. the assignment is a seat *of this company*, checked against the row about to land. The
 *     foreign key can say "a seat"; it cannot say "one of ours", and a typed-in id from a
 *     support ticket would send somebody's leave to another company's director, where it would
 *     sit undecided forever — so the membership, the state and the self-reference are rules;
 *  2. …but they are rules about a *change*. An ordinary name correction must not fail the day
 *     the approver's seat was suspended, or the office loses the staff register over a column
 *     nobody was touching. Both halves are proven, because a trigger that early-returns too
 *     widely is how a guard quietly stops existing;
 *  3. the route is a snapshot stamped when the request is raised, and once the answer is on the
 *     row it is history: re-pointing a decided request at a different seat rewrites who was
 *     asked. The one later write it tolerates is the foreign key losing the holder;
 *  4. the decision refuses three seats — none, the person's own, and the one that typed the
 *     request in — on both paths a decision can arrive: an update out of pending, and an insert
 *     that lands already decided;
 *  5. 065's two older rules (the working-day count and one-person-cannot-be-away-twice) are
 *     still alive beside a third trigger on the same table, in the order that decides which
 *     complaint the desk reads;
 *  6. all of it holds for `app_runtime` — the role the API actually connects as.
 *
 * Every write is rolled back. Each probe gets its own week: the overlap guard reads one person
 * one span, and a collision would read as a guard that never existed.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-leave-approver.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  checks++;
  if (ok) console.log("ok   ", label);
  else {
    failures++;
    console.log("FAIL ", label, (typeof detail === "string"
      ? detail : JSON.stringify(detail)).slice(0, 500));
  }
}

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

async function connectRuntime(url: string): Promise<pg.Client> {
  let last: any = null;
  for (let i = 0; i < 3; i++) {
    const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      return client;
    } catch (e) {
      last = e;
      await client.end().catch(() => { });
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw last;
}

/** Constraint and trigger definitions come back with casts and case no human wrote. */
const norm = (s: unknown) =>
  String(s).replace(/::[a-z_0-9]+(\([^)]*\))?/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
/** …and with a bracket for every clause Postgres added itself. */
const flat = (s: unknown) => norm(s).replace(/[()]/g, "");
const n = (v: any) => (v === null || v === undefined ? NaN : Number(v));

/** One stamp per run, so a probe week can never be mistaken for a person's June. */
const STAMP = "108v" + Date.now().toString(36);
const MARK = `108 verify ${STAMP}`;
const REASON = `${MARK} ask`;

/**
 * Every probe opens on a Monday of its own week, so the overlap guard that belongs to an
 * earlier probe can never be mistaken for the rule under test. Three days is Monday to
 * Wednesday: a count a reader can check in their head.
 */
let week = 0;
function span(days = 3): [string, string] {
  const start = new Date(Date.UTC(2026, 5, 1 + week++ * 7));
  const end = new Date(start.getTime() + (days - 1) * 86400000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return [iso(start), iso(end)];
}

const SET_APPROVER = "update employees set leave_approver_user_id = $2 where id = $1";
const DECIDE =
  `update leave_requests set status = $2, decided_by = $3, decided_at = now(),
          decision_note = $4, updated_by = $3, updated_at = now()
    where id = $1`;

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();

  // ================================================================
  console.log("\n--- 1 · the columns, the two checks and the three indexes as the catalog has them ---");

  const cols = await owner.query(
    `select table_name, column_name, is_nullable, data_type, column_default
       from information_schema.columns
      where (table_name = 'employees' and column_name = 'leave_approver_user_id')
         or (table_name = 'leave_requests' and column_name in
             ('routed_to_user_id','routed_reason','routed_note','escalated_at',
              'escalated_by','escalated_from'))
      order by table_name, column_name`);
  check("108 added the assignment and the six routing columns", cols.rowCount === 7,
    cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
  const col = new Map(cols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
  check("the assignment is a seat (uuid) and nullable: most people's leave stays the office's",
    col.get("employees.leave_approver_user_id")?.data_type === "uuid"
    && col.get("employees.leave_approver_user_id")?.is_nullable === "YES",
    col.get("employees.leave_approver_user_id"));
  check("the reason is the one column that is never blank, and blank means the office",
    col.get("leave_requests.routed_reason")?.is_nullable === "NO"
    && /'office'/.test(String(col.get("leave_requests.routed_reason")?.column_default)),
    [col.get("leave_requests.routed_reason")?.is_nullable,
      col.get("leave_requests.routed_reason")?.column_default]);
  check("the holder, the escalator and the seat it left are uuids, and each is nullable",
    ["routed_to_user_id", "escalated_by", "escalated_from"].every(
      (k) => col.get(`leave_requests.${k}`)?.data_type === "uuid"
        && col.get(`leave_requests.${k}`)?.is_nullable === "YES"),
    cols.rows.filter((r) => r.table_name === "leave_requests").map((r) => r.column_name));
  check("escalated_at is a moment and routed_note plain words",
    col.get("leave_requests.escalated_at")?.data_type === "timestamp with time zone"
    && col.get("leave_requests.routed_note")?.data_type === "text",
    [col.get("leave_requests.escalated_at")?.data_type,
      col.get("leave_requests.routed_note")?.data_type]);

  const fks = await owner.query(
    `select a.attname as col, c.confrelid::regclass::text as refs, c.confdeltype
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f'
        and c.conrelid in ('employees'::regclass, 'leave_requests'::regclass)
        and a.attname in ('leave_approver_user_id','routed_to_user_id','escalated_by','escalated_from')`);
  const bySeat = ["leave_approver_user_id", "routed_to_user_id", "escalated_by", "escalated_from"];
  const fk = new Map(fks.rows.map((r) => [r.col, r]));
  check("all four point at users — a seat, not an employee row, because a decider needs no staff file",
    bySeat.every((k) => fk.get(k)?.refs === "users"), fks.rows);
  check("…and all four are SET NULL, so deleting a seat never deletes a request or blocks the delete",
    bySeat.every((k) => fk.get(k)?.confdeltype === "n"), fks.rows);

  const cons = await owner.query(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conname in ('leave_requests_routed_reason_check','leave_requests_escalation_check')`);
  const def = new Map(cons.rows.map((r) => [r.conname, flat(r.def)]));
  check("the reason is only ever one of the four words the chain can end in",
    /routed_reason = any array\['assigned', 'supervisor', 'office', 'escalated'\]/
      .test(def.get("leave_requests_routed_reason_check") ?? ""),
    def.get("leave_requests_routed_reason_check"));
  check("an escalation is an act with an author: nothing at all, or a moment and a seat",
    /escalated_at is null and escalated_by is null and escalated_from is null/
      .test(def.get("leave_requests_escalation_check") ?? "")
    && /escalated_at is not null and escalated_by is not null/
      .test(def.get("leave_requests_escalation_check") ?? ""),
    def.get("leave_requests_escalation_check"));

  const idx = await owner.query(
    `select indexname, indexdef from pg_indexes
      where indexname in ('idx_employee_leave_approver','idx_leave_routed_to_me','idx_leave_routed_open')`);
  const idf = new Map(idx.rows.map((r) => [r.indexname, flat(r.indexdef)]));
  check("the assignment index is this company's live staff who have an approver",
    idx.rowCount === 3
    && /on public\.employees using btree tenant_id, leave_approver_user_id/
      .test(idf.get("idx_employee_leave_approver") ?? "")
    && /where deleted_at is null and leave_approver_user_id is not null/
      .test(idf.get("idx_employee_leave_approver") ?? ""), idx.rows);
  check("the approver's queue is pending lines sent to this seat, oldest ask first",
    /on public\.leave_requests using btree routed_to_user_id, created_at/
      .test(idf.get("idx_leave_routed_to_me") ?? "")
    && /where status = 'pending' and deleted_at is null/
      .test(idf.get("idx_leave_routed_to_me") ?? ""), idf.get("idx_leave_routed_to_me"));
  check("…and the office's stalled pile is the same, restricted to rows nobody is holding",
    /on public\.leave_requests using btree tenant_id, created_at/
      .test(idf.get("idx_leave_routed_open") ?? "")
    && /routed_reason = any array\['office', 'escalated'\]/
      .test(idf.get("idx_leave_routed_open") ?? ""), idf.get("idx_leave_routed_open"));

  const trg = await owner.query(
    `select t.tgname, t.tgenabled, t.tgattr::int2vector::text as attrs,
            (t.tgtype::int & 2) <> 0 as before,
            (t.tgtype::int & 4) <> 0 as ins,
            (t.tgtype::int & 16) <> 0 as upd,
            (t.tgtype::int & 1) <> 0 as for_each_row,
            p.proname, p.prosecdef,
            has_function_privilege('app_runtime', p.oid, 'execute') as rt_execute
       from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid in ('employees'::regclass, 'leave_requests'::regclass)
        and not t.tgisinternal
        and p.proname in ('employee_leave_approver_seat','leave_decision_shape')
      order by t.tgname`);
  const seatTrg = trg.rows.find((r) => r.proname === "employee_leave_approver_seat");
  const shapeTrg = trg.rows.find((r) => r.proname === "leave_decision_shape");
  check("the assignment rule is a BEFORE INSERT OR UPDATE row trigger on employees, and it is enabled",
    !!seatTrg && seatTrg.before && seatTrg.ins && seatTrg.upd && seatTrg.for_each_row
    && seatTrg.tgenabled === "O", seatTrg);
  check("…and the decision rule is a BEFORE INSERT OR UPDATE row trigger on leave_requests, enabled",
    !!shapeTrg && shapeTrg.before && shapeTrg.ins && shapeTrg.upd && shapeTrg.for_each_row
    && shapeTrg.tgenabled === "O", shapeTrg);
  check("…with no column list, so a routing write cannot dodge it by touching only routing columns",
    shapeTrg?.attrs === "", shapeTrg?.attrs);
  check("app_runtime may execute both — a grant the migration forgot would 500 the desk",
    seatTrg?.rt_execute === true && shapeTrg?.rt_execute === true,
    trg.rows.map((r) => [r.proname, r.rt_execute]));
  check("…and neither is a definer with a wider view than its caller",
    seatTrg?.prosecdef === false && shapeTrg?.prosecdef === false,
    trg.rows.map((r) => [r.proname, r.prosecdef]));

  const order = await owner.query(
    `select t.tgname from pg_trigger t
      where t.tgrelid = 'leave_requests'::regclass and not t.tgisinternal
        and (t.tgtype::int & 2) <> 0 and (t.tgtype::int & 16) <> 0
      order by t.tgname`);
  const names = order.rows.map((r) => r.tgname);
  check("on an update the shape fires first, so the desk reads the real complaint",
    names[0] === "trg_leave_decision_shape" && names.includes("trg_leave_no_overlap")
    && names.includes("trg_leave_updated"), names);

  const keys = await owner.query(
    `select key from permissions where key like 'leave%' order by key`);
  check("108 added no new duty key: leave.decide is already the office half of the chain",
    keys.rowCount === 3
    && keys.rows.map((r) => r.key).join(",") === "leave.decide,leave.request,leave.view",
    keys.rows.map((r) => r.key));

  // ================================================================
  console.log("\n--- 2 · the writes, on lines that roll back ---");

  const tenants = await owner.query(
    `select id from tenants where deleted_at is null order by created_at limit 2`);
  if (!tenants.rowCount) throw new Error("No tenant on the database to raise leave for");
  const A = tenants.rows[0].id as string;
  const B = tenants.rows[1]?.id ?? A;

  await owner.query("begin");
  let sp = 0;
  /** Run one statement under a savepoint. A refusal is undone where it happened, so the rest
   *  of the run still has a live transaction; an accepted write is *kept*, because the probe
   *  that allowed it has to read the row back. Everything is discarded by the final rollback. */
  async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: T | null; err: any }> {
    const name = `sp${++sp}`;
    await owner.query(`savepoint ${name}`);
    try {
      const ok = await fn();
      await owner.query(`release savepoint ${name}`);
      return { ok, err: null };
    } catch (e) {
      await owner.query(`rollback to savepoint ${name}`);
      return { ok: null, err: e };
    }
  }
  async function refused(label: string, sql: string, params: any[] = [], re: RegExp = /./) {
    const r = await attempt(() => owner.query(sql, params));
    const msg = r.err ? `${r.err.code ?? ""} ${r.err.message ?? ""}` : "(the write was accepted)";
    check(label, !!r.err && re.test(msg), msg);
  }
  async function accepted(label: string, sql: string, params: any[] = []) {
    const r = await attempt(() => owner.query(sql, params));
    check(label, !r.err, r.err ? `${r.err.code ?? ""} ${r.err.message ?? ""}` : "");
    return r.ok;
  }
  const one = async (sql: string, params: any[]): Promise<string> =>
    (await owner.query(sql, params)).rows[0].id as string;

  try {
    // ---- the seats this stage is about ----
    const seatFor = async (kind: string, status = "active", tenant = A) => one(
      `insert into users (tenant_id, user_type, email, status, full_name)
        values ($1,'staff',$2,$3,$4) returning id`,
      [tenant, `${STAMP}-${kind.replace(/ /g, "-")}@108.invalid`, status, `${MARK} ${kind}`]);
    const approver = await seatFor("approver");
    const own = await seatFor("own seat");
    const author = await seatFor("author");
    const stranger = await seatFor("stranger");
    const abroad = await seatFor("other company", "active", B);
    const dozing = await seatFor("suspended", "suspended");

    const emp = await one(
      `insert into employees (tenant_id, full_name, status, user_id) values ($1,$2,'active',$3) returning id`,
      [A, `${MARK} clerk`, own]);
    const emp2 = await one(
      `insert into employees (tenant_id, full_name, status) values ($1,$2,'active') returning id`,
      [A, `${MARK} second clerk`]);

    const readEmp = (id: string) => owner.query(
      `select full_name, leave_approver_user_id from employees where id = $1`, [id]);

    // ---- the assignment ----
    await accepted("the office can name a colleague of theirs as the approver",
      SET_APPROVER, [emp, approver]);
    check("…and the column keeps the seat it was given",
      String((await readEmp(emp)).rows[0].leave_approver_user_id) === approver,
      (await readEmp(emp)).rows[0]);

    await refused("a person cannot be named to decide their own leave",
      SET_APPROVER, [emp, own], /cannot be the person whose leave/);
    await refused("…nor can a seat borrowed from another company be",
      SET_APPROVER, [emp, abroad], /belongs to another company/);
    await refused("…and an id that is nobody's seat is stopped by the rule, before the key is consulted",
      SET_APPROVER, [emp, randomUUID()], /not a seat of any company/);
    await refused("…nor a seat that has been suspended",
      SET_APPROVER, [emp, dozing], /seat is not active/);
    await accepted("naming nobody is always allowed — the office decides then",
      SET_APPROVER, [emp, null]);
    check("…and the register reads the blank back as a blank",
      (await readEmp(emp)).rows[0].leave_approver_user_id === null, (await readEmp(emp)).rows[0]);

    // The early return, both directions: the rule is about a change of assignment.
    await accepted("the approver is named again, and then their seat is suspended by the office",
      SET_APPROVER, [emp, approver]);
    await owner.query(`update users set status = 'suspended' where id = $1`, [approver]);
    const nameFix = await attempt(() => owner.query(
      `update employees set full_name = $2, job_title = 'Accounts clerk' where id = $1`,
      [emp, `${MARK} clerk, renamed`]));
    check("an edit of a column nobody was touching still lands while the approver's seat is dead",
      !nameFix.err && (await readEmp(emp)).rows[0].full_name === `${MARK} clerk, renamed`,
      nameFix.err?.message ?? "(accepted)");
    const restate = await attempt(() => owner.query(SET_APPROVER, [emp, approver]));
    check("…and restating that same approver is treated as no change at all",
      !restate.err, restate.err?.message ?? "(accepted)");
    await refused("…but pointing a different person at the dead seat is still refused",
      SET_APPROVER, [emp2, approver], /seat is not active/);
    await owner.query(`update users set status = 'active' where id = $1`, [approver]);
    const moved = await attempt(() => owner.query(SET_APPROVER, [emp, stranger]));
    check("…after which moving the assignment to a live seat works again",
      !moved.err && String((await readEmp(emp)).rows[0].leave_approver_user_id) === stranger,
      moved.err?.message ?? "(accepted)");

    // ================================================================
    console.log("\n--- 3 · the route the request carries from the moment it is raised ---");

    const read = (id: string) => owner.query(
      `select status, decided_by, decided_at, decision_note, routed_to_user_id, routed_reason,
              routed_note, escalated_at, escalated_by, escalated_from, working_days, deleted_at
         from leave_requests where id = $1`, [id]);
    const [f1, t1] = span();
    const rq1 = await one(
      `insert into leave_requests
         (id, tenant_id, employee_id, leave_kind, starts_on, ends_on, reason,
          routed_to_user_id, routed_reason, routed_note, created_by, updated_by)
       values ($1,$2,$3,'annual',$4::date,$5::date,$6,$7,'assigned',$8,$9,$9)
        returning id`,
      [randomUUID(), A, emp, f1, t1, REASON, approver, null, author]);
    const stamped = (await read(rq1)).rows[0];
    check("a request stamped with a holder keeps the holder, the reason and its waiting state",
      stamped.routed_to_user_id === approver && stamped.routed_reason === "assigned"
      && stamped.status === "pending" && stamped.decided_by === null, stamped);
    check("…and 065's count still runs beside the new columns: Monday to Wednesday is three days",
      n(stamped.working_days) === 3, { working_days: stamped.working_days, f1, t1 });

    const [f2, t2] = span();
    const plainId = await one(
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         reason, created_by)
        values ($1,$2,'sick',$3::date,$4::date,$5,$6) returning id`,
      [A, emp2, f2, t2, `${REASON} plain`, author]);
    const plain = (await read(plainId)).rows[0];
    check("a row raised without a word about routing is the office's by default, not nobody's",
      plain.routed_reason === "office" && plain.routed_to_user_id === null
      && plain.escalated_at === null, plain);

    await refused("a reason outside the four words is refused at the door",
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         routed_reason, created_by) values ($1,$2,'annual',$3::date,$4::date,'chairman',$5)`,
      [A, emp2, ...span(), author], /routed_reason_check/);
    await refused("an escalation that says when but not who is refused",
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         routed_reason, escalated_at, created_by)
        values ($1,$2,'annual',$3::date,$4::date,'escalated',now(),$5)`,
      [A, emp2, ...span(), author], /escalation_check/);
    await refused("…and a who with no when, the half a careless update could leave behind",
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         routed_reason, escalated_by, created_by)
        values ($1,$2,'annual',$3::date,$4::date,'escalated',$5,$6)`,
      [A, emp2, ...span(), stranger, author], /escalation_check/);
    const [f3, t3] = span();
    const trioId = await one(
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         routed_reason, escalated_at, escalated_by, escalated_from, created_by)
        values ($1,$2,'annual',$3::date,$4::date,'escalated',now(),$5,$6,$7) returning id`,
      [A, emp2, f3, t3, stranger, approver, author]);
    const trio = (await read(trioId)).rows[0];
    check("…so the complete trio — moment, escalator, seat it left — is the only escalation a row can be",
      String(trio.escalated_by) === stranger && String(trio.escalated_from) === approver
      && !!trio.escalated_at && trio.routed_reason === "escalated", trio);

    // Still waiting, so the route is free to move: this is the escalation the desk performs.
    const [f4, t4] = span();
    const pend = await one(
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         reason, routed_to_user_id, routed_reason, created_by, updated_by)
        values ($1,$2,'annual',$3::date,$4::date,$5,$6,'assigned',$7,$7) returning id`,
      [A, emp, f4, t4, `${REASON} waiting`, approver, author]);
    await accepted("a request that is still waiting can be sent upstairs in one write",
      `update leave_requests
          set routed_to_user_id = null, routed_reason = 'escalated', routed_note = $2,
              escalated_at = now(), escalated_by = $3, escalated_from = $4
        where id = $1`,
      [pend, `Sent up because ${MARK}`, stranger, approver]);
    const moved2 = (await read(pend)).rows[0];
    check("…and the whole chain of it lands: who pushed, who it left, and why",
      moved2.routed_reason === "escalated" && moved2.routed_to_user_id === null
      && String(moved2.escalated_by) === stranger && String(moved2.escalated_from) === approver
      && !!moved2.escalated_at && moved2.routed_note === `Sent up because ${MARK}`, moved2);

    // 065's overlap guard, still standing next to the new trigger.
    await refused("one person cannot be away twice, and the older guard still says so",
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         routed_reason, created_by) values ($1,$2,'annual',$3::date,$4::date,'office',$5)`,
      [A, emp, "2026-06-02", "2026-06-04", author], /already has a leave request covering/);
    const twin = await attempt(() => owner.query(
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         routed_reason, created_by) values ($1,$2,'annual',$3::date,$4::date,'office',$5)
        returning id`, [A, emp2, f1, t1, author]));
    check("…while the same dates for a different person are two separate asks",
      !twin.err, twin.err?.message ?? "(accepted)");

    // ================================================================
    console.log("\n--- 4 · the decision, and what a decided row will no longer say ---");

    await refused("a request cannot be granted by nobody",
      DECIDE, [rq1, "approved", null, null], /names the seat that decided it/);
    await refused("…nor by the person whose leave it is, however the chain was drawn",
      DECIDE, [rq1, "approved", own, null], /cannot decide their own leave/);
    await refused("…nor by the seat that typed the request in for them",
      DECIDE, [rq1, "approved", author, null], /not the seat that decides it/);
    await refused("…and a refusal is held to the same three answers",
      DECIDE, [rq1, "rejected", own, null], /cannot decide their own leave/);

    await accepted("the approver named on the row can answer it",
      DECIDE, [rq1, "approved", approver, "Enjoy the week"]);
    const answered = (await read(rq1)).rows[0];
    check("…and the answer, the seat, the moment and the note are all on the row",
      answered.status === "approved" && String(answered.decided_by) === approver
      && !!answered.decided_at && answered.decision_note === "Enjoy the week", answered);

    // From here the route is history.
    for (const [what, sql, extra] of [
      ["a different reason", "update leave_requests set routed_reason = 'office' where id = $1", null],
      ["a different holder", "update leave_requests set routed_to_user_id = $2 where id = $1", "$2"],
      ["a note added after the fact", "update leave_requests set routed_note = 'moved later' where id = $1", null],
      ["an escalation invented after the answer",
        "update leave_requests set escalated_at = now(), escalated_by = $2 where id = $1", "$2"],
      ["the seat it came from, rewritten", "update leave_requests set escalated_from = $2 where id = $1", "$2"]
    ] as [string, string, string | null][]) {
      await refused(`a decided request will not accept ${what}`,
        sql, extra ? [rq1, stranger] : [rq1], /not rewritten/);
    }
    await accepted("…but it can lose its holder, which is what deleting a seat does",
      "update leave_requests set routed_to_user_id = null where id = $1", [rq1]);
    const afterLose = (await read(rq1)).rows[0];
    check("…and losing it leaves every other part of the chain exactly as the answer was given",
      afterLose.routed_to_user_id === null && afterLose.routed_reason === "assigned"
      && afterLose.status === "approved" && String(afterLose.decided_by) === approver, afterLose);

    // A decided row is not a prison: the acts the desk really needs stay open.
    await accepted("…while the office can still close granted leave",
      `update leave_requests set status = 'cancelled', decision_note = $2, updated_by = $3
        where id = $1`, [rq1, "Back on second thoughts", stranger]);
    check("…and the row now says cancelled, with its decision and route intact",
      (await read(rq1)).rows[0].status === "cancelled", (await read(rq1)).rows[0]);
    await accepted("…and a wrong request is retired by the soft delete",
      `update leave_requests set deleted_at = now() where id = $1`, [rq1]);
    check("…which takes it out of the register the portal reads",
      (await read(rq1)).rows[0].deleted_at !== null, (await read(rq1)).rows[0]);

    // A decision that arrives in one write instead of two carries the same proof.
    await refused("a request inserted already decided, with no seat behind it, is refused too",
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         status, routed_reason) values ($1,$2,'annual',$3::date,$4::date,'approved','office')`,
      [A, emp, ...span()], /names the seat that decided it/);
    await refused("…and so is one inserted decided by the person it is about",
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         status, decided_by, routed_reason)
        values ($1,$2,'annual',$3::date,$4::date,'approved',$5,'office')`,
      [A, emp, ...span(), own], /cannot decide their own leave/);
    const [f6, t6] = span();
    const oneShot = await attempt(() => owner.query(
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         status, decided_by, created_by, routed_reason, routed_to_user_id)
        values ($1,$2,'annual',$3::date,$4::date,'approved',$5,$6,'assigned',$7)
        returning id`, [A, emp, f6, t6, approver, author, approver]));
    check("…while a decision recorded honestly in one write is kept, route and all",
      !oneShot.err && (await read(oneShot.ok!.rows[0].id)).rows[0].routed_reason === "assigned",
      oneShot.err?.message ?? "(accepted)");

    // The queue an approver opens is theirs only while the request waits.
    const [f7, t7] = span();
    const theirs = await one(
      `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
         reason, routed_to_user_id, routed_reason, created_by)
        values ($1,$2,'unpaid',$3::date,$4::date,$5,$6,'assigned',$7) returning id`,
      [A, emp2, f7, t7, `${REASON} queue`, approver, author]);
    const queueWhere =
      `select count(*)::int as n from leave_requests
        where routed_to_user_id = $1 and status = 'pending' and deleted_at is null`;
    const beforeQueue = n((await owner.query(queueWhere, [approver])).rows[0].n);
    check("the queue its index serves finds a request sent to that seat", beforeQueue >= 1, beforeQueue);
    await accepted("…and the holder answering it takes it out of the waiting pile",
      DECIDE, [theirs, "approved", approver, null]);
    const afterQueue = n((await owner.query(queueWhere, [approver])).rows[0].n);
    check("…which is what an index over pending lines only is for",
      afterQueue === beforeQueue - 1, { beforeQueue, afterQueue });

    const weeks = await owner.query(
      `select count(*)::int as asks, count(distinct starts_on)::int as spans
         from leave_requests where reason like $1`, [`%${MARK}%`]);
    check("no two probes ever shared a span for one person",
      n(weeks.rows[0].asks) === n(weeks.rows[0].spans) && n(weeks.rows[0].spans) > 0,
      weeks.rows[0]);
  } finally {
    await owner.query("rollback").catch(() => { });
  }

  // ================================================================
  console.log("\n--- 5 · the same rules through the role the API actually connects as ---");

  const app = appUrl();
  if (!app) {
    console.log("skip  app_runtime probe (no APP_DB_PASSWORD / APP_DATABASE_URL)");
  } else {
    const runtime = await connectRuntime(app);
    let rsp = 0;
    async function rtProbe(sql: string, params: any[] = []) {
      const name = `rp${++rsp}`;
      await runtime.query(`savepoint ${name}`);
      try {
        const r = await runtime.query(sql, params);
        await runtime.query(`rollback to savepoint ${name}`);
        return { rows: r.rows ?? [], err: null as string | null };
      } catch (e: any) {
        await runtime.query(`rollback to savepoint ${name}`);
        return { rows: null, err: String(e.message) as string | null };
      }
    }
    await runtime.query("begin");
    try {
      const naked = await runtime.query(
        `select count(*)::int as n from leave_requests where routed_reason <> 'office'`);
      check("with no tenant claimed, the application role reads nobody's routed request",
        n(naked.rows[0].n) === 0, naked.rows[0]);

      await runtime.query(`select set_config('app.tenant_id', $1, true)`, [A]);
      const rtSeat = (await runtime.query(
        `insert into users (tenant_id, user_type, email, status, full_name)
          values ($1,'staff',$2,'active',$3) returning id`,
        [A, `${STAMP}-rt@108.invalid`, `${MARK} runtime approver`])).rows[0].id as string;
      const rtOwn = (await runtime.query(
        `insert into users (tenant_id, user_type, email, status, full_name)
          values ($1,'staff',$2,'active',$3) returning id`,
        [A, `${STAMP}-rt-own@108.invalid`, `${MARK} runtime clerk seat`])).rows[0].id as string;
      const rtEmp = (await runtime.query(
        `insert into employees (tenant_id, full_name, status, user_id)
          values ($1,$2,'active',$3) returning id`,
        [A, `${MARK} runtime clerk`, rtOwn])).rows[0].id as string;

      const named = await runtime.query(
        `update employees set leave_approver_user_id = $2
          where id = $1 and tenant_id = $3`, [rtEmp, rtSeat, A]);
      const [rf, rt] = span();
      const req = (await runtime.query(
        `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
           reason, routed_to_user_id, routed_reason, created_by, updated_by)
          values ($1,$2,'annual',$3::date,$4::date,$5,$6,'assigned',$7,$7) returning id`,
        [A, rtEmp, rf, rt, `${REASON} runtime`, rtSeat, rtOwn])).rows[0].id as string;
      const answered2 = await runtime.query(
        `update leave_requests set status = 'approved', decided_by = $2, decided_at = now()
          where id = $1 and tenant_id = $3`, [req, rtSeat, A]);
      const seen = (await runtime.query(
        `select status, decided_by, routed_reason from leave_requests where id = $1`, [req])).rows[0];
      check("app_runtime can make the assignment, stamp the route and take the decision",
        named.rowCount === 1 && answered2.rowCount === 1 && seen.status === "approved"
        && String(seen.decided_by) === rtSeat && seen.routed_reason === "assigned", seen);

      const rewrite = await rtProbe(
        "update leave_requests set routed_reason = 'office' where id = $1", [req]);
      check("…and the same role inside its own tenant is refused by the trigger all the same",
        !!rewrite.err && /not rewritten/.test(rewrite.err), rewrite.err ?? "(accepted)");
      const swap = await rtProbe(
        "update leave_requests set routed_to_user_id = $2 where id = $1", [req, rtOwn]);
      check("…including a re-point at another seat, which is how an audit gets rewritten",
        !!swap.err && /not rewritten/.test(swap.err), swap.err ?? "(accepted)");
      const self = await rtProbe(
        "update employees set leave_approver_user_id = $2 where id = $1", [rtEmp, rtOwn]);
      check("…and the assignment guard fires for this role too, not only for the owner",
        !!self.err && /cannot be the person whose leave/.test(self.err), self.err ?? "(accepted)");

      // Kept inside the transaction: a probe that rolls its own savepoint back would leave the
      // decision below with no row to decide, and a silent zero-row update reads as a pass.
      const [rf2, rt2] = span();
      const freshId = (await runtime.query(
        `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
           reason, routed_to_user_id, routed_reason, created_by, updated_by)
          values ($1,$2,'annual',$3::date,$4::date,$5,$6,'assigned',$7,$7) returning id`,
        [A, rtEmp, rf2, rt2, `${REASON} own answer`, rtSeat, rtOwn])).rows[0].id as string;
      const grantSelf = await rtProbe(
        `update leave_requests set status = 'rejected', decided_by = $2, decided_at = now()
          where id = $1 and tenant_id = $3`, [freshId, rtOwn, A]);
      check("…so a clerk holding the deciding key still cannot refuse their own leave",
        !!grantSelf.err && /cannot decide their own leave/.test(grantSelf.err),
        grantSelf.err ?? "(the request was decided by the person it is about)");

      const hardDelete = await rtProbe("delete from leave_requests where id = $1", [req]);
      check("…and the role holds no DELETE, so a request is closed by the desk, not erased",
        !!hardDelete.err && /permission denied/.test(hardDelete.err),
        hardDelete.err ?? "(accepted)");

      await runtime.query(`select set_config('app.tenant_id', $1, true)`, [B]);
      const across = await runtime.query(
        `select count(*)::int as n from leave_requests where id = $1`, [req]);
      check("one company's role cannot read the request it just watched being decided",
        n(across.rows[0].n) === 0, across.rows[0]);
      const forged = await rtProbe(
        `insert into leave_requests (tenant_id, employee_id, leave_kind, starts_on, ends_on,
           routed_to_user_id, routed_reason, created_by)
          values ($1,$2,'annual',$3::date,$4::date,$5,'assigned',$6)`,
        [A, rtEmp, ...span(), rtSeat, rtOwn]);
      check("…and writing into the first company while the second is claimed stops at the policy",
        !!forged.err && /row-level security/.test(forged.err), forged.err ?? "(accepted)");
      await runtime.query("rollback");
    } catch (e) {
      await runtime.query("rollback").catch(() => { });
      check("the app_runtime probes rolled back cleanly", false, String(e).slice(0, 500));
    }
    const residue = await owner.query(
      `select (select count(*)::int from leave_requests
                where reason like '%108 verify%' or routed_note like '%108 verify%') as asks,
              (select count(*)::int from leave_requests
                where created_by in (select id from users where full_name like '%108 verify%')) as authored,
              (select count(*)::int from employees where full_name like '%108 verify%') as staff,
              (select count(*)::int from users
                where full_name like '%108 verify%' or email like '108v%') as seats`);
    check("nothing this gate wrote is left on the database",
      Object.values(residue.rows[0]).every((v) => n(v) === 0), residue.rows[0]);
    await runtime.end().catch(() => { });
  }

  await owner.end().catch(() => { });
  console.log(`\n${failures ? "FAILED" : "PASS"} — ${checks} checks, ${failures} failures`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error("gate crashed:", String(e?.message ?? e).slice(0, 600));
  process.exitCode = 1;
});
