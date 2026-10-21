/**
 * Live proof for the warehouse register (migrations 118–119:
 * api/src/routes/warehouse.routes.ts, api/migrations/118_warehouse_register.sql).
 *
 * Every statement the two desks export is executed here verbatim — never re-typed — as
 * `app_runtime` with this run's company bound, inside one transaction that is thrown away. A
 * typecheck cannot see a column list, a parameter count or a grant, and the API's own role has
 * BYPASSRLS, so the only way to learn what the register's role is actually allowed to do is to log
 * in as it. The smoke proves the HTTP doors; this proves the table underneath them.
 *
 * Six things this exists to catch:
 *  - that the figures on a hold are the dockets' conclusion in the *database*, not only in the
 *    routes: 118 promised it in a comment and 119 put it in the trigger, so a hand-written
 *    `quantity_in` is emptied on insert and refused on update, while the bookkeeping trigger —
 *    the same role, holding the same grants — is let through by the mark it sets for its own write;
 *  - that the money is computed from the working day of the country: the register prices every hold
 *    against one `today`, and the three functions of 118 give the same figure the desk prints;
 *  - that a store's paper is immutable in both directions: a filed docket's quantity is not even an
 *    updatable *column* for this role, a void carries a name and a reason, and an entry cannot be
 *    un-filed while the goods it received are still out;
 *  - that a hold which has been emptied or called off is a told story — tariff, place, goods and
 *    the file it belongs to all freeze, and no delivery docket may be filed onto it, because its
 *    one `entered_on` would charge new goods from the day the first crate arrived;
 *  - that the row-level policies, not the bind, are the isolation: a statement that names another
 *    company's tenant answers empty, and a session pointed at a stranger's company sees nothing of
 *    ours even when the bind is correct;
 *  - that nothing in the register can be deleted: `warehouse_stays` has no DELETE grant and a hold
 *    is taken off the book only by an exit docket or a cancellation with a name on it.
 *
 * Nothing a person owns is touched: the run plants its own company, its own seat and its own cargo
 * file, the marker goes into every row it writes, the whole pass is rolled back, and the residue is
 * read afterwards on an operator connection (bound to no tenant, app_runtime is told by the policies
 * that there is nothing to see, and a zero that came from a policy proves nothing).
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-warehouse-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { uuidv7 } from "../src/util/uuid.js";
import {
  BY_CURRENCY_SQL, BY_FILE_SQL, BY_PLACE_SQL, DOCKETS_SQL, DOCKET_INSERT_SQL, FILES_SQL,
  HOLD_BALANCE_SQL, HOLD_CANCEL_SQL, HOLD_EDIT_SQL, HOLD_LOCK_SQL, HOLD_STATE_SQL, OPEN_INSERT_SQL,
  SLIP_HOLD_SQL, SLIP_VOID_SQL, STORE_CLOCK_SQL, STAYS_SQL, TOTALS_SQL
} from "../src/routes/warehouse.routes.js";

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

const n = (v: unknown) => Number(v ?? 0);
/** The store's working day, the way the register reads it: Africa/Dar_es_Salaam, not UTC. */
const eatToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const shift = (iso: string, days: number) =>
  new Date(Date.parse(iso + "T12:00:00Z") + days * 86400_000).toISOString().slice(0, 10);

const MARK = "whg" + Date.now().toString(36);
const COMPANY = `WH Gate Verify ${MARK}`;
const PLACE = `Gate Store ${MARK}`;
const FILE_NO = `9WHG${String(Date.now()).slice(-8)}`;
const ARRIVAL = shift(eatToday(), -12);
const DAY_RATE = 25_000;
const FREE_DAYS = 3;

/** The register's list read, with every filter off — the shape the desk's own call sends. */
const listParams = (tid: string) =>
  [tid, null, null, null, null, null, null, 100, 0, null] as unknown[];

async function main() {
  const base = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  const pw = process.env.APP_DB_PASSWORD;
  if (!base || !pw) throw new Error("MIGRATE_DATABASE_URL and APP_DB_PASSWORD are both needed");
  const u = new URL(base);

  // The fixture rows go in first, on an operator connection, because a company, a seat and a cargo
  // file are not this register's to create and every statement under test needs them to exist.
  const owner = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
  await owner.connect();
  const T = uuidv7(), S1 = uuidv7(), U = uuidv7();
  const other = await owner.query(
    `select id from tenants where type not in ('platform','seeker') and deleted_at is null
       and id <> $1 limit 1`, [T]);
  const OTHER_TID = other.rows[0]?.id as string | undefined;

  await owner.query(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')`,
    [T, COMPANY]);
  try {
    await owner.query(`insert into users (id, tenant_id, user_type, email, status, full_name)
                        values ($1,$2,'staff',$3,'active','Gate Storekeeper')`,
      [U, T, `${MARK}@example.org`]);
    await owner.query(
      `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year, shipment_type,
          container_type, consignee_name, consignor_name, cargo_description, shipping_line,
          weight_tonnes, eta, stage, status, payment_status, payment_amount, processing_cost,
          notes, created_by, updated_by)
       values ($1,$2,$3,$4,2026,'import','40ft','Gate Consignee','Gate Consignor',
               'Bagged cement','Maersk East Africa',18.5,$5,'customs','open','unpaid',1000000,
               200000,$6,$7,$7)`,
      [S1, T, FILE_NO, 4_900_000 + (Date.now() % 90_000), shift(eatToday(), 2),
       `the gate probe's file ${MARK}`, U]);

    const ref = u.username.includes(".") ? u.username.slice(u.username.indexOf(".") + 1) : "";
    const c = new pg.Client({
      host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1),
      user: ref ? `app_runtime.${ref}` : "app_runtime",
      password: pw, ssl: { rejectUnauthorized: false }
    });
    await c.connect();

    // The role under test, on this table, right now. A BYPASSRLS role here would make every read
    // below prove nothing, so the session's own privileges are the first thing the gate checks.
    const who = await c.query(
      `select current_setting('is_superuser')::text as super,
              (select rolsuper::text from pg_roles where rolname = current_user) as role_super,
              (select rolbypassrls::text from pg_roles where rolname = current_user) as bypass,
              (select count(*)::int from pg_policies where schemaname='public'
                 and tablename='warehouse_stays') as stay_policies,
              relrowsecurity::text as stays_rls
         from pg_class where relname = 'warehouse_stays' and relnamespace = 'public'::regnamespace`);

    try {
      await c.query("begin");
      await c.query("select set_config('app.tenant_id', $1, true)", [T]);

      // A raw statement that raises aborts the whole transaction, so every refusal is probed inside
      // a savepoint and rolled back: the pass has to keep going to the last proof, and the throwaway
      // at the end has to be the only thing that clears the book.
      const refuse = async (label: string, re: RegExp, sql: string, p: unknown[] = []) => {
        await c.query("savepoint probe");
        let err = "";
        try { await c.query(sql, p); } catch (e: any) { err = String(e?.message ?? e); }
        await c.query("rollback to savepoint probe");
        check(label, re.test(err), err.slice(0, 200) || "no error raised");
      };
      const allow = async (label: string, sql: string, p: unknown[] = []) => {
        await c.query("savepoint probe_ok");
        let err = "";
        try { await c.query(sql, p); } catch (e: any) { err = String(e?.message ?? e); }
        await c.query("rollback to savepoint probe_ok");
        check(label, err === "", err.slice(0, 200) || "accepted");
      };

      // ---------- 0. the mark that lets the bookkeeper write ----------
      const leakedMark = await c.query(
        `select coalesce(current_setting('app.warehouse_booking', true), '') as mark`);
      check("a fresh connection carries no booking mark, so nobody inherits one from the pool",
        leakedMark.rows[0].mark === "", leakedMark.rows[0]);
      check("the register's table is protected by row level security, and this role is not above it",
        who.rows[0].stay_policies > 0 && who.rows[0].stays_rls === "true"
        && who.rows[0].super === "off" && who.rows[0].role_super === "false"
        && who.rows[0].bypass === "false", who.rows[0]);

      const clock = await c.query(STORE_CLOCK_SQL);
      check("the store's clock is the country's working day, and the desk reads the same one",
        clock.rows[0].today === eatToday(), clock.rows[0]);

      // ---------- 1. a hold opens empty, and priced from no day ----------
      const opened = await c.query(OPEN_INSERT_SQL,
        [uuidv7(), T, S1, PLACE, "Bagged cement", "bags", null, DAY_RATE, "TZS", FREE_DAYS,
         `the gate probe's hold ${MARK}`, U]);
      const H = opened.rows[0]?.id as string;
      check("the register's statement opens a hold and the trigger mints its number",
        opened.rowCount === 1 && /^WH-[0-9]{4}-[0-9]{5,}$/.test(String(opened.rows[0].ref))
        && opened.rows[0].status === "stored", opened.rows[0]);

      const detail = async (id: string = H) => {
        const r = await c.query(STAYS_SQL, [T, null, null, null, null, null, null, 1, 0, id]);
        return r.rows[0] ?? null;
      };
      const fresh = await detail();
      check("a hold that has received nothing is priced at no days and no money",
        n(fresh.quantity_in) === 0 && n(fresh.balance) === 0 && fresh.entered_on === null
        && n(fresh.days_held) === 0 && n(fresh.storage_charge) === 0 && n(fresh.docket_count) === 0,
        fresh && { q: fresh.quantity_in, d: fresh.days_held, c: fresh.storage_charge });
      check("the register read carries the file's own number and the day it priced against",
        fresh.file_number === FILE_NO && fresh.priced_on === eatToday(),
        fresh && [fresh.file_number, fresh.priced_on]);

      // The door's locked read and the desk's list read must be the same row, twice.
      const locked = await c.query(HOLD_LOCK_SQL, [H, T]);
      check("the act's locked read agrees with the register's own row",
        locked.rowCount === 1 && n(locked.rows[0].quantity_in) === n(fresh.quantity_in)
        && locked.rows[0].status === fresh.status, locked.rows[0]);

      // ---------- 2. figures typed onto the row are the register's refusal ----------
      // Probed inside a savepoint and rolled back: the row is written by the statement under test, so
      // leaving it in the book would silently add a hold to every count the later sections read.
      await c.query("savepoint typed_probe");
      const typed = await c.query(
        `insert into warehouse_stays
           (id, tenant_id, shipment_id, place, goods, unit, daily_rate, currency, free_days,
            opened_by, created_by, quantity_in, quantity_out, entered_on, exited_on,
            released_by, status)
         values ($1,$2,$3,$4,'Bagged cement','bags',1000,'TZS',0,$5,$5,500,500,$6,$6,$5,'released')
         returning quantity_in::float8 as quantity_in, quantity_out::float8 as quantity_out,
                   entered_on, exited_on, released_by, status`,
        [uuidv7(), T, S1, PLACE, U, ARRIVAL]);
      await c.query("rollback to savepoint typed_probe");
      check("a hold written with figures of its own arrives empty, with no dates and no releaser",
        n(typed.rows[0].quantity_in) === 0 && n(typed.rows[0].quantity_out) === 0
        && typed.rows[0].entered_on === null && typed.rows[0].exited_on === null
        && typed.rows[0].released_by === null, typed.rows[0]);
      check("a hold cannot be born released: the status is the dockets' conclusion",
        typed.rows[0].status === "stored", typed.rows[0].status);

      await refuse("a quantity typed onto a live hold is refused by the table, not only by the door",
        /not typed|conclusion/i,
        `update warehouse_stays set quantity_in = 500 where id = $1 and tenant_id = $2`, [H, T]);
      await refuse("a hand-written release is refused: no date, no releaser, no status",
        /not typed|conclusion/i,
        `update warehouse_stays set status = 'released', exited_on = $2
          where id = $1 and tenant_id = $3`, [H, eatToday(), T]);
      await allow("the header of a hold still in the store is the clerk's to change",
        `update warehouse_stays set notes = $2, updated_by = $3
          where id = $1 and tenant_id = $4`, [H, `retariffed ${MARK}`, U, T]);

      // ---------- 3. the dockets are what moves the figures ----------
      const entry = await c.query(DOCKET_INSERT_SQL,
        [uuidv7(), T, H, "entry", ARRIVAL, 100, `${MARK} delivery note`, null, U]);
      check("goods counted in file as an entry, and the docket numbers itself from its kind",
        entry.rowCount === 1 && /^WE-/.test(String(entry.rows[0].ref))
        && entry.rows[0].state === "filed", entry.rows[0]);

      const filled = await detail();
      check("the hold's figures are the docket's conclusion, written by the bookkeeping",
        n(filled.quantity_in) === 100 && filled.entered_on === ARRIVAL
        && n(filled.days_held) === 12 && n(filled.docket_count) === 1,
        filled && { in: filled.quantity_in, on: filled.entered_on, d: filled.days_held });
      const today = filled.priced_on;
      check("twelve days in the store, three of them free, priced at the tariff on the row",
        n(filled.charge_days) === 9 && n(filled.storage_charge) === 9 * DAY_RATE,
        filled && [filled.charge_days, filled.storage_charge]);
      const byHand = await c.query(
        `select public.warehouse_storage_charge($1::date, null, $2::int, $3::numeric,
                                                $4::date)::float8 as charge,
                public.warehouse_charge_days($1::date, null, $2::int, $4::date) as days`,
        [ARRIVAL, FREE_DAYS, DAY_RATE, today]);
      check("the register's money is the three functions of 118, and they are executable by this role",
        n(byHand.rows[0].charge) === n(filled.storage_charge)
        && n(byHand.rows[0].days) === n(filled.charge_days), byHand.rows[0]);

      const papers = await c.query(DOCKETS_SQL, [H, T]);
      check("the docket book names who filed it, so a disputed bill has a signature",
        papers.rowCount === 1 && papers.rows[0].kind === "entry"
        && !!papers.rows[0].filed_by_name, papers.rows[0]);

      await refuse("goods cannot leave a hold that has taken them in, if the day they arrived is after",
        /cannot leave|arrived/i,
        DOCKET_INSERT_SQL, [uuidv7(), T, H, "exit", shift(ARRIVAL, -1), 1, null, null, U]);
      await refuse("the store cannot let out more than it received, whoever files the paper",
        /cannot release|holds/i,
        DOCKET_INSERT_SQL, [uuidv7(), T, H, "exit", today, 500, null, null, U]);

      // ---------- 4. the same docket's words are not editable ----------
      const IN_ID = entry.rows[0].id as string;
      await refuse("a filed docket's quantity is not even an updatable column for this role",
        /permission denied|not rewritten/i,
        `update warehouse_slips set quantity = 1 where id = $1 and tenant_id = $2`, [IN_ID, T]);
      await refuse("nor is its note, its day or its number",
        /permission denied|not rewritten/i,
        `update warehouse_slips set note = 'changed' where id = $1 and tenant_id = $2`, [IN_ID, T]);
      await refuse("a void that names nobody is refused by the table",
        /who voided it and why/i,
        `update warehouse_slips set state = 'voided' where id = $1 and tenant_id = $2`, [IN_ID, T]);

      // ---------- 5. releasing the hold, and what freezes after it ----------
      const exit = await c.query(DOCKET_INSERT_SQL,
        [uuidv7(), T, H, "exit", shift(today, -1), 100, `${MARK} release note`, null, U]);
      const released = await c.query(HOLD_STATE_SQL, [H, T]);
      check("the last docket out empties the hold and the row says who let the goods out",
        exit.rowCount === 1 && /^WX-/.test(String(exit.rows[0].ref))
        && released.rows[0]?.status === "released"
        && released.rows[0]?.exited_on === shift(today, -1)
        && released.rows[0]?.released_by === U && !!released.rows[0]?.released_by_name,
        released.rows[0]);

      const closed = await detail();
      check("an emptied hold is priced on the day it closed, and never grows again",
        n(closed.days_held) === 11 && n(closed.charge_days) === 8
        && n(closed.storage_charge) === 8 * DAY_RATE,
        closed && [closed.days_held, closed.charge_days, closed.storage_charge]);

      await refuse("a hold that has been emptied does not have its tariff rewritten",
        /not rewritten/i, HOLD_EDIT_SQL,
        [H, T, PLACE, "Bagged cement", "bags", null, 40_000, "TZS", 0, null, U]);
      await refuse("and no new delivery is counted into it — its one arrival day would price the new goods short",
        /new hold|closed/i,
        DOCKET_INSERT_SQL, [uuidv7(), T, H, "entry", today, 10, null, null, U]);
      await refuse("a hold that received goods is emptied by an exit docket, not cancelled",
        /exit docket, not cancelled/i, HOLD_CANCEL_SQL, [H, T, `${MARK} wrong hold`, U]);

      // ---------- 6. voiding is the correction, and it is ordered ----------
      await refuse("the delivery cannot be un-filed while its goods are still out",
        /void those dockets first/i, SLIP_VOID_SQL, [IN_ID, T, U, `${MARK} mistake`]);
      const outPapers = await c.query(SLIP_HOLD_SQL, [exit.rows[0].id as string, T]);
      check("a void read knows the hold it hangs on, so the desk can say which one it moved",
        outPapers.rows[0]?.hold_ref === closed.ref && outPapers.rows[0]?.kind === "exit",
        outPapers.rows[0]);
      const unvoid = await c.query(SLIP_VOID_SQL,
        [exit.rows[0].id as string, T, U, `${MARK} the goods are still here`]);
      check("voiding the release takes the goods back into the store, with the reason on the paper",
        unvoid.rows[0]?.state === "voided" && String(unvoid.rows[0]?.void_reason) === `${MARK} the goods are still here`,
        unvoid.rows[0]);
      const back = await c.query(HOLD_BALANCE_SQL, [H, T]);
      check("and the hold goes back to stored under its own dates, priced from today again",
        back.rows[0]?.status === "stored" && n(back.rows[0]?.quantity_out) === 0
        && n(back.rows[0]?.quantity_in) === 100, back.rows[0]);
      const afterVoid = await detail();
      check("an un-released hold is charged from today, not from the day it was emptied",
        n(afterVoid.charge_days) === 12 - FREE_DAYS && afterVoid.exited_on === null,
        afterVoid && [afterVoid.days_held, afterVoid.charge_days, afterVoid.exited_on]);
      // The desk's own void statement cannot hit it twice (`where state = 'filed'` answers zero rows
      // and the trigger never runs), so the table's rule is proven with the words a buggy route would
      // send: the same paper, already voided, touched again.
      await refuse("a voided docket stays voided, and the correction is a new one",
        /stays voided/i,
        `update warehouse_slips set void_reason = $2 where id = $1 and tenant_id = $3`,
        [exit.rows[0].id as string, `${MARK} twice`, T]);
      const twice = await c.query(SLIP_VOID_SQL,
        [exit.rows[0].id as string, T, U, `${MARK} twice`]);
      check("and the desk's own statement only ever moves a filed docket, so a second void changes nothing",
        twice.rowCount === 0, twice.rowCount);

      // ---------- 7. a hold that never received goods is called off ----------
      const empty = await c.query(OPEN_INSERT_SQL,
        [uuidv7(), T, S1, PLACE, "Steel pipes", "pcs", null, 9_000, "TZS", 0,
         `the gate probe's called-off hold ${MARK}`, U]);
      const H2 = empty.rows[0].id as string;
      const cancelled = await c.query(HOLD_CANCEL_SQL, [H2, T, `${MARK} crate never arrived`, U]);
      check("an empty hold is called off with a reason, and the reason is on the row",
        cancelled.rowCount === 1 && cancelled.rows[0].status === "cancelled"
        && String(cancelled.rows[0].cancel_reason).includes(MARK), cancelled.rows[0]);
      await refuse("a hold that was called off takes no docket of any kind",
        /called off takes no dockets/i,
        DOCKET_INSERT_SQL, [uuidv7(), T, H2, "entry", today, 5, null, null, U]);
      await refuse("and its words are not rewritten afterwards either",
        /not rewritten/i, HOLD_EDIT_SQL,
        [H2, T, PLACE, "Steel pipes", "pcs", null, 12_000, "TZS", 0, null, U]);
      const cancelledTwice = await c.query(HOLD_CANCEL_SQL, [H2, T, `${MARK} again`, U]);
      check("nor is a called-off hold called off twice: the statement matches no row to change",
        cancelledTwice.rowCount === 0, cancelledTwice.rows[0]);

      // ---------- 8. the readers the desks are built on ----------
      const book = await c.query(STAYS_SQL, listParams(T));
      check("the register reads this company's holds, the stored ones first, and its own only",
        book.rowCount === 2 && book.rows[0].id === H && book.rows[1].id === H2,
        book.rows.map((r: any) => [r.ref, r.status]));
      const openBook = await c.query(STAYS_SQL,
        [T, ["stored"], null, null, null, null, null, 100, 0, null]);
      check("read open, the called-off hold leaves the shelf and the goods still standing stay",
        openBook.rowCount === 1 && openBook.rows[0].id === H,
        openBook.rows.map((r: any) => r.ref));
      const byPlace = await c.query(STAYS_SQL, [T, null, null, PLACE, null, null, null, 100, 0, null]);
      const byFile = await c.query(STAYS_SQL, [T, null, S1, null, null, null, null, 100, 0, null]);
      const fromDay = await c.query(STAYS_SQL,
        [T, null, null, null, shift(ARRIVAL, 1), null, null, 100, 0, null]);
      const toDay = await c.query(STAYS_SQL,
        [T, null, null, null, null, ARRIVAL, null, 100, 0, null]);
      const byWord = await c.query(STAYS_SQL,
        [T, null, null, null, null, null, FILE_NO, 100, 0, null]);
      check("the filters the desk offers each answer with the rows they should, all inside one company",
        byPlace.rowCount === 2 && byFile.rowCount === 2 && byWord.rowCount === 2,
        [byPlace.rowCount, byFile.rowCount, byWord.rowCount]);
      // Both edges, because an arrival window is the one filter a clerk uses to find what is costing
      // them money — and a hold with no arrival day must not appear in it.
      check("a day window has two edges, and a hold that received nothing has no arrival day to match",
        fromDay.rowCount === 0 && toDay.rowCount === 1 && toDay.rows[0].id === H,
        [fromDay.rowCount, toDay.rowCount, toDay.rows.map((r: any) => r.entered_on)]);

      const sums = await c.query(TOTALS_SQL, [T]);
      check("the summary counts the company's holds and holds only the goods still in the store",
        n(sums.rows[0].holds) === 2 && n(sums.rows[0].in_store) === 1
        && n(sums.rows[0].released) === 0 && n(sums.rows[0].cancelled) === 1
        && n(sums.rows[0].held_quantity) === 100, sums.rows[0]);
      const money = await c.query(BY_CURRENCY_SQL, [T]);
      const places = await c.query(BY_PLACE_SQL, [T]);
      const files = await c.query(BY_FILE_SQL, [T]);
      const picker = await c.query(FILES_SQL, [T, FILE_NO]);
      check("money is summed per currency, cancelled holds excepted, and the store lists its own place",
        money.rowCount === 1 && money.rows[0].currency === "TZS"
        && n(money.rows[0].charge) === 9 * DAY_RATE && places.rowCount === 1
        && n(places.rows[0].in_store) === 1, money.rows[0]);
      check("the costing list and the picker both read the file the holds belong to",
        files.rowCount === 1 && files.rows[0].file_number === FILE_NO
        && n(files.rows[0].holds) === 1 && picker.rowCount === 1
        && n(picker.rows[0].holds_in_store) === 1, files.rows[0]);

      // ---------- 9. the policies, not the bind, are the isolation ----------
      check("another company is on the platform, so the cross-tenant proofs are real",
        !!OTHER_TID, OTHER_TID ?? "no second tenant to point at");
      if (OTHER_TID) {
        const foreign = await c.query(STAYS_SQL, listParams(OTHER_TID));
        const foreignSums = await c.query(TOTALS_SQL, [OTHER_TID]);
        check("a statement that names another company's tenant answers empty, not with their rows",
          foreign.rowCount === 0 && n(foreignSums.rows[0].holds) === 0,
          [foreign.rowCount, foreignSums.rows[0]]);
        // Which guard answers is not the point — that no row lands is. Here the register's own
        // trigger speaks first: a docket carries the company it belongs to, so its hold lookup finds
        // nothing. The policy is proven below, on a row the trigger has no opinion about.
        await refuse("a docket written in another company's name never reaches a balance",
          /not in your register|row-level security|policy/i, DOCKET_INSERT_SQL,
          [uuidv7(), OTHER_TID, H, "entry", today, 1, null, null, U]);
        await refuse("and the policy itself is what stops a hold opened in their name",
          /row-level security|policy/i, OPEN_INSERT_SQL,
          [uuidv7(), OTHER_TID, S1, PLACE, "Bagged cement", "bags", null, DAY_RATE, "TZS", 0,
           `borrowed name ${MARK}`, U]);
      }
      // Pointed at a stranger's company, the same role with our ids in its binds: this is what a
      // forgotten `tenant_id` in a route would look like, and the policy is the only thing answering.
      await c.query("select set_config('app.tenant_id', $1, true)",
        [OTHER_TID ?? uuidv7()]);
      const stranger = await c.query(STAYS_SQL, listParams(T));
      await refuse("and it cannot open a hold in our name even with our ids in the binds",
        /row-level security|policy/i, OPEN_INSERT_SQL,
        [uuidv7(), T, S1, PLACE, "Bagged cement", "bags", null, DAY_RATE, "TZS", 0,
         `cross-tenant attempt ${MARK}`, U]);
      check("a session pointed at a stranger's company reads none of our register",
        stranger.rowCount === 0, stranger.rowCount);
      await c.query("select set_config('app.tenant_id', $1, true)", [T]);

      // ---------- 10. what this role cannot do to the register at all ----------
      await refuse("a hold cannot be deleted out of the book — it is taken off by an exit or a cancellation",
        /permission denied/i, `delete from warehouse_stays where id = $1`, [H]);
      await refuse("nor can a docket be torn out",
        /permission denied/i, `delete from warehouse_slips where id = $1`, [IN_ID]);
      await refuse("the register's own rules are not this role's to change",
        /permission denied|must be owner/i,
        `alter table warehouse_stays disable row level security`);
      await refuse("and a trigger cannot be dropped from under the money",
        /permission denied|must be owner/i,
        `drop trigger trg_warehouse_stay_shape on warehouse_stays`);
      const privs = await c.query(
        `select has_function_privilege('public', 'public.warehouse_stay_shape()', 'execute')::text
                                                            as shape_by_public,
                has_function_privilege('anon', 'public.warehouse_storage_charge(date,date,int,numeric,date)',
                                       'execute')::text  as charge_by_anon,
                has_table_privilege('app_runtime', 'warehouse_stays', 'delete')::text as may_delete`);
      check("the register's triggers and arithmetic are not open to PUBLIC or to anon",
        privs.rows[0].shape_by_public === "false" && privs.rows[0].charge_by_anon === "false"
        && privs.rows[0].may_delete === "false", privs.rows[0]);

      throw new Error("gate done");
    } catch (done: any) {
      if (String(done?.message) !== "gate done") throw done;
      await c.query("rollback");
    }

    // ---------- residue: the transaction really was thrown away ----------
    const residue = await owner.query(
      `select (select count(*)::int from warehouse_stays where tenant_id = $1) as holds,
              (select count(*)::int from warehouse_slips
                where docket_ref like $2 or note like $2) as dockets,
              (select count(*)::int from audit_logs where entity = 'warehouse_stays'
                 and after::text like $2) as audit_lines`, [T, `%${MARK}%`]);
    check("the whole pass left no hold, no docket and no audit line behind it",
      n(residue.rows[0].holds) === 0 && n(residue.rows[0].dockets) === 0
      && n(residue.rows[0].audit_lines) === 0, residue.rows[0]);
    const stillThere = await owner.query(
      `select (count(*)::int) as files from cargo_shipments where tenant_id = $1`, [T]);
    check("and the fixture's cargo file was not written to either",
      n(stillThere.rows[0].files) === 1, stillThere.rows[0]);

    await c.end();
  } finally {
    await owner.query(`delete from warehouse_slips where tenant_id = $1`, [T]);
    await owner.query(`delete from warehouse_stays where tenant_id = $1`, [T]);
    await owner.query(`delete from documents where tenant_id = $1 and entity_type = 'warehouse_stay'`, [T]);
    await owner.query(`delete from audit_logs where tenant_id = $1`, [T]).catch(() => {});
    await owner.query(`delete from cargo_shipments where tenant_id = $1`, [T]);
    await owner.query(`delete from users where tenant_id = $1`, [T]);
    await owner.query(`delete from tenants where id = $1`, [T]);
    await owner.end();
  }

  console.log(`\n${checks - failures}/${checks} warehouse register proofs pass`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error("gate crashed:", e); process.exitCode = 1; });
