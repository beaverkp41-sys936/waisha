/**
 * Live proof for task #182 — the day's proof of work (migration 107).
 *
 * Everything 107 promises is a promise the database has to keep, because the route that writes
 * it is one file away from a route someone will add next month:
 *
 *  1. a position is coarse *by rule*, not by convention — and the rule has to fire on both
 *     paths that can write one. A person who clocks in first and confirms later is an UPDATE,
 *     and a trigger that shaped only INSERTs would leave that one stored to the metre while
 *     everybody else got 100 m. That is the exact bug this gate exists to keep dead;
 *  2. a half-made confirmation is decided, not stored: the trigger resolves the two mixed
 *     shapes into the one the kind means and refuses the two shapes it cannot complete;
 *  3. a proof already given cannot be quietly swapped, while the office's correction of the day
 *     and its soft delete both stay possible — a wrong row must not be a prison;
 *  4. the photograph is a document like every other one, so `attendance_proof` had to enter the
 *     kind list, and a kind that is not on the list still has to be refused;
 *  5. all of it holds for `app_runtime` — the role the API actually connects as — not only for
 *     the owner that ran the migration.
 *
 * Every write is rolled back, and every probe day gets its own date: the register is unique on
 * one line per person per day, and a collision would read as a guard that never existed.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-attendance-proof.ts
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
/** …and with a bracket for every clause Postgres added itself. Reading a rule for what it
 *  forbids means dropping that scaffolding, not quoting it back character for character. */
const flat = (s: unknown) => norm(s).replace(/[()]/g, "");
const n = (v: any) => (v === null || v === undefined ? NaN : Number(v));

/** One stamp per run, so a probe day can never be mistaken for a person's Tuesday. */
const STAMP = "107v" + Date.now().toString(36);
const MARK = `107 verify ${STAMP}`;
// A real Dar es Salaam position at the precision a phone reports — and the column must not keep.
const FINE = { lat: -6.7923815, lng: 39.2833334 };
const COARSE = { lat: -6.792, lng: 39.283 };
const AT = "2026-02-17T08:03:00.000Z";

/** The proof as the route's own two statements carry it. */
interface Probe { kind: string; lat?: any; lng?: any; acc?: any; doc?: any }
const proofSql = (p: Probe) => [p.kind, p.lat ?? null, p.lng ?? null,
p.acc ?? null, p.doc ?? null];

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();

  // ================================================================
  console.log("\n--- 1 · the seven columns as the catalog actually describes them ---");

  const cols = await owner.query(
    `select column_name, is_nullable, data_type, numeric_precision, numeric_scale
       from information_schema.columns
      where table_name = 'employee_attendance'
        and column_name in ('confirmed_at','confirmed_by','proof_kind','proof_lat',
                            'proof_lng','proof_accuracy_m','proof_document_id')
      order by column_name`);
  check("107 added all seven proof columns to employee_attendance", cols.rowCount === 7,
    cols.rows.map((r) => r.column_name));
  const by = new Map(cols.rows.map((r) => [r.column_name, r]));
  check("every one of them is nullable — a day stated by the desk carries no proof at all",
    cols.rows.every((r) => r.is_nullable === "YES"),
    cols.rows.map((r) => [r.column_name, r.is_nullable]));
  check("confirmed_at is a moment (timestamptz), confirmed_by a seat (uuid), proof_kind words (text)",
    by.get("confirmed_at")?.data_type === "timestamp with time zone"
    && by.get("confirmed_by")?.data_type === "uuid"
    && by.get("proof_kind")?.data_type === "text",
    [by.get("confirmed_at")?.data_type, by.get("confirmed_by")?.data_type,
      by.get("proof_kind")?.data_type]);
  check("proof_lat and proof_lng are numeric(9,6): six decimals is the widest the column can hold",
    by.get("proof_lat")?.data_type === "numeric" && n(by.get("proof_lat")?.numeric_precision) === 9
    && n(by.get("proof_lat")?.numeric_scale) === 6
    && by.get("proof_lng")?.data_type === "numeric" && n(by.get("proof_lng")?.numeric_precision) === 9
    && n(by.get("proof_lng")?.numeric_scale) === 6, [by.get("proof_lat"), by.get("proof_lng")]);
  check("proof_accuracy_m is a plain integer — metres, not a float that argues about metres",
    by.get("proof_accuracy_m")?.data_type === "integer", by.get("proof_accuracy_m")?.data_type);
  const fk = await owner.query(
    `select confrelid::regclass::text as refs from pg_constraint
      where conrelid = 'employee_attendance'::regclass and contype = 'f'
        and conkey = array[(select attnum from pg_attribute
                             where attrelid = 'employee_attendance'::regclass
                               and attname = 'proof_document_id')]`);
  check("the photograph is a real foreign key into documents, so a proof cannot dangle",
    fk.rowCount === 1 && fk.rows[0].refs === "documents", fk.rows);

  // ================================================================
  console.log("\n--- 2 · the four rules the CHECKs carry, read from the catalog ---");

  const cons = await owner.query(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid in ('employee_attendance'::regclass, 'documents'::regclass)`);
  const def = new Map(cons.rows.map((r) => [r.conname, flat(r.def)]));
  const need = ["employee_attendance_proof_kind_check", "employee_attendance_proof_pair_check",
    "employee_attendance_proof_geo_check", "employee_attendance_proof_shape_check"];
  check("all four checks are on the table", need.every((k) => def.has(k)),
    need.filter((k) => !def.has(k)));
  check("the kind is only ever location or photo",
    /proof_kind is null or proof_kind = any array\['location', 'photo'\]/
      .test(def.get(need[0]) ?? ""), def.get(need[0]));
  check("time, seat and thing-shown arrive together or not at all",
    /confirmed_at is null and proof_kind is null and confirmed_by is null/
      .test(def.get(need[1]) ?? "")
    && /confirmed_at is not null and confirmed_by is not null and proof_kind is not null/
      .test(def.get(need[1]) ?? ""), def.get(need[1]));
  check("the bounds are the planet's and the accuracy has a ceiling",
    /proof_lat >= '-90' and proof_lat <= 90/.test(def.get(need[2]) ?? "")
    && /proof_lng >= '-180' and proof_lng <= 180/.test(def.get(need[2]) ?? "")
    && /proof_accuracy_m >= 0 and proof_accuracy_m <= 20000/.test(def.get(need[2]) ?? ""),
    def.get(need[2]));
  check("the kind decides which half of the row may be filled, both directions",
    /proof_kind = 'location' and proof_lat is not null and proof_lng is not null and proof_document_id is null/
      .test(def.get(need[3]) ?? "")
    && /proof_kind = 'photo' and proof_document_id is not null and proof_lat is null and proof_lng is null and proof_accuracy_m is null/
      .test(def.get(need[3]) ?? ""), def.get(need[3]));
  const kinds = def.get("documents_kind_check") ?? "";
  check("attendance_proof joined the documents kind list…", /'attendance_proof'/.test(kinds),
    kinds.slice(-160));
  check("…appended last, with the cargo papers still on the list in front of it",
    /'pod', 'handover', 'proforma', 'attendance_proof'\]/.test(kinds)
    && /'invoice'/.test(kinds), kinds.slice(-160));

  console.log("\n--- 3 · the trigger, its grant, and the index the desk reads through ---");

  const trg = await owner.query(
    `select t.tgname, t.tgenabled,
            (t.tgtype::int & 2) <> 0 as before,
            (t.tgtype::int & 4) <> 0 as ins,
            (t.tgtype::int & 16) <> 0 as upd,
            (t.tgtype::int & 1) <> 0 as for_each_row,
            p.proname, p.prosecdef,
            has_function_privilege('app_runtime', p.oid, 'execute') as rt_execute
       from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = 'employee_attendance'::regclass
        and not t.tgisinternal and p.proname = 'attendance_proof_shape'`);
  check("one row-level BEFORE INSERT OR UPDATE trigger runs the shaping, and it is enabled",
    trg.rowCount === 1 && trg.rows[0].before && trg.rows[0].ins && trg.rows[0].upd
    && trg.rows[0].for_each_row && trg.rows[0].tgenabled === "O", trg.rows);
  check("app_runtime may execute it — a grant the migration forgot would 500 every confirmation",
    trg.rows[0]?.rt_execute === true, trg.rows[0]);
  check("…and it is an ordinary function, not a definer with a wider view than its caller",
    trg.rows[0]?.prosecdef === false, trg.rows[0]?.prosecdef);

  const idx = await owner.query(
    `select indexdef from pg_indexes where tablename = 'employee_attendance'
      and indexname = 'idx_attendance_proof'`);
  const idxdef = flat(idx.rows[0]?.indexdef ?? "");
  check("the confirmed-days index is this tenant on this date, and only confirmed lines",
    idx.rowCount === 1 && /on public\.employee_attendance using btree tenant_id, work_date/.test(idxdef)
    && /where deleted_at is null and confirmed_at is not null/.test(idxdef),
    idx.rows[0]?.indexdef);

  const keys = await owner.query(
    `select key from permissions where key like 'attendance%' order by key`);
  check("107 added no new duty key: confirming stays inside the clock-in the desk already holds",
    keys.rowCount === 3 && keys.rows.every((r) => r.key !== "attendance.confirm"),
    keys.rows.map((r) => r.key));

  // ================================================================
  console.log("\n--- 4 · the writes, on lines that roll back ---");

  const tenants = await owner.query(
    `select id from tenants where deleted_at is null order by created_at limit 2`);
  if (!tenants.rowCount) throw new Error("No tenant on the database to write a day for");
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
  const one = async (sql: string, params: any[]): Promise<string> =>
    (await owner.query(sql, params)).rows[0].id as string;

  try {
    const emp = await one(
      `insert into employees (tenant_id, full_name, status) values ($1,$2,'active') returning id`,
      [A, `${MARK} clerk`]);
    const seat = randomUUID();
    const read = (id: string) => owner.query(
      `select confirmed_at, confirmed_by, proof_kind, proof_lat, proof_lng,
              proof_accuracy_m, proof_document_id, deleted_at, note
         from employee_attendance where id = $1`, [id]);
    /** The route's INSERT branch: the confirmation is the day's first line. */
    const insertConfirm = async (day: string, p: Probe) => {
      const id = randomUUID();
      await owner.query(
        `insert into employee_attendance
           (id, tenant_id, employee_id, work_date, clock_in, day_status, note,
            confirmed_at, confirmed_by, proof_kind, proof_lat, proof_lng,
            proof_accuracy_m, proof_document_id, created_by, updated_by)
         values ($1,$2,$3,$4::date,$5,'present','Self clock-in',$5,$6,$7,$8,$9,$10,$11,$6,$6)`,
        [id, A, emp, day, AT, seat, ...proofSql(p)]);
      return id;
    };
    /** …and its UPDATE branch: a line a plain clock-in or the office already opened. */
    const openDay = (label: string, day: string) => one(
      `insert into employee_attendance (tenant_id, employee_id, work_date, day_status, note)
        values ($1,$2,$3::date,'present',$4) returning id`,
      [A, emp, day, `${MARK} ${label}`]);
    const updateConfirm = (id: string, p: Probe) => owner.query(
      `update employee_attendance
          set clock_in = coalesce(clock_in, $2), confirmed_at = $2, confirmed_by = $3,
              proof_kind = $4, proof_lat = $5, proof_lng = $6,
              proof_accuracy_m = $7, proof_document_id = $8
        where id = $1`, [id, AT, seat, ...proofSql(p)]);

    // ---- coarse by rule, on both paths that can write a position ----
    const insId = await insertConfirm("2026-02-17", { kind: "location", ...FINE, acc: 42 });
    const insRow = (await read(insId)).rows[0];
    check("a fresh confirmed day keeps three decimals: −6.7923815 became −6.792",
      n(insRow.proof_lat) === COARSE.lat, insRow.proof_lat);
    check("…and the same on the longitude, so the pair cannot describe one metre of ground",
      n(insRow.proof_lng) === COARSE.lng, insRow.proof_lng);
    check("…which the column hands back as a padded string, so a read that shows it has to cast it",
      String(insRow.proof_lat) === "-6.792000", String(insRow.proof_lat));
    check("the rest of the confirmation lands as written",
      !!insRow.confirmed_at && String(insRow.confirmed_by) === seat
      && insRow.proof_kind === "location" && n(insRow.proof_accuracy_m) === 42
      && insRow.proof_document_id === null, insRow);

    const updId = await openDay("clock then confirm", "2026-02-18");
    await updateConfirm(updId, { kind: "location", ...FINE, acc: 42 });
    const updRow = (await read(updId)).rows[0];
    check("a person who clocked in first, then confirmed, is rounded too — the UPDATE path",
      n(updRow.proof_lat) === COARSE.lat && n(updRow.proof_lng) === COARSE.lng,
      { lat: updRow.proof_lat, lng: updRow.proof_lng });
    check("…which is the path a trigger that shaped INSERTs only would have lost to the metre",
      !!updRow.confirmed_at && updRow.proof_kind === "location", updRow);

    // ---- the kind decides the shape ----
    const photo = await one(
      `insert into documents (tenant_id, entity_type, entity_id, kind, file_name, mime_type,
         size_bytes, storage_path, uploaded_by, created_by, updated_by)
        values ($1,'employee',$2,'attendance_proof',$3,'image/png',1234,$4,$5,$5,$5)
        returning id`,
      [A, emp, `${MARK}.png`, `${A}/employee/${emp}/${MARK}.png`, seat]);
    const photoId = await openDay("photo path", "2026-02-19");
    await updateConfirm(photoId, { kind: "photo", doc: photo });
    const photoRow = (await read(photoId)).rows[0];
    check("a photograph fills the document and leaves every number null",
      photoRow.proof_kind === "photo" && String(photoRow.proof_document_id) === photo
      && photoRow.proof_lat === null && photoRow.proof_lng === null
      && photoRow.proof_accuracy_m === null, photoRow);

    const stray = await insertConfirm("2026-02-20",
      { kind: "photo", ...FINE, acc: 42, doc: photo });
    const strayRow = (await read(stray)).rows[0];
    check("numbers sent beside a picture are erased rather than kept as a second story",
      strayRow.proof_lat === null && strayRow.proof_lng === null
      && strayRow.proof_accuracy_m === null && String(strayRow.proof_document_id) === photo,
      strayRow);
    const locWithFile = await insertConfirm("2026-02-21",
      { kind: "location", ...FINE, acc: 42, doc: photo });
    const locRow = (await read(locWithFile)).rows[0];
    check("…and a file sent beside a position is erased the same way, so the kind wins twice",
      locRow.proof_document_id === null && n(locRow.proof_lat) === COARSE.lat, locRow);

    await refused("a picture with nothing filed behind it is refused, not silently emptied",
      `insert into employee_attendance (tenant_id, employee_id, work_date, day_status,
         confirmed_at, confirmed_by, proof_kind)
        values ($1,$2,$3::date,'present',$4,$5,'photo')`,
      [A, emp, "2026-02-22", AT, seat], /proof_shape_check/);
    await refused("…and so is a position with no coordinates to round",
      `insert into employee_attendance (tenant_id, employee_id, work_date, day_status,
         confirmed_at, confirmed_by, proof_kind)
        values ($1,$2,$3::date,'present',$4,$5,'location')`,
      [A, emp, "2026-02-23", AT, seat], /proof_shape_check/);
    await refused("half a confirmation is refused: a time and a kind with no seat behind them",
      `insert into employee_attendance (tenant_id, employee_id, work_date, day_status,
         confirmed_at, proof_kind) values ($1,$2,$3::date,'present',$4,'location')`,
      [A, emp, "2026-02-24", AT], /proof_pair_check/);
    await refused("…and a seat and a kind that never said when",
      `insert into employee_attendance (tenant_id, employee_id, work_date, day_status,
         confirmed_by, proof_kind, proof_lat, proof_lng)
        values ($1,$2,$3::date,'present',$4,'location',-6.792,39.283)`,
      [A, emp, "2026-02-25", seat], /proof_pair_check/);
    await refused("a kind that is neither of the two words is refused at the door",
      `insert into employee_attendance (tenant_id, employee_id, work_date, day_status,
         confirmed_at, confirmed_by, proof_kind) values ($1,$2,$3::date,'present',$4,$5,'gps')`,
      [A, emp, "2026-02-26", AT, seat], /proof_kind_check/);

    // ---- the bounds, each one refused by the geo check ----
    for (const [what, lat, lng, acc] of [
      ["a latitude past the pole", 91, 39.283, 42],
      ["a latitude below it", -91, 39.283, 42],
      ["a longitude off the world", -6.792, 181, 42],
      ["an accuracy measured before the device existed", -6.792, 39.283, -1],
      ["an accuracy wider than the atmosphere", -6.792, 39.283, 20001]
    ] as [string, number, number, number][]) {
      await refused(`the CHECK refuses ${what}`,
        `insert into employee_attendance (tenant_id, employee_id, work_date, day_status,
           confirmed_at, confirmed_by, proof_kind, proof_lat, proof_lng, proof_accuracy_m)
          values ($1,$2,$3::date,'present',$4,$5,'location',$6,$7,$8)`,
        [A, emp, "2026-02-27", AT, seat, lat, lng, acc], /proof_geo_check/);
    }
    const edge = await insertConfirm("2026-02-28",
      { kind: "location", lat: 90, lng: -180, acc: 20000 });
    check("…while the limits themselves are legal days, at either end of the world",
      n((await read(edge)).rows[0].proof_lat) === 90, await read(edge));
    const zero = await insertConfirm("2026-03-01",
      { kind: "location", lat: -6.792, lng: 39.283, acc: 0 });
    check("…and a device that claims perfect accuracy keeps the day and the claim",
      n((await read(zero)).rows[0].proof_accuracy_m) === 0, await read(zero));

    // ---- the evidence, once given, is frozen ----
    const frozen = await openDay("immutability", "2026-03-02");
    await updateConfirm(frozen, { kind: "location", ...FINE, acc: 42 });
    for (const [what, sql] of [
      ["a different position", "update employee_attendance set proof_lat = -1.000 where id = $1"],
      ["a different kind", "update employee_attendance set proof_kind = 'photo' where id = $1"],
      ["a later moment", "update employee_attendance set confirmed_at = now() where id = $1"],
      ["a different seat", "update employee_attendance set confirmed_by = gen_random_uuid() where id = $1"],
      ["no accuracy at all", "update employee_attendance set proof_accuracy_m = null where id = $1"],
      ["a blanked-out proof", "update employee_attendance set proof_kind = null where id = $1"]
    ] as [string, string][]) {
      await refused(`a confirmed day will not accept ${what}`,
        sql, [frozen], /keeps its proof/);
    }
    const noteFix = await attempt(() => owner.query(
      `update employee_attendance set note = 'corrected by the office' where id = $1`, [frozen]));
    check("…but the office can still correct the day itself, which is the act that is allowed",
      !noteFix.err && (await read(frozen)).rows[0].note === "corrected by the office",
      noteFix.err?.message ?? "(accepted)");
    const stampFix = await attempt(() => owner.query(
      `update employee_attendance set clock_in = $2 where id = $1`,
      [frozen, "2026-03-02T09:30:00.000Z"]));
    check("…the clock too, so a late arrival can still be fixed without touching the evidence",
      !stampFix.err, stampFix.err?.message ?? "(accepted)");
    const statusFix = await attempt(() => owner.query(
      `update employee_attendance set day_status = 'late' where id = $1`, [frozen]));
    check("…and the finding about the day, which is what attendance.edit is for",
      !statusFix.err, statusFix.err?.message ?? "(accepted)");

    const softDel = await attempt(() => owner.query(
      `update employee_attendance set deleted_at = now() where id = $1`, [frozen]));
    check("…and a wrong row is retired by the soft delete, so a confirmation is not a prison",
      !softDel.err && (await read(frozen)).rows[0].deleted_at !== null,
      softDel.err?.message ?? "(accepted)");
    const gone = await owner.query(
      `select count(*)::int as n from employee_attendance
        where id = $1 and deleted_at is null`, [frozen]);
    check("…which takes the retired line out of the register the portal reads, proof and all",
      n(gone.rows[0].n) === 0, gone.rows[0]);
    const back = await attempt(() => insertConfirm("2026-03-02",
      { kind: "location", ...FINE, acc: 30 }));
    check("…after which the person can confirm the same date again on one fresh live line",
      !back.err && n((await owner.query(
        `select count(*)::int as n from employee_attendance
          where tenant_id = $1 and employee_id = $2 and work_date = $3::date
            and deleted_at is null`, [A, emp, "2026-03-02"])).rows[0].n) === 1,
      back.err?.message ?? "(accepted)");

    // ---- the first confirmation of an unconfirmed day stays legal ----
    const first = await openDay("first write", "2026-03-03");
    const fresh = await attempt(() => updateConfirm(first, { kind: "location", ...FINE, acc: 30 }));
    check("a day that had no proof yet can be given one, and it is rounded as it lands",
      !fresh.err && n((await read(first)).rows[0].proof_lat) === COARSE.lat,
      fresh.err?.message ?? "(accepted)");
    await refused("an attendance line cannot point at a document that is not there",
      `insert into employee_attendance (tenant_id, employee_id, work_date, day_status,
         confirmed_at, confirmed_by, proof_kind, proof_document_id)
        values ($1,$2,$3::date,'present',$4,$5,'photo',
                '00000000-0000-0000-0000-00000000dead')`,
      [A, emp, "2026-03-04", AT, seat], /foreign key/);

    // ---- the documents lists still exclude what is not on them ----
    await refused("a document kind that is not on the list is still refused",
      `insert into documents (tenant_id, entity_type, entity_id, kind, file_name, mime_type,
         size_bytes, storage_path) values ($1,'employee',$2,'payroll_payslip','x.png',
         'image/png',1,$3)`, [A, emp, `${A}/employee/${emp}/x.png`], /documents_kind_check/);
    await refused("…and so is a record type the vault has never carried",
      `insert into documents (tenant_id, entity_type, entity_id, kind, file_name, mime_type,
         size_bytes, storage_path) values ($1,'attendance_sheet',$2,'attendance_proof','x.png',
         'image/png',1,$3)`, [A, emp, `${A}/employee/${emp}/y.png`],
      /documents_entity_type_check/);

    const dates = await owner.query(
      `select count(distinct work_date)::int as dates, count(*)::int as lines
         from employee_attendance where tenant_id = $1 and employee_id = $2
           and note like '%107 verify %' and deleted_at is null`, [A, emp]);
    check("one line per person per day still, through every probe above",
      n(dates.rows[0].lines) === n(dates.rows[0].dates) && n(dates.rows[0].lines) > 0,
      dates.rows[0]);
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
        `select count(*)::int as n from employee_attendance where confirmed_at is not null`);
      check("with no tenant claimed, the application role reads nobody's confirmed day",
        n(naked.rows[0].n) === 0, naked.rows[0]);

      await runtime.query(`select set_config('app.tenant_id', $1, true)`, [A]);
      const emp = (await runtime.query(
        `insert into employees (tenant_id, full_name, status) values ($1,$2,'active') returning id`,
        [A, `${MARK} runtime clerk`])).rows[0].id as string;
      const id = (await runtime.query(
        `insert into employee_attendance (tenant_id, employee_id, work_date, day_status, note)
          values ($1,$2,'2026-04-06'::date,'present',$3) returning id`,
        [A, emp, `${MARK} rt`])).rows[0].id as string;
      const wrote = await runtime.query(
        `update employee_attendance
            set confirmed_at = $2, confirmed_by = $3, proof_kind = 'location',
                proof_lat = $4, proof_lng = $5, proof_accuracy_m = 25
          where id = $1 and tenant_id = $6`,
        [id, AT, randomUUID(), FINE.lat, FINE.lng, A]);
      const got = (await runtime.query(
        `select proof_lat, proof_lng, note from employee_attendance where id = $1`, [id])).rows[0];
      const rounds = "app_runtime can confirm a day and the trigger rounds for it too";
      const roundsWhy = " — a shaping that only worked for the owner would fail the portal";
      check(rounds + roundsWhy,
        wrote.rowCount === 1 && n(got.proof_lat) === COARSE.lat && n(got.proof_lng) === COARSE.lng,
        got);
      const freeze = await rtProbe("update employee_attendance set proof_lat = -1.5 where id = $1", [id]);
      check("…and the same role, inside its own tenant, is refused by the trigger all the same",
        !!freeze.err && /keeps its proof/.test(freeze.err), freeze.err ?? "(accepted)");
      const kindSwap = await rtProbe(
        "update employee_attendance set proof_kind = 'photo' where id = $1", [id]);
      check("…including a swap of the kind, which is how an alibi would be rewritten",
        !!kindSwap.err && /keeps its proof/.test(kindSwap.err), kindSwap.err ?? "(accepted)");
      const hardDelete = await rtProbe("delete from employee_attendance where id = $1", [id]);
      check("…and the role holds no DELETE at all, so a day is retired by the office, not erased",
        !!hardDelete.err && /permission denied/.test(hardDelete.err),
        hardDelete.err ?? "(accepted)");

      await runtime.query(`select set_config('app.tenant_id', $1, true)`, [B]);
      const across = await runtime.query(
        `select count(*)::int as n from employee_attendance where id = $1`, [id]);
      check("one company's role cannot read the confirmation it just watched being written",
        n(across.rows[0].n) === 0, across.rows[0]);
      const forged = await rtProbe(
        `insert into employee_attendance (tenant_id, employee_id, work_date, day_status,
           confirmed_at, confirmed_by, proof_kind, proof_lat, proof_lng)
          values ($1,$2,'2026-04-06'::date,'present',$3,$4,'location',-6.792,39.283)`,
        [A, emp, AT, randomUUID()]);
      const forgedLabel = "…and writing into the first company while the second is claimed"
        + " stops at the policy, not at a WHERE clause";
      check(forgedLabel, !!forged.err && /row-level security/.test(forged.err),
        forged.err ?? "(accepted)");
      await runtime.query("rollback");
    } catch (e) {
      await runtime.query("rollback").catch(() => { });
      check("the app_runtime probes rolled back cleanly", false, String(e).slice(0, 500));
    }
    const residue = await owner.query(
      `select (select count(*)::int from employee_attendance where note like '%107 verify %') as days,
              (select count(*)::int from employees where full_name like '%107 verify%') as staff,
              (select count(*)::int from documents where file_name like '%107 verify%') as files,
              (select count(*)::int from employee_attendance
                where confirmed_at is not null and note like '%verify%') as proofs`);
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
