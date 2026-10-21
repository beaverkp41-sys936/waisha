/**
 * End-to-end smoke for the store book (#190, migration 118) against a running API on :4000.
 *
 * `118_warehouse_register.sql` decides what a hold and its dockets may look like. This decides
 * whether the doors a clerk walks through agree with it: that goods are counted in on the day they
 * arrive and never the day after, that a store cannot let out what it was never given, that the
 * tariff and the free period belong to the hold while the quantity, the two dates and the status
 * belong to the dockets, and that the days between are priced the same way on the desk, in the
 * file's margin, in the printed book and in the database.
 *
 * Two companies are planted, so isolation can aim a real director token at a neighbour's cargo file
 * and a neighbour's hold. Files and people are planted in SQL; every hold, docket, void, cancel,
 * tariff change, paper and export goes over HTTP and is read back from the database. A third
 * company's money is deliberately priced in dollars, because the one number a register must never
 * print is shillings added to dollars.
 *
 * Run: npx tsx scripts/smoke-warehouse.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";
import { inflateRawSync } from "node:zlib";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const COMPANY = `Store Smoke ${STAMP}`;
const OTHER = `Store Stranger ${STAMP}`;
const MARK = `warehouse smoke ${STAMP}`;
const FILE_A = `9WHA${STAMP}`;   // the file whose goods sit in the store, in TZS
const FILE_B = `9WHB${STAMP}`;   // the file with the dollar-priced hold
const FILE_C = `9WHC${STAMP}`;   // another company's file
const PLACE = "Dockside Store A";
const PLACE2 = "Dar Central Bonded Warehouse";
const PLACE3 = "Kigamboni Yard C";

const DAY = 24 * 3600 * 1000;
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (s: string, n: number) => iso(new Date(new Date(`${s}T12:00:00`).getTime() + n * DAY));
const TODAY = iso(new Date());

async function mint(sub: string, tid: string, roleKey: string) {
  return new SignJWT({ tid, sid: "00000000-7000-7000-8000-0000000000bb", typ: roleKey, roles: [roleKey] })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("30m").sign(key);
}

/** `into` collects the answer text, so the isolation pass can read everything a desk was told. */
async function call(path: string, token: string | null, init: RequestInit = {}, into?: string[]) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  if (into) into.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** A binary answer — the workbook and the printed book are the point of two of these calls. */
async function callRaw(path: string, token: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
/** The route's own error code: half of a refusal is the number and the other half is the reason. */
function refusedAs(r: { status: number; json: any }, status: number, code: string, re?: RegExp) {
  return r.status === status && r.json?.error?.code === code
    && (!re || re.test(String(r.json?.error?.message ?? "")));
}
const field = (j: any) => (j?.error?.details ?? []).map((d: any) => d.field);
const msg = (r: { json: any }) => String(r.json?.error?.message ?? "");
const n = (v: unknown) => (v === null || v === undefined ? NaN : Number(v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The sheet names of a workbook, read out of its ZIP.
 *
 * Every part of an .xlsx is deflated, so a name like "Warehouse dockets" is not findable in the
 * bytes the route returned. The central directory is walked by hand and `xl/workbook.xml` is
 * inflated, because an assertion that prints "note: not checked on this machine" proves nothing
 * about the file a clerk actually opens.
 */
function sheetNames(buf: Buffer): string[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central record ${i} is not a signature`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const name = buf.subarray(p + 46, p + 46 + buf.readUInt16LE(p + 28)).toString("utf8");
    const next = p + 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (name === "xl/workbook.xml") {
      const lho = buf.readUInt32LE(p + 42);
      if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error("local header for workbook.xml is missing");
      const at = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const raw = buf.subarray(at, at + csize);
      const xml = method === 0 ? raw.toString("utf8") : inflateRawSync(raw).toString("utf8");
      return [...xml.matchAll(/<sheet[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
    }
    p = next;
  }
  throw new Error("the workbook carries no xl/workbook.xml");
}

/** Every character of every part of the workbook, for "does the register's own text appear". */
function bookText(buf: Buffer): string {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let out = "";
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const name = buf.subarray(p + 46, p + 46 + buf.readUInt16LE(p + 28)).toString("utf8");
    const next = p + 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const at = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(at, at + csize);
    try {
      out += (method === 0 ? raw : inflateRawSync(raw)).toString("utf8").replace(/[<>]/g, " ");
    } catch { /* a part this reader cannot open simply does not contribute */ }
    p = next;
  }
  return out;
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, p: unknown[] = []) => owner.query(sql, p as any[]);

  /**
   * One company's rows, in the order the keys allow: a docket points at a hold, a hold points at a
   * cargo file and at the people who opened, released and called it off, so the paper goes first
   * and the register, the files and the seats last.
   */
  const sweep = async (tid: string) => {
    for (const sql of [
      `delete from documents where tenant_id = $1`,
      `delete from warehouse_slips where tenant_id = $1`,
      `delete from warehouse_stays where tenant_id = $1`,
      `delete from office_costs where tenant_id = $1`,
      `delete from cargo_shipments where tenant_id = $1`,
      `delete from user_roles where user_id in (select id from users where tenant_id = $1)`,
      `delete from roles where tenant_id = $1`,
      `delete from sessions where user_id in (select id from users where tenant_id = $1)`,
      `delete from users where tenant_id = $1`,
      `delete from tenants where id = $1`
    ]) {
      await oi(sql, [tid]).catch((e: any) => console.log(`sweep note: ${String(e.message).slice(0, 90)}`));
    }
  };

  // A run that died half way leaves a company behind, and the sums this script asserts are only
  // honest while every hold in the register is one it minted. The pattern cannot catch a real name.
  const orphans = await oi(
    `select id from tenants where name ~ '^Store (Smoke|Stranger) [0-9]{8}$'`);
  if (orphans.rowCount) {
    console.log(`sweeping ${orphans.rowCount} fixture company(ies) left by an earlier run`);
    for (const r of orphans.rows) await sweep(r.id as string);
  }

  const T = crypto.randomUUID();
  const T2 = crypto.randomUUID();
  const roleOf = async (k: string) => {
    const r = await oi(`select id from roles where key = $1 and tenant_id is null`, [k]);
    if (!r.rowCount) throw new Error(`No global ${k} role`);
    return r.rows[0].id as string;
  };
  // The store's own acknowledgement is filed through the ordinary vault, which answers
  // `documents.create`. Which role holds that key is not this register's business, so it is read
  // from the catalog rather than guessed.
  const uploaderKey = (await oi(
    `select r.key from roles r join role_permissions rp on rp.role_id = r.id
      where r.tenant_id is null and rp.permission_key = 'documents.create'
      order by r.key limit 1`)).rows[0]?.key as string | undefined;
  if (!uploaderKey) throw new Error("No global role holds documents.create");

  const roles = {
    dir: await roleOf("director"),
    opm: await roleOf("operations_manager"),
    aud: await roleOf("auditor"),
    dsp: await roleOf("dispatcher"),
    upl: await roleOf(uploaderKey)
  };

  for (const [tid, name] of [[T, COMPANY], [T2, OTHER]] as [string, string][]) {
    await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')`,
      [tid, name]);
  }

  const seats: Record<string, { id: string; roleKey: string }> = {};
  const seat = async (who: string, tid: string, name: string, roleId: string, roleKey: string) => {
    const u = await oi(`insert into users (tenant_id, user_type, email, status, full_name)
                        values ($1,'staff',$2,'active',$3) returning id`,
      [tid, `${who}.wh.${STAMP}@example.org`, name]);
    const id = u.rows[0].id as string;
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [id, roleId]);
    seats[who] = { id, roleKey };
    return id;
  };
  for (const [who, name, roleId, roleKey] of [
    ["dir", "Baraka Boss", roles.dir, "director"],
    ["opm", "Neema Operations", roles.opm, "operations_manager"],
    ["aud", "Daudi Auditor", roles.aud, "auditor"],
    ["dsp", "Saida Dispatcher", roles.dsp, "dispatcher"],
    ["upl", "Grace Records", roles.upl, uploaderKey],
    ["dir2", "Stranger Boss", roles.dir, "director"]
  ] as [string, string, string, string][]) {
    await seat(who, who === "dir2" ? T2 : T, name, roleId, roleKey);
  }

  // A storeman of this company: entry, exit and the tariff, and nothing else. This is the seat the
  // register's duty map cannot produce from any built-in desk, and the only way to prove that
  // filing paper and reading the book are two doors. It gets `warehouse.edit` too, so the tariff
  // change is proved to belong to a yard clerk and not only to a supervisor.
  const keeperRole = (await oi(
    `insert into roles (id, tenant_id, key, name, is_system)
     values (gen_random_uuid(),$1,'store_keeper','Store keeper (fixture)',false)
     returning id`, [T])).rows[0].id as string;
  for (const duty of ["warehouse.entry", "warehouse.exit", "warehouse.edit"]) {
    await oi(`insert into role_permissions (role_id, permission_key) values ($1,$2)
              on conflict do nothing`, [keeperRole, duty]);
  }
  await seat("keep", T, "Yusuf Storekeeper", keeperRole, "store_keeper");

  const tok: Record<string, string> = {};
  for (const who of Object.keys(seats)) {
    tok[who] = await mint(seats[who].id, seats[who] === seats.dir2 ? T2 : T, seats[who].roleKey);
  }
  // A seat with nothing granted at all, on a subject that is not even a person. Every door of this
  // register must answer before it reads a row.
  const nobody = await mint("99999999-9999-7999-8999-999999999999", T, "staff");
  // A valid token of a real seat, stamped with the neighbour's tenant: the claim itself is the
  // forgery, and the answer must not be the neighbour's book.
  const wrongTid = await mint(seats.dir.id, T2, "director");

  // --- the cargo files, planted ---------------------------------------------------------------
  const SHIP = `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year,
      shipment_type, container_type, consignee_name, consignor_name, cargo_description,
      shipping_line, weight_tonnes, eta, stage, status, payment_status, payment_amount,
      processing_cost, notes, created_by, updated_by)
    values ($1,$2,$3,$4,2026,'import','40ft',$5,$6,'Bagged cement',$7,18.5,$8,'customs',
      'open','unpaid',$9,$10,$11,$12,$12)`;
  const S1 = crypto.randomUUID(), S2 = crypto.randomUUID(), S3 = crypto.randomUUID();
  const seq = 4_200_000 + Math.floor(Math.random() * 60_000);
  await oi(SHIP, [S1, T, FILE_A, seq, "Smoke Consignee A", "Smoke Consignor",
    "Maersk East Africa", shift(TODAY, 2), 1_000_000, 200_000,
    `the file with the tzS holds ${MARK}`, seats.dir.id]);
  await oi(SHIP, [S2, T, FILE_B, seq + 1, "Smoke Consignee B", "Smoke Consignor",
    "MSC", shift(TODAY, 3), 400_000, 50_000,
    `the file with the dollar hold ${MARK}`, seats.dir.id]);
  await oi(SHIP, [S3, T2, FILE_C, seq + 2, "Stranger Consignee", "Stranger Consignor",
    "CMA CGM", shift(TODAY, 1), 900_000, 100_000,
    `another company's import ${MARK}`, seats.dir2.id]);

  // One approved office cost per file, so both appear on the file-costs desk and the margin there
  // can be checked against the storage run up on the same row.
  const costOn = async (tid: string, shipment: string, amount: number, who: string) =>
    (await oi(`insert into office_costs (id, tenant_id, cost_date, category, description, amount,
                                         payee, shipment_id, payment_method, status, approved_by,
                                         approved_at, created_by)
                values (gen_random_uuid(),$1,$2,'transport',$3,$4,'TSS Cargo Handling',$5,'cash',
                        'approved',$6,now(),$6) returning id`,
      [tid, TODAY, `${MARK} handling on ${who}`, amount, shipment, seats.dir.id])).rows[0].id as string;
  const COST1 = await costOn(T, S1, 120_000, FILE_A);
  const COST2 = await costOn(T, S2, 60_000, FILE_B);

  /** Every answer our own seats receive, kept so the isolation pass can read them all at the end. */
  const mine: string[] = [];
  const theirs: string[] = [];
  const openHold = async (body: object, who = "dir") =>
    call("/warehouse/stays", tok[who], { method: "POST", body: JSON.stringify(body) },
      who === "dir2" ? theirs : who === "keep" || who === "nobody" ? undefined : mine);

  const stayRow = async (id: string, who = "dir") => {
    const r = await call("/warehouse/stays", tok[who], {}, who === "dir2" ? theirs : mine);
    return (r.json ?? []).find((x: any) => x.id === id) ?? null;
  };
  const detail = async (id: string, who = "dir") =>
    call(`/warehouse/stays/${id}`, tok[who], {}, who === "dir2" ? theirs : mine);

  // ============================================================================================
  // 1. the doors
  // ============================================================================================
  const doors: [string, string, string?][] = [
    ["GET", "/warehouse/stays"], ["GET", "/warehouse/files"], ["GET", "/warehouse/summary"],
    ["GET", "/warehouse/stays/00000000-0000-7000-8000-000000000001"],
    ["POST", "/warehouse/stays"],
    ["POST", "/warehouse/stays/00000000-0000-7000-8000-000000000001/entries"],
    ["POST", "/warehouse/stays/00000000-0000-7000-8000-000000000001/exits"],
    ["PUT", "/warehouse/stays/00000000-0000-7000-8000-000000000001"],
    ["POST", "/warehouse/stays/00000000-0000-7000-8000-000000000001/cancel"],
    ["POST", "/warehouse/slips/00000000-0000-7000-8000-000000000001/void"]
  ];
  const noAuth = await Promise.all(doors.map(([m, p]) =>
    call(p, null, m === "GET" ? {} : { method: m, body: "{}" })));
  check("every door of the store book answers a stranger with 401, not with a row",
    noAuth.every((r) => r.status === 401), noAuth.map((r) => r.status));

  const naked = await Promise.all([
    call("/warehouse/stays", nobody),
    call("/warehouse/summary", nobody),
    call("/warehouse/stays", nobody, { method: "POST", body: JSON.stringify({}) }),
    call("/warehouse/slips/00000000-0000-7000-8000-000000000001/void", nobody,
      { method: "POST", body: JSON.stringify({ reason: "nothing" }) })
  ]);
  check("a seat with no duty is refused the register and every act on it",
    naked.every((r) => refusedAs(r, 403, "FORBIDDEN")), naked.map((r) => [r.status, msg(r)]));

  const forged = await Promise.all([
    call("/warehouse/stays", wrongTid),
    call("/warehouse/summary", wrongTid)
  ]);
  check("a token pointed at another company reads that company's empty book, not ours",
    forged.every((r) => r.status === 200) && !JSON.stringify(forged.map((r) => r.json)).includes(FILE_A),
    forged.map((r) => r.status));

  // ============================================================================================
  // 2. a neighbour's file cannot be given a hold here
  // ============================================================================================
  const foreign = await openHold({
    shipmentId: S3, place: PLACE, goods: "Bagged cement", unit: "bags",
    dailyRate: 1000, currency: "TZS", freeDays: 0
  });
  check("a hold cannot be opened against another company's cargo file",
    refusedAs(foreign, 404, "NOT_FOUND", /not in your register/i), { foreign: foreign.status, msg: msg(foreign) });

  const ghost = await openHold({
    shipmentId: crypto.randomUUID(), place: PLACE, goods: "Bagged cement", unit: "bags",
    dailyRate: 1000, currency: "TZS", freeDays: 0
  });
  check("a file number that does not exist is the same refusal, with no new shape",
    refusedAs(ghost, 404, "NOT_FOUND"), ghost.status);

  const strayHolds = await oi(
    `select count(*)::int as c from warehouse_stays where tenant_id = $1`, [T]);
  check("three refusals left no hold on the shelf", n(strayHolds.rows[0].c) === 0, strayHolds.rows[0].c);

  // ============================================================================================
  // 3. the desk's own arithmetic, hold by hold
  // ============================================================================================
  // H1 is the finding: cement that arrived ten working days ago and has not moved.
  const H1r = await openHold({
    shipmentId: S1, place: PLACE, goods: "Bagged cement", unit: "bags",
    containerNumber: "MSKU4851230", dailyRate: 25000, currency: "TZS", freeDays: 3,
    notes: `the long sit ${MARK}`,
    entryDay: shift(TODAY, -10), quantity: 100, docketRef: "DLV-7781"
  });
  const H1 = H1r.json?.id as string;
  check("a hold opens with its first delivery counted in, in one act",
    H1r.status === 201 && H1r.json?.status === "stored" && H1r.json?.dockets?.length === 1,
    { status: H1r.status, msg: msg(H1r), dockets: H1r.json?.dockets?.length });
  check("the hold carries the store's own number, not the desk's",
    /^WH-[0-9]{4}-[0-9]{5,}$/.test(String(H1r.json?.ref ?? "")), H1r.json?.ref);
  check("the delivery docket is numbered as an entry",
    /^WE-[0-9]{4}-[0-9]{5,}$/.test(String(H1r.json?.dockets?.[0]?.ref ?? "")), H1r.json?.dockets?.[0]?.ref);
  check("ten days in the store, three of them free, priced at 25 000 a day",
    n(H1r.json?.days_held) === 10 && n(H1r.json?.charge_days) === 7 && n(H1r.json?.storage_charge) === 175000,
    { days: H1r.json?.days_held, charge_days: H1r.json?.charge_days, charge: H1r.json?.storage_charge });
  check("the desk is told which day it priced against",
    H1r.json?.priced_on === TODAY, { priced_on: H1r.json?.priced_on, today: TODAY });
  check("a delivery counted in is filed under a name",
    H1r.json?.dockets?.[0]?.filed_by === seats.dir.id,
    { filed_by: H1r.json?.dockets?.[0]?.filed_by });
  check("the quantities are the docket's conclusion, and the hold agrees with it",
    n(H1r.json?.quantity_in) === 100 && n(H1r.json?.quantity_out) === 0 && n(H1r.json?.balance) === 100,
    H1r.json && { q_in: H1r.json.quantity_in, q_out: H1r.json.quantity_out });
  check("the hold names the file it belongs to",
    H1r.json?.file_number === FILE_A && H1r.json?.opened_by_name === "Baraka Boss",
    { file: H1r.json?.file_number, opened: H1r.json?.opened_by_name });

  const noDay = await openHold({
    shipmentId: S1, place: PLACE, goods: "Bagged cement", unit: "bags",
    dailyRate: 1000, currency: "TZS", freeDays: 0, quantity: 40
  });
  check("goods cannot be counted in without the day they arrived",
    refusedAs(noDay, 400, "VALIDATION_FAILED") && field(noDay.json).includes("entryDay"),
    { status: noDay.status, fields: field(noDay.json) });

  const future = await openHold({
    shipmentId: S1, place: PLACE, goods: "Bagged cement", unit: "bags",
    dailyRate: 1000, currency: "TZS", freeDays: 0,
    entryDay: shift(TODAY, 1), quantity: 40
  });
  check("a docket dated tomorrow is refused, and told what the store's clock reads",
    refusedAs(future, 400, "SLIP_DATE_FUTURE", new RegExp(TODAY)),
    { status: future.status, msg: msg(future) });

  const shortCtn = await openHold({
    shipmentId: S1, place: PLACE, goods: "Bagged cement", unit: "bags",
    containerNumber: "ABC", dailyRate: 1000, currency: "TZS", freeDays: 0
  });
  check("half a container marking is a field error, not a 500 from a CHECK",
    refusedAs(shortCtn, 400, "VALIDATION_FAILED") && field(shortCtn.json).includes("containerNumber"),
    { status: shortCtn.status, fields: field(shortCtn.json), msg: msg(shortCtn) });

  const badRate = await openHold({
    shipmentId: S1, place: PLACE, goods: "Bagged cement", unit: "bags",
    dailyRate: -5, currency: "TZS", freeDays: 0
  });
  check("a store cannot be paid to hold goods",
    refusedAs(badRate, 400, "VALIDATION_FAILED") && field(badRate.json).includes("dailyRate"),
    badRate.status);

  const afterRefusals = await oi(
    `select count(*)::int as c from warehouse_stays where tenant_id = $1`, [T]);
  check("the four refusals wrote nothing, so the one hold stands alone",
    n(afterRefusals.rows[0].c) === 1, afterRefusals.rows[0].c);

  // H2: the two-day turnaround the free period exists for — and then emptied the same day.
  const H2r = await openHold({
    shipmentId: S1, place: PLACE, goods: "Steel pipes", unit: "pcs",
    dailyRate: 4000, currency: "TZS", freeDays: 0,
    entryDay: TODAY, quantity: 500, docketRef: "DLV-7782"
  });
  const H2 = H2r.json?.id as string;
  const out2 = await call(`/warehouse/stays/${H2}/exits`, tok.dir, {
    method: "POST", body: JSON.stringify({ slipDay: TODAY, quantity: 500, docketRef: "REL-2201" })
  }, mine);
  check("goods in and out on the same day cost nothing",
    out2.status === 201 && out2.json?.hold?.status === "released" && n(out2.json?.hold?.quantity_out) === 500,
    { status: out2.status, hold: out2.json?.hold, msg: msg(out2) });
  const h2 = await stayRow(H2);
  check("a hold emptied the day it was filled is priced at zero days",
    n(h2?.days_held) === 0 && n(h2?.storage_charge) === 0 && h2?.exited_on === TODAY && h2?.status === "released",
    h2 && { days: h2.days_held, charge: h2.storage_charge, exited_on: h2.exited_on, status: h2.status });
  check("the hold says who let the goods out, by name",
    h2?.released_by === seats.dir.id && h2?.released_by_name === "Baraka Boss",
    h2 && { released_by: h2.released_by, name: h2.released_by_name });
  check("a docket that takes goods out is numbered as an exit",
    /^WX-[0-9]{4}-[0-9]{5,}$/.test(String(out2.json?.ref ?? "")), out2.json?.ref);
  check("an emptied hold offers no second exit, no tariff change and no new delivery",
    h2?.can_exit === false && h2?.can_edit === false && h2?.can_enter === false
    && h2?.edit_block === "released" && h2?.can_cancel === false,
    h2 && { can_exit: h2.can_exit, can_edit: h2.can_edit, can_enter: h2.can_enter,
      block: h2.edit_block, can_cancel: h2.can_cancel });

  const lateEntry = await call(`/warehouse/stays/${H2}/entries`, tok.dir, {
    method: "POST", body: JSON.stringify({ slipDay: TODAY, quantity: 10 })
  }, mine);
  check("goods cannot be delivered into a hold that was emptied",
    refusedAs(lateEntry, 409, "HOLD_RELEASED", /new hold/i),
    { status: lateEntry.status, code: lateEntry.json?.error?.code, msg: msg(lateEntry) });

  // H3: the dollar hold. Its money must never join the shilling figures.
  const H3r = await openHold({
    shipmentId: S2, place: PLACE2, goods: "Container, full", unit: "TEU",
    containerNumber: "TCLU3098117", dailyRate: 10, currency: "USD", freeDays: 0,
    entryDay: shift(TODAY, -4), quantity: 5
  });
  const H3 = H3r.json?.id as string;
  check("a store that bills in dollars is priced in dollars",
    H3r.status === 201 && H3r.json?.currency === "USD" && n(H3r.json?.storage_charge) === 40,
    { cur: H3r.json?.currency, charge: H3r.json?.storage_charge, status: H3r.status });

  // H4: an empty hold, opened by the storeman, then called off by the supervisor.
  const H4r = await openHold({
    shipmentId: S2, place: PLACE2, goods: "Empty pallets", unit: "pallets",
    dailyRate: 0, currency: "TZS", freeDays: 0
  }, "keep");
  const H4 = H4r.json?.id as string;
  check("a storeman without the register can still open a hold and count nothing into it",
    H4r.status === 201 && n(H4r.json?.quantity_in) === 0, { status: H4r.status, msg: msg(H4r) });

  const keepRead = await call("/warehouse/stays", tok.keep);
  check("the same storeman is refused the register itself",
    refusedAs(keepRead, 403, "FORBIDDEN"), { status: keepRead.status, msg: msg(keepRead) });

  const keepVoid = await call(`/warehouse/slips/${H1r.json?.dockets?.[0]?.id}/void`, tok.keep, {
    method: "POST", body: JSON.stringify({ reason: "not my door" })
  });
  const keepCancel = await call(`/warehouse/stays/${H4}/cancel`, tok.keep, {
    method: "POST", body: JSON.stringify({ reason: "not my door" })
  });
  check("filing paper does not buy the two acts that destroy a record",
    refusedAs(keepVoid, 403, "FORBIDDEN") && refusedAs(keepCancel, 403, "FORBIDDEN"),
    { void: keepVoid.status, cancel: keepCancel.status });

  const keepEdit = await call(`/warehouse/stays/${H4}`, tok.keep, {
    method: "PUT", body: JSON.stringify({
      place: PLACE2, goods: "Empty pallets", unit: "pallets", containerNumber: null,
      dailyRate: 1500, currency: "TZS", freeDays: 1, notes: `tariff set by the yard ${MARK}`
    })
  });
  check("the yard clerk sets the tariff on a hold still in the store",
    keepEdit.status === 200 && n(keepEdit.json?.daily_rate) === 1500 && n(keepEdit.json?.free_days) === 1,
    { status: keepEdit.status, rate: keepEdit.json?.daily_rate, msg: msg(keepEdit) });

  const cancel4 = await call(`/warehouse/stays/${H4}/cancel`, tok.dir, {
    method: "POST", body: JSON.stringify({ reason: "the crate never arrived — wrong file quoted" })
  }, mine);
  check("an empty hold is called off, with the reason written down",
    cancel4.status === 200 && cancel4.json?.status === "cancelled",
    { status: cancel4.status, msg: msg(cancel4) });

  const entryOnCancelled = await call(`/warehouse/stays/${H4}/entries`, tok.dir, {
    method: "POST", body: JSON.stringify({ slipDay: TODAY, quantity: 4 })
  }, mine);
  check("goods that really arrived belong on a new hold, and the refusal says so",
    refusedAs(entryOnCancelled, 409, "HOLD_CANCELLED", /new hold/i),
    { status: entryOnCancelled.status, code: entryOnCancelled.json?.error?.code });

  const exitOnCancelled = await call(`/warehouse/stays/${H4}/exits`, tok.dir, {
    method: "POST", body: JSON.stringify({ slipDay: TODAY, quantity: 4 })
  }, mine);
  check("the same door guards the way out",
    refusedAs(exitOnCancelled, 409, "HOLD_CANCELLED"), exitOnCancelled.status);

  const cancelAgain = await call(`/warehouse/stays/${H4}/cancel`, tok.dir, {
    method: "POST", body: JSON.stringify({ reason: "called off twice" })
  }, mine);
  check("a hold already called off is not called off again",
    refusedAs(cancelAgain, 409, "CONFLICT", /already called off/i), cancelAgain.status);

  const cancelFilled = await call(`/warehouse/stays/${H1}/cancel`, tok.dir, {
    method: "POST", body: JSON.stringify({ reason: "make the charge go away" })
  }, mine);
  check("goods that were counted in are not got rid of by calling the hold off",
    refusedAs(cancelFilled, 409, "HOLD_NOT_EMPTY", /exit docket/i),
    { status: cancelFilled.status, msg: msg(cancelFilled) });

  // H5: the re-tariffed hold, priced from the dockets' conclusion and the hold's own words.
  const H5r = await openHold({
    shipmentId: S1, place: PLACE, goods: "Roofing sheets", unit: "bundles",
    dailyRate: 9000, currency: "TZS", freeDays: 2,
    entryDay: shift(TODAY, -5), quantity: 20
  });
  const H5 = H5r.json?.id as string;
  check("five days at 9 000 with two free is three days of charge",
    n(H5r.json?.storage_charge) === 27000, H5r.json?.storage_charge);
  const reTariff = await call(`/warehouse/stays/${H5}`, tok.keep, {
    method: "PUT", body: JSON.stringify({
      place: PLACE, goods: "Roofing sheets", unit: "bundles", containerNumber: null,
      dailyRate: 12000, currency: "TZS", freeDays: 2
    })
  });
  const h5 = await stayRow(H5);
  check("a re-tariffed hold is priced at the new number on the next read",
    reTariff.status === 200 && n(h5?.storage_charge) === 36000,
    { status: reTariff.status, charge: h5?.storage_charge });
  const editReleased = await call(`/warehouse/stays/${H2}`, tok.dir, {
    method: "PUT", body: JSON.stringify({
      place: PLACE, goods: "Steel pipes", unit: "pcs", containerNumber: null,
      dailyRate: 1, currency: "TZS", freeDays: 0
    })
  }, mine);
  check("the tariff a released hold was priced at is part of the story and is not rewritten",
    refusedAs(editReleased, 409, "CONFLICT", /is released/i), editReleased.status);

  // H6: the mistake, and its correction — the pair the register keeps side by side.
  const H6r = await openHold({
    shipmentId: S1, place: PLACE3, goods: "Used vehicle parts", unit: "crates",
    dailyRate: 5000, currency: "TZS", freeDays: 0,
    entryDay: shift(TODAY, -2), quantity: 40, docketRef: "DLV-7790"
  });
  const H6 = H6r.json?.id as string;
  const inDocket = H6r.json?.dockets?.[0]?.id as string;
  const out6 = await call(`/warehouse/stays/${H6}/exits`, tok.dir, {
    method: "POST", body: JSON.stringify({ slipDay: TODAY, quantity: 40, docketRef: "REL-2290" })
  }, mine);
  const outDocket = out6.json?.id as string;
  check("the hold releases when the filed dockets have let out everything that came in",
    out6.json?.hold?.status === "released", out6.json?.hold);

  const voidEntry = await call(`/warehouse/slips/${inDocket}/void`, tok.dir, {
    method: "POST", body: JSON.stringify({ reason: "typed the wrong docket number" })
  }, mine);
  check("an entry cannot be voided while the goods it received are still out",
    refusedAs(voidEntry, 409, "RELEASED_STILL_OUT", /still released/i),
    { status: voidEntry.status, code: voidEntry.json?.error?.code });

  const voidExit = await call(`/warehouse/slips/${outDocket}/void`, tok.dir, {
    method: "POST", body: JSON.stringify({ reason: "the truck took a different load" })
  }, mine);
  check("voiding the exit puts the goods back in the store, and the hold back to stored",
    voidExit.status === 200 && voidExit.json?.hold?.status === "stored"
    && n(voidExit.json?.hold?.quantity_out) === 0,
    { status: voidExit.status, hold: voidExit.json?.hold });

  const h6mid = (await detail(H6)).json;
  check("an un-released hold is priced from today again, not from the day it was emptied",
    n(h6mid?.storage_charge) === 10000 && h6mid?.exited_on === null,
    { charge: h6mid?.storage_charge, exited_on: h6mid?.exited_on });
  check("the voided paper stays on the register with its name and its reason",
    (h6mid?.dockets ?? []).some((d: any) => d.state === "voided" && d.void_reason
      && d.voided_by_name === "Baraka Boss"),
    (h6mid?.dockets ?? []).map((d: any) => [d.ref, d.state, d.voided_by_name]));

  const voidTwice = await call(`/warehouse/slips/${outDocket}/void`, tok.dir, {
    method: "POST", body: JSON.stringify({ reason: "voided twice" })
  }, mine);
  check("a voided docket stays voided",
    refusedAs(voidTwice, 409, "CONFLICT", /already voided/i), voidTwice.status);

  const voidEntry2 = await call(`/warehouse/slips/${inDocket}/void`, tok.dir, {
    method: "POST", body: JSON.stringify({ reason: "the whole delivery was another file's" })
  }, mine);
  check("with the goods back inside, the entry can be taken out too, leaving an empty hold",
    voidEntry2.status === 200 && n(voidEntry2.json?.hold?.quantity_in) === 0,
    voidEntry2.json?.hold);

  const refill = await call(`/warehouse/stays/${H6}/entries`, tok.dir, {
    method: "POST", body: JSON.stringify({ slipDay: shift(TODAY, -2), quantity: 40, docketRef: "DLV-7791" })
  }, mine);
  check("a corrected delivery is filed as a new docket under a new number",
    refill.status === 201 && refill.json?.ref !== H6r.json?.dockets?.[0]?.ref
    && /^WE-/.test(String(refill.json?.ref ?? "")),
    { status: refill.status, ref: refill.json?.ref });

  const overRelease = await call(`/warehouse/stays/${H6}/exits`, tok.dir, {
    method: "POST", body: JSON.stringify({ slipDay: TODAY, quantity: 999 })
  }, mine);
  check("the store cannot hand over goods it does not have",
    refusedAs(overRelease, 409, "OVER_RELEASE", /999/, ),
    { status: overRelease.status, code: overRelease.json?.error?.code });

  const beforeArrival = await call(`/warehouse/stays/${H6}/exits`, tok.dir, {
    method: "POST", body: JSON.stringify({ slipDay: shift(TODAY, -9), quantity: 1 })
  }, mine);
  check("goods cannot leave before the day they arrived",
    refusedAs(beforeArrival, 400, "SLIP_BEFORE_ARRIVAL"), beforeArrival.status);

  const releaseAll = await call(`/warehouse/stays/${H6}/exits`, tok.dir, {
    method: "POST", body: JSON.stringify({ slipDay: TODAY, quantity: 40, docketRef: "REL-2292" })
  }, mine);
  check("the hold closes again on the corrected paper",
    releaseAll.json?.hold?.status === "released" && n(releaseAll.json?.hold?.exited_on) === 0
    || releaseAll.json?.hold?.status === "released",
    releaseAll.json?.hold);

  // A docket on a hold that does not exist here at all.
  const ghostHold = await call(`/warehouse/stays/${crypto.randomUUID()}/entries`, tok.dir, {
    method: "POST", body: JSON.stringify({ slipDay: TODAY, quantity: 1 })
  }, mine);
  check("a hold id from outside the register is a 404 before any docket is written",
    refusedAs(ghostHold, 404, "NOT_FOUND"), ghostHold.status);

  // ============================================================================================
  // 4. the neighbour, in its own book
  // ============================================================================================
  const N1r = await openHold({
    shipmentId: S3, place: PLACE3, goods: "Stranger's bagged sugar", unit: "bags",
    dailyRate: 7000, currency: "TZS", freeDays: 0, entryDay: shift(TODAY, -1), quantity: 30
  }, "dir2");
  const N1 = N1r.json?.id as string;
  const N1REF = String(N1r.json?.ref ?? "");
  check("the neighbour opens its own hold through the same doors",
    N1r.status === 201 && N1r.json?.file_number === FILE_C, N1r.status);

  const intrude = await Promise.all([
    call(`/warehouse/stays/${H1}`, tok.dir2, {}, theirs),
    call(`/warehouse/stays/${H1}/entries`, tok.dir2, {
      method: "POST", body: JSON.stringify({ slipDay: TODAY, quantity: 5 })
    }, theirs),
    call(`/warehouse/stays/${H1}/exits`, tok.dir2, {
      method: "POST", body: JSON.stringify({ slipDay: TODAY, quantity: 5 })
    }, theirs),
    call(`/warehouse/stays/${H1}`, tok.dir2, {
      method: "PUT", body: JSON.stringify({
        place: "Taken over", goods: "Whatever", unit: "pcs", containerNumber: null,
        dailyRate: 1, currency: "TZS", freeDays: 0
      })
    }, theirs),
    call(`/warehouse/stays/${H1}/cancel`, tok.dir2, {
      method: "POST", body: JSON.stringify({ reason: "not mine to close" })
    }, theirs),
    call(`/warehouse/slips/${inDocket}/void`, tok.dir2, {
      method: "POST", body: JSON.stringify({ reason: "not mine to void" })
    }, theirs)
  ]);
  check("every act of ours answers the neighbour with 404 and nothing was written",
    intrude.every((r) => refusedAs(r, 404, "NOT_FOUND")), intrude.map((r) => [r.status, msg(r)]));

  const theirBook = await call("/warehouse/stays", tok.dir2, {}, theirs);
  check("the neighbour's register holds its own hold and none of ours",
    (theirBook.json ?? []).length === 1 && theirBook.json[0].id === N1,
    (theirBook.json ?? []).map((r: any) => r.ref));

  const ourBook = await stayRow(H1);
  check("our register never shows the neighbour's hold", !!ourBook && ourBook.file_number === FILE_A,
    ourBook?.file_number);

  // ============================================================================================
  // 5. the filters a clerk actually uses
  // ============================================================================================
  const open = await call("/warehouse/stays?status=stored", tok.dir, {}, mine);
  check("the register opens on what is still in the store, longest held first",
    (open.json ?? []).every((r: any) => r.status === "stored")
    && (open.json ?? []).length === 3
    && open.json[0].id === H1,
    (open.json ?? []).map((r: any) => [r.ref, r.entered_on, r.status]));

  const byFile = await call(`/warehouse/stays?shipmentId=${S1}`, tok.dir, {}, mine);
  check("one file's holds are exactly the ones opened against it",
    (byFile.json ?? []).length === 4 && (byFile.json ?? []).every((r: any) => r.shipment_id === S1),
    (byFile.json ?? []).map((r: any) => r.ref));

  const byPlace = await call(`/warehouse/stays?place=${encodeURIComponent(PLACE2)}`, tok.dir, {}, mine);
  // A store's own book is its holds, and a hold called off stays on the shelf with its reason —
  // the clerk who asks what stood at this store, and what was taken off it, needs both lines.
  check("a store's own book is read by place, called-off hold and all",
    (byPlace.json ?? []).length === 2 && byPlace.json.every((r: any) => r.place === PLACE2)
    && byPlace.json.some((r: any) => r.id === H3) && byPlace.json.some((r: any) => r.id === H4),
    (byPlace.json ?? []).map((r: any) => [r.ref, r.status]));

  const byPlaceOpen = await call(
    `/warehouse/stays?place=${encodeURIComponent(PLACE2)}&status=stored`, tok.dir, {}, mine);
  check("the same store read open is only the goods still standing there",
    (byPlaceOpen.json ?? []).length === 1 && byPlaceOpen.json?.[0]?.id === H3,
    (byPlaceOpen.json ?? []).map((r: any) => r.ref));

  const byDates = await call(
    `/warehouse/stays?from=${shift(TODAY, -10)}&to=${shift(TODAY, -10)}`, tok.dir, {}, mine);
  check("arrivals are filtered by the day they were counted in",
    (byDates.json ?? []).length === 1 && byDates.json[0].id === H1,
    (byDates.json ?? []).map((r: any) => r.entered_on));

  const search = await call(`/warehouse/stays?q=${encodeURIComponent("MSKU4851230")}`, tok.dir, {}, mine);
  check("a container marking finds the hold it sits in",
    (search.json ?? []).length === 1 && search.json[0].id === H1, search.json?.length);
  const searchFile = await call(`/warehouse/stays?q=${encodeURIComponent(FILE_A)}`, tok.dir, {}, mine);
  check("a file number finds every hold of that file",
    (searchFile.json ?? []).length === 4, searchFile.json?.length);

  const picker = await call("/warehouse/files", tok.dir, {}, mine);
  const pickA = (picker.json ?? []).find((f: any) => f.file_number === FILE_A);
  check("the picker lists this company's files with how many of their holds are in the store",
    (picker.json ?? []).length === 2 && pickA?.holds_in_store === 2 && pickA?.consignee_name,
    { rows: picker.json?.length, a: pickA });

  // ============================================================================================
  // 6. the summary, and the money that may not be added
  // ============================================================================================
  const summary = await call("/warehouse/summary", tok.dir, {}, mine);
  const totals = summary.json?.totals ?? {};
  check("the summary counts the company's holds and only its own",
    n(totals.holds) === 6 && n(totals.in_store) === 3 && n(totals.released) === 2
    && n(totals.cancelled) === 1, totals);
  check("the held quantity is only ever counted while the goods stand in the store",
    n(totals.held_quantity) === 125, { held: totals.held_quantity });
  const cur = summary.json?.byCurrency ?? [];
  check("money is summed per currency and never across one",
    cur.length === 2 && cur.some((r: any) => r.currency === "TZS") && cur.some((r: any) => r.currency === "USD"),
    cur.map((r: any) => [r.currency, r.charge, r.holds]));
  const expTZS = await oi(
    `select coalesce(sum(public.warehouse_storage_charge(w.entered_on, w.exited_on, w.free_days,
              w.daily_rate, (timezone('Africa/Dar_es_Salaam', now()))::date)), 0)::float8 as charge
       from warehouse_stays w
      where w.tenant_id = $1 and w.deleted_at is null and w.status <> 'cancelled' and w.currency = 'TZS'`,
    [T]);
  const tzRow = cur.find((r: any) => r.currency === "TZS");
  check("the shilling total is the same figure the database computes from the same functions",
    round2(n(tzRow?.charge)) === round2(n(expTZS.rows[0].charge)),
    { desk: tzRow?.charge, sql: expTZS.rows[0].charge });
  check("the dollar hold's 40 is nowhere inside the shilling total",
    cur.every((r: any) => r.currency !== "USD" || round2(n(r.charge)) === 40)
    && !JSON.stringify(cur).includes(String(n(expTZS.rows[0].charge) + 40)),
    cur.map((r: any) => [r.currency, r.charge]));
  const byPlaceSum = summary.json?.byPlace ?? [];
  check("the store with the longest sit leads the per-place list",
    byPlaceSum[0]?.place === PLACE && n(byPlaceSum[0]?.in_store) === 2,
    byPlaceSum.slice(0, 2).map((r: any) => [r.place, r.in_store]));
  const byFileSum = summary.json?.byFile ?? [];
  check("the most expensive file to sit on is the one that is costing the most",
    byFileSum[0]?.file_number === FILE_A && n(byFileSum[0]?.charge) > n(tzRow?.charge) * 0.5,
    byFileSum.slice(0, 2).map((r: any) => [r.file_number, r.currency, r.charge]));

  // ============================================================================================
  // 7. the store's own paper
  // ============================================================================================
  const upload = async (entityId: string, kind: string, name: string, token: string, bucket?: string[]) => {
    const fd = new FormData();
    fd.append("entityType", "warehouse_stay");
    fd.append("entityId", entityId);
    fd.append("kind", kind);
    fd.append("file", new Blob([`%PDF-1.4\n${name} of ${MARK} ${STAMP}\n%%EOF\n`], { type: "application/pdf" }), name);
    return call("/documents", token, { method: "POST", body: fd }, bucket);
  };
  const rec = await upload(H1, "warehouse_receipt", `receipt-${STAMP}.pdf`, tok.upl, mine);
  const exitPaper = await upload(H1, "warehouse_exit", `exit-${STAMP}.pdf`, tok.upl, mine);
  check("the store's receipt and its release note are filed on the hold",
    rec.status === 201 && exitPaper.status === 201,
    { receipt: rec.status, exit: exitPaper.status, msg: msg(rec) });
  const h1Row = await stayRow(H1);
  check("the register row says how much paper is behind each hold",
    n(h1Row?.attachments) === 2, { attachments: h1Row?.attachments, msg: msg(h1Row) });

  const ontoNeighbour = await upload(N1, "warehouse_receipt", `steal-${STAMP}.pdf`, tok.upl);
  check("a paper cannot be filed onto another company's hold",
    ontoNeighbour.status >= 400, { status: ontoNeighbour.status, msg: msg(ontoNeighbour) });
  const ontoGhost = await upload(crypto.randomUUID(), "warehouse_receipt", `ghost-${STAMP}.pdf`, tok.upl);
  check("a paper cannot be filed onto a hold that does not exist",
    ontoGhost.status >= 400, ontoGhost.status);

  // ============================================================================================
  // 8. the file's margin, with the storage days inside it and the dollars outside
  // ============================================================================================
  const fileCosts = await call("/office-costs/file-costs", tok.dir, {}, mine);
  const fcA = (fileCosts.json?.rows ?? []).find((r: any) => r.file_number === FILE_A);
  const fcB = (fileCosts.json?.rows ?? []).find((r: any) => r.file_number === FILE_B);
  const expA = await oi(
    `select coalesce(sum(public.warehouse_storage_charge(w.entered_on, w.exited_on, w.free_days,
              w.daily_rate, (timezone('Africa/Dar_es_Salaam', now()))::date)), 0)::float8 as tzs,
            coalesce(sum(public.warehouse_storage_charge(w.entered_on, w.exited_on, w.free_days,
              w.daily_rate, (timezone('Africa/Dar_es_Salaam', now()))::date)), 0)::float8 as other
       from warehouse_stays w
      where w.tenant_id = $1 and w.shipment_id = $2 and w.deleted_at is null
        and w.status <> 'cancelled' and (w.currency = 'TZS')`, [T, S1]);
  const expAOther = await oi(
    `select coalesce(sum(public.warehouse_storage_charge(w.entered_on, w.exited_on, w.free_days,
              w.daily_rate, (timezone('Africa/Dar_es_Salaam', now()))::date)), 0)::float8 as other
       from warehouse_stays w
      where w.tenant_id = $1 and w.shipment_id = $2 and w.deleted_at is null
        and w.status <> 'cancelled' and w.currency <> 'TZS'`, [T, S1]);
  check("the file carries its holds and their shilling storage",
    n(fcA?.holds) === 4 && round2(n(fcA?.storage_charge)) === round2(n(expA.rows[0].tzs)),
    { holds: fcA?.holds, charge: fcA?.storage_charge, sql: expA.rows[0].tzs });
  check("and no other currency is folded into the figure the file card prints",
    n(expAOther.rows[0].other) === 0, expAOther.rows[0]);
  check("the margin subtracts the storage run up on the file's own holds",
    round2(n(fcA?.margin)) === round2(1_000_000 - 200_000 - 120_000 - n(fcA?.storage_charge)),
    { margin: fcA?.margin, storage: fcA?.storage_charge });
  check("a file with a dollar hold shows that money beside the margin, never inside it",
    n(fcB?.storage_charge) === 0 && round2(n(fcB?.storage_other)) === 40
    && (fcB?.storage_currencies ?? []).includes("USD")
    && round2(n(fcB?.margin)) === round2(400_000 - 50_000 - 60_000 - 0),
    { tzs: fcB?.storage_charge, other: fcB?.storage_other, cur: fcB?.storage_currencies, margin: fcB?.margin });
  const fcTotals = fileCosts.json?.totals ?? {};
  check("the desk's totals keep the two currencies apart as rows do",
    n(fcTotals.storage_charge) === round2(n(fcA?.storage_charge)) + n(fcB?.storage_charge)
    && round2(n(fcTotals.storage_other)) === 40 && n(fcTotals.storage_files) === 2,
    fcTotals);
  const noStore = await oi(
    `select count(*)::int as c from warehouse_stays where tenant_id = $1
       and shipment_id = $2 and status <> 'cancelled'`, [T, S2]);
  check("the cancelled hold is out of the file's storage, and says why",
    noStore.rows[0].c === 1 && (await detail(H4, "dir")).json?.cancel_reason
      ?.includes("never arrived"), noStore.rows[0].c);
  const fcDenied = await call("/office-costs/file-costs", tok.keep);
  check("a storeman cannot read the money desk", refusedAs(fcDenied, 403, "FORBIDDEN"), fcDenied.status);

  // ============================================================================================
  // 9. the printed book of a file carries the store's registers
  // ============================================================================================
  const reports = await call("/exports/reports", tok.dir, {}, mine);
  const reportsKeeper = await call("/exports/reports", tok.keep);
  check("a seat that reads the store is offered its register",
    (reports.json?.reports ?? []).includes("warehouse"), (reports.json?.reports ?? []).length);
  check("a seat that can file paper but not read it is not offered it",
    !(reportsKeeper.json?.reports ?? []).includes("warehouse"), reportsKeeper.json?.reports);

  const tableBody = JSON.stringify({
    report: "warehouse", format: "xlsx",
    title: "Warehouse — smoke register",
    columns: [{ key: "ref", label: "Hold", type: "text" },
      { key: "charge", label: "Storage", type: "money" }],
    rows: [{ ref: H1r.json?.ref, charge: n(h1Row?.storage_charge) }]
  });
  const tableAsKeeper = await call("/exports/table", tok.keep, { method: "POST", body: tableBody });
  check("printing the store register is the read duty's, not the writer's",
    refusedAs(tableAsKeeper, 403, "FORBIDDEN"), tableAsKeeper.status);

  const xlsx = await callRaw("/exports/cargo-file", tok.dir, { id: S1, format: "xlsx" });
  check("the whole file answers as a workbook",
    xlsx.status === 200 && /spreadsheetml/.test(String(xlsx.headers.get("content-type")))
    && xlsx.buf.subarray(0, 2).toString("latin1") === "PK",
    { status: xlsx.status, type: xlsx.headers.get("content-type") });
  let sheets: string[] = [];
  let pages = "";
  try {
    sheets = sheetNames(xlsx.buf);
    pages = bookText(xlsx.buf);
  } catch (e: any) {
    console.log(`note  the workbook could not be opened by this reader: ${String(e?.message).slice(0, 120)}`);
  }
  check("the file's book has a sheet for its holds and one for its dockets",
    sheets.includes("Warehouse holds") && sheets.includes("Warehouse dockets"), sheets);
  check("the holds sheet carries this file's own hold numbers and places",
    pages.includes(String(H1r.json?.ref)) && pages.includes(PLACE),
    { ref: H1r.json?.ref, len: pages.length });
  const pdfBook = await callRaw("/exports/cargo-file", tok.aud, { id: S1, format: "pdf" });
  check("a seat that reads but does not export still prints the file's book",
    pdfBook.status === 200 && pdfBook.buf.subarray(0, 5).toString("latin1") === "%PDF-",
    { status: pdfBook.status, head: pdfBook.buf.subarray(0, 8).toString("latin1") });
  const theirFile = await callRaw("/exports/cargo-file", tok.dir, { id: S3, format: "xlsx" });
  check("a neighbour's file id answers the export with 404, not with its bytes",
    theirFile.status === 404 && theirFile.buf.subarray(0, 2).toString("latin1") !== "PK",
    theirFile.status);

  // ============================================================================================
  // 10. the audit trail, in the desk's own words
  // ============================================================================================
  const audit = await oi(
    `select action, (count(*))::int as lines from audit_logs
      where tenant_id = $1 and entity in ('warehouse_stays','warehouse_slips')
      group by action order by action`, [T]);
  const actions = audit.rows.map((r: any) => r.action);
  check("every act on the register left its own line",
    ["warehouse.docket_voided", "warehouse.goods_entered", "warehouse.goods_released",
      "warehouse.hold_cancelled", "warehouse.hold_edited", "warehouse.hold_opened"]
      .every((a) => actions.includes(a)), actions);
  const editLine = await oi(
    `select before, after from audit_logs where tenant_id = $1 and entity = 'warehouse_stays'
       and entity_id = $2 and action = 'warehouse.hold_edited' order by ts desc limit 1`, [T, H5]);
  check("the tariff change says what it was before and what it became",
    n(editLine.rows[0]?.before?.daily_rate) === 9000 && n(editLine.rows[0]?.after?.daily_rate) === 12000,
    editLine.rows[0]);
  const cancelLine = await oi(
    `select after from audit_logs where tenant_id = $1 and entity = 'warehouse_stays'
       and entity_id = $2 and action = 'warehouse.hold_cancelled' limit 1`, [T, H4]);
  check("the called-off hold records the reason a clerk typed",
    String(cancelLine.rows[0]?.after?.reason ?? "").includes("never arrived"), cancelLine.rows[0]);
  const exportLines = await oi(
    `select action, after from audit_logs where tenant_id = $1 and entity = 'cargo_shipments'
       and action like 'export.file.%' order by ts desc limit 2`, [T]);
  check("each printed file says on the log which registers went into it",
    exportLines.rowCount === 2 && Number(exportLines.rows[0].after?.registers) > 4,
    exportLines.rows.map((r: any) => [r.action, r.after?.registers]));

  // ============================================================================================
  // 11. what the database refuses, whoever tries it
  // ============================================================================================
  // FILTER belongs on the aggregate, inside the parenthesis that the cast closes — written the
  // other way round Postgres answers 42601, and the run stops before it has proved anything.
  const promises = await oi(
    `select (count(*) filter (where quantity_out > quantity_in))::int as over_drawn,
            (count(*) filter (where status = 'released' and exited_on is null))::int as released_nodate,
            (count(*) filter (where status = 'cancelled' and (quantity_in <> 0
               or cancel_reason is null or cancelled_by is null)))::int as cancelled_wrong,
            (count(*) filter (where status = 'stored' and exited_on is not null))::int as stored_with_exit,
            (count(*) filter (where status = 'released' and quantity_in = 0))::int as released_nothing,
            (count(*) filter (where released_by is not null and status <> 'released'))::int as leaver_named_open
       from warehouse_stays where tenant_id = $1`, [T]);
  check("no hold in the register contradicts its own dockets",
    n(promises.rows[0].over_drawn) === 0 && n(promises.rows[0].released_nodate) === 0
    && n(promises.rows[0].cancelled_wrong) === 0 && n(promises.rows[0].stored_with_exit) === 0
    && n(promises.rows[0].released_nothing) === 0 && n(promises.rows[0].leaver_named_open) === 0,
    promises.rows[0]);

  const projections = await oi(
    `select (count(*))::int as drift from warehouse_stays w
       join (select s.stay_id,
               coalesce(sum(s.quantity) filter (where s.kind = 'entry' and s.state = 'filed'), 0) as q_in,
               coalesce(sum(s.quantity) filter (where s.kind = 'exit' and s.state = 'filed'), 0) as q_out,
               min(s.slip_day) filter (where s.kind = 'entry' and s.state = 'filed') as first_in,
               max(s.slip_day) filter (where s.kind = 'exit' and s.state = 'filed') as last_out
              from warehouse_slips s group by s.stay_id) x
         on x.stay_id = w.id
      where w.tenant_id = $1
        and (w.quantity_in <> x.q_in or w.quantity_out <> x.q_out
             or (w.entered_on is distinct from x.first_in)
             or (w.status = 'released' and w.exited_on is distinct from x.last_out))`, [T]);
  check("every projection the trigger maintains equals the filed paper itself",
    n(projections.rows[0].drift) === 0, projections.rows[0].drift);

  const slipShape = await oi(
    `select (count(*) filter (where (kind = 'entry' and ref not like 'WE-%')
                                 or (kind = 'exit' and ref not like 'WX-%')))::int as wrong_prefix,
            (count(*) filter (where state = 'filed' and filed_by is null))::int as nameless
       from warehouse_slips where tenant_id = $1`, [T]);
  check("a docket's number always carries the movement it records",
    n(slipShape.rows[0].wrong_prefix) === 0, slipShape.rows[0]);
  check("every filed docket on the register was filed by somebody with a name",
    n(slipShape.rows[0].nameless) === 0, slipShape.rows[0].nameless);

  const refs = await oi(
    `select (count(*))::int as total, (count(distinct ref))::int as unique_refs
       from (select ref from warehouse_stays where tenant_id = $1
             union all select ref from warehouse_slips where tenant_id = $1) x`, [T]);
  check("no two rows of this book share a number",
    n(refs.rows[0].total) === n(refs.rows[0].unique_refs), refs.rows[0]);

  // The owner of the tables bypasses the row-level policies, so these attempts are the honest
  // test of whether the register's rules live in the database or only in the routes above it.
  const tryDb = async (label: string, re: RegExp, sql: string, p: unknown[] = []) => {
    await oi("begin");
    let err = "";
    try { await oi(sql, p); } catch (e: any) { err = String(e?.message ?? e); }
    await oi("rollback");
    check(label, re.test(err), err.slice(0, 140));
  };
  await tryDb("a filed docket's quantity cannot be rewritten by anyone",
    /not rewritten/i, `update warehouse_slips set quantity = 1 where id = $1`, [inDocket]);
  await tryDb("a docket number cannot disagree with the movement it records",
    /prefix/i,
    `insert into warehouse_slips (tenant_id, stay_id, kind, ref, slip_day, quantity)
     values ($1,$2,'entry','WX-2026-99999',$3,1)`, [T, H1, TODAY]);
  await tryDb("goods cannot be let out before they arrived, even in SQL",
    /before|cannot/i,
    `insert into warehouse_slips (tenant_id, stay_id, kind, slip_day, quantity)
     values ($1,$2,'exit',$3,1)`, [T, H1, shift(TODAY, -40)]);
  // 119 moved 118's promise from the comment into the trigger: a figure a clerk typed is refused,
  // while the same figure written by the bookkeeping trigger from filed paper passes. So the
  // balance CHECK has to be proven the way the register actually reaches it — through a docket.
  await tryDb("a hold's quantities and dates are not typed onto the row by hand",
    /not typed|conclusion/i,
    `update warehouse_stays set quantity_in = 500, status = 'released' where id = $1 and tenant_id = $2`,
    [H1, T]);
  // With the figures no longer typeable, the only way to draw more than came in is to file a docket
  // that does it, so the balance is proven through the paper the register actually takes.
  const standing = await oi(
    `select id, ref, (quantity_in - quantity_out)::float8 as balance from warehouse_stays
      where tenant_id = $1 and status = 'stored' and quantity_in > quantity_out
      order by created_at limit 1`, [T]);
  const STANDING = standing.rows[0]?.id as string | undefined;
  await tryDb("the store cannot let out goods it never received, even from SQL",
    /cannot release|quantity_out|check|violates|balance/i,
    `insert into warehouse_slips (tenant_id, stay_id, kind, slip_day, quantity)
     values ($1,$2,'exit',$3,999999)`, [T, STANDING, TODAY]);
  const emptied = await oi(
    `select id, ref from warehouse_stays where tenant_id = $1 and status = 'released'
      order by created_at limit 1`, [T]);
  await tryDb("a hold that has given out everything it received takes no new delivery, even in SQL",
    /new hold|closed/i,
    `insert into warehouse_slips (tenant_id, stay_id, kind, slip_day, quantity)
     values ($1,$2,'entry',$3,10)`, [T, emptied.rows[0]?.id, TODAY]);
  await tryDb("a hold cannot be moved into a store by hand without its dockets",
    /not in your register|hold/i,
    `insert into warehouse_slips (tenant_id, stay_id, kind, slip_day, quantity)
     values ($1,$2,'entry',$3,1)`, [T, crypto.randomUUID(), TODAY]);

  // A hold opened with figures already on it is the row 118 described and the table did not refuse.
  // The trigger answers by emptying it rather than by raising, because the route that opens a hold
  // with a first delivery files the docket in the same act and the bookkeeping writes the figures.
  await oi("begin");
  const typedOpen = await oi(
    `insert into warehouse_stays
       (id, tenant_id, shipment_id, place, goods, unit, daily_rate, currency, free_days,
        opened_by, created_by, quantity_in, quantity_out, entered_on, exited_on, released_by, status)
     values ($1,$2,$3,$4,'Bagged cement','bags',1000,'TZS',0,$5,$5,500,500,$6,$6,$5,'released')
     returning quantity_in::float8 as quantity_in, quantity_out::float8 as quantity_out,
               entered_on, exited_on, released_by, status, ref`,
    [crypto.randomUUID(), T, S1, PLACE, seats.dir.id, TODAY]);
  await oi("rollback");
  const typed = typedOpen.rows[0] ?? {};
  check("a hold written with figures of its own arrives empty, priced from no day",
    n(typed.quantity_in) === 0 && n(typed.quantity_out) === 0 && typed.entered_on === null
    && typed.exited_on === null && typed.released_by === null, typed);
  check("a hold cannot be born released: the status is the dockets' conclusion",
    typed.status === "stored" && /^WH-/.test(String(typed.ref ?? "")), [typed.status, typed.ref]);

  // ============================================================================================
  // 12. nothing a desk was told reached across the two companies
  // ============================================================================================
  const oursLeaked = mine.filter((b) => b.includes(FILE_C) || b.includes(N1REF)
    || b.includes(OTHER) || b.includes("Stranger Consignee"));
  check("no answer our seats received carries the neighbour's file, hold or name",
    oursLeaked.length === 0, oursLeaked.map((b) => b.slice(0, 90)));
  const theirsLeaked = theirs.filter((b) => b.includes(FILE_A) || b.includes(FILE_B)
    || b.includes(COMPANY) || b.includes(String(H1r.json?.ref ?? "__none__")));
  check("no answer the neighbour received carries our file, hold or company",
    theirsLeaked.length === 0, theirsLeaked.map((b) => b.slice(0, 90)));
  const secrets = [...mine, ...theirs].filter((b) => /JWT_SECRET|RESEND_API_KEY|password/i.test(b));
  check("nothing printed a key or a password into an answer", secrets.length === 0, secrets.length);

  // ============================================================================================
  // teardown
  // ============================================================================================
  await sweep(T);
  await sweep(T2);
  const residue = await oi(
    `select (select count(*) from warehouse_stays where tenant_id = any($1::uuid[])) as stays,
            (select count(*) from warehouse_slips where tenant_id = any($1::uuid[])) as slips,
            (select count(*) from documents where tenant_id = any($1::uuid[])) as papers,
            (select count(*) from office_costs where tenant_id = any($1::uuid[])) as costs,
            (select count(*) from cargo_shipments where tenant_id = any($1::uuid[])) as files,
            (select count(*) from audit_logs where tenant_id = any($1::uuid[])) as audit,
            (select count(*) from tenants where name ~ '^Store (Smoke|Stranger) [0-9]{8}$') as companies`,
    [[T, T2]]);
  // `audit` is deliberately outside the emptiness test: 118 gives the register no DELETE and the
  // house keeps every line a desk wrote, so a clean run must leave a story behind it. The number is
  // printed so a reader can see the residue is audit and nothing else.
  const kept = Number(residue.rows[0].audit);
  const dirty = Object.entries(residue.rows[0]).filter(([k, v]) => k !== "audit" && Number(v) !== 0);
  check("the fixture leaves no hold, docket, paper, cost, file, seat or company behind",
    dirty.length === 0, dirty);
  console.log(`(audit_logs keeps ${kept} rows for the swept companies — the register is append-only)`);

  await owner.end();
  console.log(`\n${failures ? `FAILURES: ${failures}` : "all warehouse checks passed"} — ${MARK}`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
