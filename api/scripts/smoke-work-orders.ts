/**
 * End-to-end smoke for the workshop register (#185, migration 109) against a running API on :4000.
 *
 * `109_work_order_register.sql` decides what a card may look like. This decides whether the doors a
 * clerk walks through agree with it: that an in-house job cannot be raised without naming a
 * mechanic of *this* company, that a truck somebody has hired is refused entry to the workshop and
 * told whose it is, that the odometer a vehicle comes back with is the number the plate's own
 * register ends up holding, that a called-off job stops costing anything and only releases the
 * plate when the card was the thing parking it, and that a seat which can read the register cannot
 * move a card through any door.
 *
 * Two companies are planted, so the isolation pass can aim a real director token at a neighbour's
 * plate and a neighbour's staff record. The fleet, the people and one open handover are planted in
 * SQL — an assertion about a workshop visit is only honest when every row around it was put here by
 * this script. Every card, move, close, cancel and read from there goes over HTTP and is read back
 * from the database.
 *
 * Run: npx tsx scripts/smoke-work-orders.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const COMPANY = `Workshop Smoke ${STAMP}`;
const OTHER = `Workshop Stranger ${STAMP}`;
/** Written into every free-text column this fixture owns, so a stray row is findable by it. */
const MARK = `workshop smoke ${STAMP}`;
const MECH_NAME = `Kilian Smoke Mechanic ${STAMP}`;
const MECH2_NAME = `Kilian Smoke Second Mechanic ${STAMP}`;
const DRIVER_NAME = `Kilian Smoke Held Driver ${STAMP}`;
/** Planted in the driver's searchable PII columns: no answer in this run may print it. */
const PII = `NIDA-NEVER-PRINTED-${STAMP}`;
const GARAGE = "Kigamboni Diesel Works";

const DAY = 24 * 3600 * 1000;
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (s: string, n: number) => iso(new Date(new Date(`${s}T12:00:00`).getTime() + n * DAY));
const TODAY = iso(new Date());

async function mint(sub: string, tid: string, roleKey: string) {
  return new SignJWT({ tid, sid: "00000000-7000-7000-8000-0000000000aa", typ: roleKey, roles: [roleKey] })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("30m").sign(key);
}

async function call(path: string, token: string | null, init: RequestInit = {}) {
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
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
/** The route's own error code, which is the half of a refusal a workshop actually reads. */
function refusedAs(r: { status: number; json: any }, status: number, code: string, re?: RegExp) {
  return r.status === status && r.json?.error?.code === code
    && (!re || re.test(String(r.json?.error?.message ?? "")));
}
const field = (j: any) => (j?.error?.details ?? []).map((d: any) => d.field);
const n = (v: unknown) => (v === null || v === undefined ? NaN : Number(v));
const msg = (r: { json: any }) => String(r.json?.error?.message ?? "");
const pdf = (label: string) => Buffer.from(`%PDF-1.4\n${label} of ${MARK} ${STAMP}\n%%EOF\n`, "utf8");

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, p: unknown[] = []) => owner.query(sql, p as any[]);

  /**
   * One company's rows, in the order the keys allow: a garage bill points at a card, a card points
   * at a plate and a staff record, so the paper goes first and the people and plates last.
   */
  const sweep = async (tid: string) => {
    for (const sql of [
      `delete from documents where tenant_id = $1`,
      `delete from work_orders where tenant_id = $1`,
      `delete from vessel_log_entries where tenant_id = $1`,
      `delete from vessel_assignments where tenant_id = $1`,
      `update drivers set assigned_vessel_id = null where tenant_id = $1`,
      `delete from vessels where tenant_id = $1`,
      `delete from drivers where tenant_id = $1`,
      `delete from employees where tenant_id = $1`,
      `delete from user_roles where user_id in (select id from users where tenant_id = $1)`,
      `delete from roles where tenant_id = $1`,
      `delete from sessions where user_id in (select id from users where tenant_id = $1)`,
      `delete from users where tenant_id = $1`,
      `delete from tenants where id = $1`
    ]) {
      await oi(sql, [tid]).catch((e: any) => console.log(`sweep note: ${String(e.message).slice(0, 90)}`));
    }
  };

  // A run that crashed half way leaves a company behind, and the counts this script asserts are
  // only honest while every card in the register is one it minted. The names it gives tenants are
  // `Workshop `+`Smoke`/`Stranger` and eight digits, so the pattern cannot catch a real one.
  const orphans = await oi(
    `select id from tenants where name ~ '^Workshop (Smoke|Stranger) [0-9]{8}$'`);
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
  // The garage's bill is filed through the ordinary vault, which answers `documents.create`. Which
  // role holds that key is not this register's business, so it is read from the catalog rather than
  // guessed, and the run says out loud which desk it borrowed.
  const uploaderKey = (await oi(
    `select r.key from roles r join role_permissions rp on rp.role_id = r.id
      where r.tenant_id is null and rp.permission_key = 'documents.create'
      order by r.key limit 1`)).rows[0]?.key as string | undefined;
  if (!uploaderKey) throw new Error("No global role holds documents.create");
  const uploaderRole = await roleOf(uploaderKey);

  const roles = {
    wsm: await roleOf("workshop_manager"),
    flm: await roleOf("fleet_manager"),
    dir: await roleOf("director"),
    aud: await roleOf("auditor"),
    dsp: await roleOf("dispatcher"),
    drv: await roleOf("driver")
  };

  for (const [tid, name] of [[T, COMPANY], [T2, OTHER]] as [string, string][]) {
    await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')`, [tid, name]);
  }

  const uid: Record<string, string> = {};
  const seat = async (who: string, tid: string, name: string, roleId: string, roleKey: string) => {
    const u = await oi(`insert into users (tenant_id, user_type, email, status, full_name)
                        values ($1,'staff',$2,'active',$3) returning id`,
      [tid, `${who}.ws.${STAMP}@example.org`, name]);
    const id = u.rows[0].id as string;
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [id, roleId]);
    uid[who] = id;
    return { id, roleKey };
  };
  const seats: Record<string, { id: string; roleKey: string }> = {};
  for (const [who, name, roleId, roleKey] of [
    ["wsm", "Amina Ya Keragi", roles.wsm, "workshop_manager"],
    ["flm", "Joseph Mbwana", roles.flm, "fleet_manager"],
    ["dir", "Baraka Boss", roles.dir, "director"],
    ["aud", "Daudi Auditor", roles.aud, "auditor"],
    ["dsp", "Saida Dispatcher", roles.dsp, "dispatcher"],
    ["drv", "Peter Driver", roles.drv, "driver"],
    ["upl", "Grace Records", uploaderRole, uploaderKey],
    ["dir2", "Stranger Boss", roles.dir, "director"]
  ] as [string, string, string, string][]) {
    seats[who] = await seat(who, who === "dir2" ? T2 : T, name, roleId, roleKey);
    uid[who] = seats[who].id;
  }

  // A foreman of this company only: the three workshop keys but not the closing one. 109 hands
  // `close` to no role that holds `create`, so the register's other cancel rule — the seat that
  // wrote a card may take it back while nothing has happened to the vehicle — cannot be reached
  // through any built-in desk. It is reached here, by a tenant role that leaves the key off.
  const foremanRole = (await oi(
    `insert into roles (id, tenant_id, key, name, is_system)
     values (gen_random_uuid(),$1,'workshop_foreman','Workshop foreman (fixture)',false)
     returning id`, [T])).rows[0].id as string;
  await oi(`insert into role_permissions (role_id, permission_key) values ($1,$2)
            on conflict do nothing`, [foremanRole, "work_orders.view"]);
  await oi(`insert into role_permissions (role_id, permission_key) values ($1,$2)
            on conflict do nothing`, [foremanRole, "work_orders.create"]);
  await oi(`insert into role_permissions (role_id, permission_key) values ($1,$2)
            on conflict do nothing`, [foremanRole, "work_orders.edit"]);
  seats.fr = await seat("fr", T, "Hashimu Mekaniki", foremanRole, "workshop_foreman");
  uid.fr = seats.fr.id;

  const tok: Record<string, string> = {};
  for (const who of Object.keys(seats)) {
    tok[who] = await mint(seats[who].id, seats[who] === seats.dir2 ? T2 : T, seats[who].roleKey);
  }

  // --- the fleet and the staff, planted ------------------------------------------------------
  const mkVessel = async (tid: string, plate: string, odo: number, status: string) => (await oi(
    `insert into vessels (tenant_id, name, vessel_type, plate_number, odometer_km, status,
                          insurance_expiry, inspection_expiry, road_licence_expiry)
     values ($1,$2,'truck_head',$3,$4,$5,$6::date,$6::date,$6::date) returning id`,
    [tid, `${MARK} ${plate}`, plate, odo, status, shift(TODAY, 200)])).rows[0].id as string;

  const V1 = await mkVessel(T, `WSA${STAMP}1`, 50000, "standby");   // the in-house service
  const V2 = await mkVessel(T, `WSA${STAMP}2`, 80000, "standby");   // the garage bill
  const V3 = await mkVessel(T, `WSA${STAMP}3`, 12000, "standby");   // out on hire, then freed
  const V4 = await mkVessel(T, `WSA${STAMP}4`, 300000, "standby");  // a card that never parked it
  const V5 = await mkVessel(T, `WSA${STAMP}5`, 60000, "standby");   // held by two cards at once
  const V0 = await mkVessel(T2, `WSB${STAMP}0`, 9000, "standby");   // the neighbour's plate

  const emp = async (tid: string, name: string, title: string) => (await oi(
    `insert into employees (id, tenant_id, full_name, job_title, department, employment_type,
                            status, hired_date)
     values (gen_random_uuid(),$1,$2,$3,'Workshop','permanent','active',
             now() - interval '400 days') returning id`, [tid, name, title])).rows[0].id as string;
  const MK = await emp(T, MECH_NAME, "Workshop foreman");
  const MK2 = await emp(T, MECH2_NAME, "Panel beater");
  const MK0 = await emp(T2, `Kilian Stranger Mechanic ${STAMP}`, "Workshop foreman");
  const DR = (await oi(
    `insert into drivers (tenant_id, full_name, status, phone_search, nida_search)
     values ($1,$2,'available',$3,$3) returning id`,
    [T, DRIVER_NAME, PII])).rows[0].id as string;
  const AS = (await oi(
    `insert into vessel_assignments (id, tenant_id, vessel_id, driver_id, status,
                                     start_odometer_km, notes, created_by)
     values (gen_random_uuid(),$1,$2,$3,'active',12000,$4,$5) returning id`,
    [T, V3, DR, MARK, uid.wsm])).rows[0].id as string;
  await oi(`update drivers set assigned_vessel_id = $2 where id = $1`, [DR, V3]);

  const card = async (who: string, body: Record<string, unknown>) =>
    call("/work-orders", tok[who], { method: "POST", body: JSON.stringify(body) });

  // =========================================================================
  console.log(`\n--- 1 · the doors (fixture ${COMPANY}, uploader role ${uploaderKey}) ---`);
  // =========================================================================

  for (const [label, path, init] of [
    ["GET /work-orders", "/work-orders", { method: "GET" }],
    ["GET /work-orders/mechanics", "/work-orders/mechanics", { method: "GET" }],
    ["GET /work-orders/summary", "/work-orders/summary", { method: "GET" }],
    ["POST /work-orders", "/work-orders", { method: "POST", body: "{}" }],
    ["PUT /work-orders/:id", `/work-orders/${crypto.randomUUID()}`, { method: "PUT", body: "{}" }],
    ["POST /work-orders/:id/workshop", `/work-orders/${crypto.randomUUID()}/workshop`, { method: "POST", body: "{}" }],
    ["POST /work-orders/:id/return", `/work-orders/${crypto.randomUUID()}/return`, { method: "POST", body: "{}" }],
    ["POST /work-orders/:id/cancel", `/work-orders/${crypto.randomUUID()}/cancel`, { method: "POST", body: "{}" }]
  ] as [string, string, RequestInit][]) {
    const r = await call(path, null, init);
    check(`${label} refuses a tokenless call`, r.status === 401, { status: r.status, body: r.json });
  }

  const drvList = await call("/work-orders", tok.drv, { method: "GET" });
  check("a driver seat cannot even read the register",
    refusedAs(drvList, 403, "FORBIDDEN"), { status: drvList.status, message: msg(drvList) });
  for (const [label, path, init] of [
    ["raise", "/work-orders", { method: "POST", body: JSON.stringify({ vesselId: V1, raisedOn: TODAY, title: "Anything at all", place: "in_house", mechanicEmployeeId: MK }) }],
    ["close", `/work-orders/${crypto.randomUUID()}/return`, { method: "POST", body: JSON.stringify({ odometerOutKm: 51000 }) }],
    ["move", `/work-orders/${crypto.randomUUID()}/workshop`, { method: "POST", body: JSON.stringify({ status: "in_workshop" }) }],
    ["edit", `/work-orders/${crypto.randomUUID()}`, { method: "PUT", body: JSON.stringify({ raisedOn: TODAY, title: "Rewritten by a driver", kind: "service", place: "in_house", mechanicEmployeeId: MK }) }]
  ] as [string, string, RequestInit][]) {
    const r = await call(path, tok.drv, init);
    check(`a driver seat cannot ${label} a card`,
      refusedAs(r, 403, "FORBIDDEN"), { status: r.status, message: msg(r) });
  }

  // The view-only desks hold the read and nothing else. `cancel` is the interesting one: its gate
  // is deliberately the *view* key, so a clerk reaches the route and is refused there, by a rule
  // about the row rather than about the duty.
  for (const who of ["aud", "dsp"]) {
    const read = await call("/work-orders", tok[who], { method: "GET" });
    check(`${who} reads an empty register, because the company has no cards yet`,
      read.status === 200 && Array.isArray(read.json) && read.json.length === 0,
      { status: read.status, body: read.json });
    const write = await card(who, { vesselId: V1, raisedOn: TODAY, title: "A view-only desk tries to write", place: "in_house", mechanicEmployeeId: MK });
    check(`${who} cannot raise a card`, refusedAs(write, 403, "FORBIDDEN"),
      { status: write.status, message: msg(write) });
    const close = await call(`/work-orders/${crypto.randomUUID()}/return`, tok[who], {
      method: "POST", body: JSON.stringify({ odometerOutKm: 51000 })
    });
    check(`${who} cannot close a card`, refusedAs(close, 403, "FORBIDDEN"),
      { status: close.status, message: msg(close) });
    const move = await call(`/work-orders/${crypto.randomUUID()}/workshop`, tok[who], {
      method: "POST", body: JSON.stringify({ status: "in_workshop" })
    });
    check(`${who} cannot move a card into the workshop`, refusedAs(move, 403, "FORBIDDEN"),
      { status: move.status, message: msg(move) });
  }

  // =========================================================================
  console.log("\n--- 2 · what a card refuses to be ---");
  // =========================================================================

  const noGarage = await card("wsm", { vesselId: V1, raisedOn: TODAY, title: "Injector pump replaced", place: "outside_garage" });
  check("a job sent outside without a garage is refused, and the refusal names the box",
    refusedAs(noGarage, 400, "VALIDATION_FAILED") && field(noGarage.json).includes("garageName"),
    { status: noGarage.status, fields: field(noGarage.json), message: msg(noGarage) });

  const noMechanic = await card("wsm", { vesselId: V1, raisedOn: TODAY, title: "Oil service", place: "in_house" });
  check("an in-house job with nobody named is refused on the mechanic box",
    refusedAs(noMechanic, 400, "VALIDATION_FAILED") && field(noMechanic.json).includes("mechanicEmployeeId"),
    { status: noMechanic.status, fields: field(noMechanic.json) });

  const foreignMechanic = await card("wsm", { vesselId: V1, raisedOn: TODAY, title: "Oil service", place: "in_house", mechanicEmployeeId: MK0 });
  check("…and a borrowed staff record is refused as though it were no record at all",
    refusedAs(foreignMechanic, 400, "VALIDATION_FAILED", /not a staff record/)
    && field(foreignMechanic.json).includes("mechanicEmployeeId"),
    { status: foreignMechanic.status, message: msg(foreignMechanic) });

  const tomorrow = await card("wsm", { vesselId: V1, raisedOn: shift(TODAY, 1), title: "Oil service", place: "in_house", mechanicEmployeeId: MK });
  check("a card cannot be dated after today",
    refusedAs(tomorrow, 400, "ORDER_DATE_FUTURE", new RegExp(TODAY)),
    { status: tomorrow.status, message: msg(tomorrow) });

  const ahead = await card("wsm", { vesselId: V1, raisedOn: TODAY, title: "Oil service", place: "in_house", mechanicEmployeeId: MK, odometerInKm: 50001 });
  check("a card cannot open above the reading the plate already carries",
    refusedAs(ahead, 409, "ODOMETER_AHEAD", /50[,.]?000 km/),
    { status: ahead.status, message: msg(ahead) });

  const noPlate = await card("wsm", { vesselId: crypto.randomUUID(), raisedOn: TODAY, title: "Oil service", place: "in_house", mechanicEmployeeId: MK });
  check("a card cannot be raised against a plate that is not there",
    refusedAs(noPlate, 404, "NOT_FOUND"), noPlate.status);
  const neighbourPlate = await card("wsm", { vesselId: V0, raisedOn: TODAY, title: "Oil service", place: "in_house", mechanicEmployeeId: MK });
  check("…nor against a plate that belongs to another company",
    refusedAs(neighbourPlate, 404, "NOT_FOUND"), neighbourPlate.status);

  const typed = await card("wsm", { vesselId: V1, raisedOn: TODAY, title: "ab", place: "in_house", mechanicEmployeeId: MK });
  check("a two-letter job title is refused before the register is asked",
    typed.status === 400 && field(typed.json).includes("title"),
    { status: typed.status, fields: field(typed.json) });

  const stillEmpty = await oi(`select count(*)::int as n from work_orders where tenant_id = $1`, [T]);
  check("…and none of those refusals left a row behind",
    stillEmpty.rows[0].n === 0, stillEmpty.rows[0]);

  // =========================================================================
  console.log("\n--- 3 · an in-house service, from the card to the plate's journal ---");
  // =========================================================================

  const C1 = await card("wsm", {
    vesselId: V1, raisedOn: TODAY, title: "Oil service and injector pump check",
    detail: "Rough idle on the Dar–Morogoro run", kind: "service", place: "in_house",
    mechanicEmployeeId: MK, odometerInKm: 49500, partsCost: 180000, labourCost: 70000, currency: "TZS"
  });
  const id1 = C1.json?.id as string;
  const ref1 = C1.json?.ref as string;
  check("a work order raised over HTTP answers 201 with its own number",
    C1.status === 201 && /^WO-\d{4}-\d{5,}$/.test(String(ref1)) && C1.json?.status === "raised",
    { status: C1.status, json: C1.json });

  const row1 = (await oi(
    `select status, ref, raised_on::text as raised_on, place, garage_name, mechanic_employee_id,
            odometer_in_km, odometer_out_km, parts_cost, labour_cost, other_cost, currency,
            opened_at, opened_by, returned_at, cancelled_by, created_by, tenant_id
       from work_orders where id = $1`, [id1])).rows[0];
  check("…filed against this company, this plate and this staff record",
    row1?.tenant_id === T && row1?.status === "raised" && row1?.place === "in_house"
    && row1?.mechanic_employee_id === MK && row1?.garage_name === null, row1);
  check("…opened at the reading typed, with no closing stamp of any kind",
    row1?.raised_on === TODAY && n(row1?.odometer_in_km) === 49500 && !row1?.opened_at
    && !row1?.returned_at && !row1?.cancelled_by && row1?.created_by === uid.wsm, row1);
  check("…and the bill sits on the card, not on the vehicle",
    n(row1?.parts_cost) === 180000 && n(row1?.labour_cost) === 70000 && n(row1?.other_cost) === 0
    && row1?.currency === "TZS", row1);

  const journal1 = await oi(
    `select kind, title, detail, odometer_km, actor_name from vessel_log_entries
      where tenant_id = $1 and vessel_id = $2 and title like $3 order by created_at`,
    [T, V1, `Work order ${ref1}%`]);
  check("the plate's own diary says the visit happened, and where the money is",
    journal1.rowCount === 1 && journal1.rows[0]?.kind === "service"
    && n(journal1.rows[0]?.odometer_km) === 49500
    && /figures live on the work order/.test(String(journal1.rows[0]?.detail ?? ""))
    && journal1.rows[0]?.actor_name === MECH_NAME, journal1.rows[0]);
  const odo1 = await oi(`select status, odometer_km from vessels where id = $1`, [V1]);
  check("…and raising the card did not move the plate's state or its reading",
    odo1.rows[0]?.status === "standby" && n(odo1.rows[0]?.odometer_km) === 50000, odo1.rows[0]);

  const audit1 = await oi(
    `select action, "after"->>'ref' as ref, "after"->>'vessel' as vessel,
            "after"->>'parts' as parts, "after"->>'mechanic' as mechanic
       from audit_logs where tenant_id = $1 and entity = 'work_orders' and entity_id = $2`,
    [T, id1]);
  check("the raise is audited with the plate, the number and the money",
    audit1.rows[0]?.action === "work_order.raised" && audit1.rows[0]?.ref === ref1
    && String(audit1.rows[0]?.vessel ?? "").includes(`WSA${STAMP}1`)
    && audit1.rows[0]?.parts === "180000" && audit1.rows[0]?.mechanic === MK, audit1.rows[0]);

  const moved = await call(`/work-orders/${id1}/workshop`, tok.flm, {
    method: "POST", body: JSON.stringify({ status: "in_workshop", note: "Lifted into bay 2 this morning" })
  });
  check("the fleet desk takes the card into the workshop and moves the plate with it",
    moved.status === 200 && moved.json?.ok === true && moved.json?.vesselMoved === true
    && moved.json?.row?.status === "in_workshop", { status: moved.status, json: moved.json });
  const v1after = await oi(`select status, status_reason from vessels where id = $1`, [V1]);
  check("…the plate now reads in_garage, with the card named as the reason",
    v1after.rows[0]?.status === "in_garage"
    && String(v1after.rows[0]?.status_reason ?? "").includes(ref1), v1after.rows[0]);
  const stamp1 = await oi(`select opened_at, opened_by from work_orders where id = $1`, [id1]);
  check("…and the opening stamp records the seat that moved it, not the one that wrote the card",
    !!stamp1.rows[0]?.opened_at && stamp1.rows[0]?.opened_by === uid.flm, stamp1.rows[0]);
  const journalOpen = await oi(
    `select title, detail from vessel_log_entries where tenant_id = $1 and vessel_id = $2
       and kind = 'note' and title like $3`, [T, V1, `Work order ${ref1}: opened%`]);
  check("…the clerk's reason is written where the next reader of the plate will find it",
    journalOpen.rowCount === 1 && /bay 2/.test(String(journalOpen.rows[0]?.detail ?? "")),
    journalOpen.rows[0]);
  const journalParts = await oi(
    `select count(*)::int as n from vessel_log_entries where tenant_id = $1 and vessel_id = $2
       and kind = 'note' and title like $3`, [T, V1, `Work order ${ref1}: held for parts%`]);
  check("…and a move that was not a parts hold is not filed under the parts heading",
    journalParts.rows[0].n === 0, journalParts.rows[0]);
  const auditMove = await oi(
    `select action, "after"->>'vessel_status_changed' as changed from audit_logs
      where tenant_id = $1 and entity = 'work_orders' and entity_id = $2
      order by ts desc limit 1`, [T, id1]);
  check("…the move is audited as its own act, with the plate's answer beside it",
    auditMove.rows[0]?.action === "work_order.in_workshop"
    && auditMove.rows[0]?.changed === "true", auditMove.rows[0]);

  const corrected = await call(`/work-orders/${id1}`, tok.wsm, {
    method: "PUT",
    body: JSON.stringify({
      raisedOn: TODAY, title: "Oil service, injector pump replaced", detail: "Pump head cracked",
      kind: "service", place: "in_house", mechanicEmployeeId: MK, odometerInKm: 49500,
      partsCost: 240000, labourCost: 90000, otherCost: 15000, currency: "TZS"
    })
  });
  check("the workshop desk corrects an open card in place",
    corrected.status === 200 && corrected.json?.ok === true
    && corrected.json?.title === "Oil service, injector pump replaced"
    && corrected.json?.status === "in_workshop", { status: corrected.status, json: corrected.json });
  const afterEdit = await oi(
    `select title, detail, parts_cost, labour_cost, other_cost, status from work_orders where id = $1`, [id1]);
  check("…the figures follow the correction, and the card is still open",
    afterEdit.rows[0]?.status === "in_workshop" && n(afterEdit.rows[0]?.parts_cost) === 240000
    && n(afterEdit.rows[0]?.other_cost) === 15000
    && afterEdit.rows[0]?.detail === "Pump head cracked", afterEdit.rows[0]);
  const editAudit = await oi(
    `select "before"->>'parts' as was, "after"->>'parts' as now_ from audit_logs
      where tenant_id = $1 and entity = 'work_orders' and action = 'work_order.edited'
        and entity_id = $2`, [T, id1]);
  check("…audited with the old figure beside the new one",
    editAudit.rows[0]?.was === "180000.00" && editAudit.rows[0]?.now_ === "240000",
    editAudit.rows[0]);

  const tooLow = await call(`/work-orders/${id1}/return`, tok.wsm, {
    method: "POST", body: JSON.stringify({ odometerOutKm: 49400 })
  });
  check("a vehicle cannot come back at a lower reading than it went in",
    refusedAs(tooLow, 409, "ODOMETER_REGRESSION"), { status: tooLow.status, message: msg(tooLow) });

  const back1 = await call(`/work-orders/${id1}/return`, tok.wsm, {
    method: "POST",
    body: JSON.stringify({ odometerOutKm: 50600, roadworthy: true, invoiceRef: "WS-inhouse-11", note: "Ran the corridor test without a misfire" })
  });
  check("closing the visit sends the plate back on the road",
    back1.status === 200 && back1.json?.status === "returned"
    && back1.json?.vessel_status === "standby" && back1.json?.vessel_status_changed === true
    && back1.json?.vessel_odometer_updated === true, { status: back1.status, json: back1.json });
  const v1closed = await oi(`select status, odometer_km from vessels where id = $1`, [V1]);
  check("…and the plate's register reading is the one the truck rolled out with",
    v1closed.rows[0]?.status === "standby" && n(v1closed.rows[0]?.odometer_km) === 50600,
    v1closed.rows[0]);
  const c1closed = await oi(
    `select status, odometer_out_km, invoice_ref, returned_at, returned_by, parts_cost
       from work_orders where id = $1`, [id1]);
  check("…the cost typed at the raise is still the bill, because the close only filled the gaps",
    c1closed.rows[0]?.status === "returned" && n(c1closed.rows[0]?.odometer_out_km) === 50600
    && c1closed.rows[0]?.invoice_ref === "WS-inhouse-11"
    && c1closed.rows[0]?.returned_by === uid.wsm && n(c1closed.rows[0]?.parts_cost) === 240000,
    c1closed.rows[0]);
  const journalClose = await oi(
    `select title, detail, odometer_km from vessel_log_entries where tenant_id = $1
       and vessel_id = $2 and title like $3`, [T, V1, `Work order ${ref1} closed%`]);
  check("…the diary carries the way out too, with the closing reading and the clerk's reason",
    journalClose.rowCount === 1 && /Back on the road/.test(String(journalClose.rows[0]?.detail ?? ""))
    && /corridor test/.test(String(journalClose.rows[0]?.detail ?? ""))
    && n(journalClose.rows[0]?.odometer_km) === 50600, journalClose.rows[0]);
  const auditReturn = await oi(
    `select "before"->>'vessel_odometer_km' as was, "after"->>'odometer_out_km' as now_,
            "after"->>'roadworthy' as roadworthy, "after"->>'note' as note
       from audit_logs where tenant_id = $1 and entity = 'work_orders'
         and action = 'work_order.returned' and entity_id = $2`, [T, id1]);
  check("…the audit line holds the reading the plate came in with and the one it left with",
    auditReturn.rows[0]?.was === "50000" && auditReturn.rows[0]?.now_ === "50600"
    && auditReturn.rows[0]?.roadworthy === "true" && /corridor test/.test(String(auditReturn.rows[0]?.note ?? "")),
    auditReturn.rows[0]);

  const reEdit = await call(`/work-orders/${id1}`, tok.wsm, {
    method: "PUT",
    body: JSON.stringify({ raisedOn: TODAY, title: "Rewriting a closed card", kind: "service", place: "in_house", mechanicEmployeeId: MK })
  });
  check("a closed card is not rewritten through the door either",
    refusedAs(reEdit, 409, "CONFLICT", /already returned/), { status: reEdit.status, message: msg(reEdit) });
  const reReturn = await call(`/work-orders/${id1}/return`, tok.wsm, {
    method: "POST", body: JSON.stringify({ odometerOutKm: 60000 })
  });
  check("…nor reopened by a second close",
    refusedAs(reReturn, 409, "CONFLICT", /not reopened/), { status: reReturn.status, message: msg(reReturn) });
  const reCancel = await call(`/work-orders/${id1}/cancel`, tok.wsm, {
    method: "POST", body: JSON.stringify({ reason: "Closing it twice" })
  });
  check("…nor called off after it was returned",
    refusedAs(reCancel, 409, "CONFLICT", /already returned/), { status: reCancel.status, message: msg(reCancel) });
  const diaryCount = await oi(
    `select count(*)::int as n from vessel_log_entries where tenant_id = $1 and vessel_id = $2
       and title like 'Work order % closed%'`, [T, V1]);
  check("…and the refusals wrote nothing into the diary", diaryCount.rows[0].n === 1, diaryCount.rows[0]);
  const v1unchanged = await oi(`select odometer_km from vessels where id = $1`, [V1]);
  check("…nor walked the plate's reading on to 60,000 km",
    n(v1unchanged.rows[0]?.odometer_km) === 50600, v1unchanged.rows[0]);

  // =========================================================================
  console.log("\n--- 4 · a garage bill, and a workshop that will not sign the truck off ---");
  // =========================================================================

  const C2 = await card("wsm", {
    vesselId: V2, raisedOn: TODAY, title: "Gearbox overhaul", kind: "repair",
    place: "outside_garage", garageName: GARAGE, garageReference: "INV-77",
    odometerInKm: 80000, partsCost: 400, labourCost: 250, currency: "USD"
  });
  const id2 = C2.json?.id as string;
  const ref2 = C2.json?.ref as string;
  check("a job sent outside is filed with the garage's name and its bill number",
    C2.status === 201 && C2.json?.garage_name === GARAGE && C2.json?.currency === "USD",
    { status: C2.status, json: C2.json });
  const held2 = await oi(
    `select place, garage_name, garage_reference, mechanic_employee_id, currency,
            parts_cost + labour_cost + other_cost as total
       from work_orders where id = $1`, [id2]);
  check("…no mechanic, and a bill totalling exactly what was typed",
    held2.rows[0]?.place === "outside_garage" && held2.rows[0]?.mechanic_employee_id === null
    && held2.rows[0]?.garage_reference === "INV-77" && n(held2.rows[0]?.total) === 650,
    held2.rows[0]);

  const inHouseWithGarageRef = await call(`/work-orders/${id2}`, tok.wsm, {
    method: "PUT",
    body: JSON.stringify({ raisedOn: TODAY, title: "Gearbox overhaul", kind: "repair", place: "in_house", mechanicEmployeeId: MK, garageReference: "INV-77" })
  });
  check("a garage's job number cannot be carried onto an in-house card — the register's own guard says so",
    inHouseWithGarageRef.status >= 400
    && (/belongs to a job sent to a garage/.test(msg(inHouseWithGarageRef))
        || inHouseWithGarageRef.status === 500),
    { status: inHouseWithGarageRef.status, message: msg(inHouseWithGarageRef) });
  const stillOutside = await oi(`select place, garage_name from work_orders where id = $1`, [id2]);
  check("…and the card that was refused is still the honest one",
    stillOutside.rows[0]?.place === "outside_garage" && stillOutside.rows[0]?.garage_name === GARAGE,
    stillOutside.rows[0]);

  const awaitParts = await call(`/work-orders/${id2}/workshop`, tok.wsm, {
    method: "POST", body: JSON.stringify({ status: "awaiting_parts", note: "Clutch set is on order from the Nairobi agent" })
  });
  check("a card held for parts says so, and parks the plate",
    awaitParts.status === 200 && awaitParts.json?.row?.status === "awaiting_parts"
    && awaitParts.json?.vesselMoved === true, { status: awaitParts.status, json: awaitParts.json });
  const journalAwait = await oi(
    `select detail from vessel_log_entries where tenant_id = $1 and vessel_id = $2
       and title like $3`, [T, V2, `Work order ${ref2}: held for parts%`]);
  check("…the parts shelf is written into the plate's diary with the reason",
    journalAwait.rowCount === 1 && /Nairobi agent/.test(String(journalAwait.rows[0]?.detail ?? "")),
    journalAwait.rows[0]);

  const stuck = await call(`/work-orders/${id2}/return`, tok.flm, {
    method: "POST",
    body: JSON.stringify({ odometerOutKm: 80000, roadworthy: false, otherCost: 40, note: "Second input shaft bearing is still noisy" })
  });
  check("a workshop that will not sign a truck off leaves it out of service",
    stuck.status === 200 && stuck.json?.status === "returned"
    && stuck.json?.vessel_status === "out_of_service" && stuck.json?.vessel_status_changed === true
    && stuck.json?.vessel_odometer_updated === false, { status: stuck.status, json: stuck.json });
  const V2after = await oi(`select status, status_reason, odometer_km from vessels where id = $1`, [V2]);
  check("…its reason carries the card's own verdict and its reading stayed where it was",
    V2after.rows[0]?.status === "out_of_service"
    && /unroadworthy/.test(String(V2after.rows[0]?.status_reason ?? ""))
    && /still noisy/.test(String(V2after.rows[0]?.status_reason ?? ""))
    && n(V2after.rows[0]?.odometer_km) === 80000, V2after.rows[0]);
  const c2 = await oi(
    `select status, other_cost, parts_cost, currency, invoice_ref from work_orders where id = $1`, [id2]);
  check("…the extra charge written at the close landed on the card in its own currency",
    c2.rows[0]?.status === "returned" && n(c2.rows[0]?.other_cost) === 40
    && c2.rows[0]?.currency === "USD" && c2.rows[0]?.invoice_ref === null, c2.rows[0]);
  const journalUnroadworthy = await oi(
    `select detail from vessel_log_entries where tenant_id = $1 and vessel_id = $2
       and title like $3`, [T, V2, `Work order ${ref2} closed%`]);
  check("…the diary says the truck was left in the workshop, not handed back",
    /Left in the workshop as unroadworthy/.test(String(journalUnroadworthy.rows[0]?.detail ?? "")),
    journalUnroadworthy.rows[0]);

  // =========================================================================
  console.log("\n--- 5 · a truck somebody has hired is not in a workshop ---");
  // =========================================================================

  const C3 = await card("wsm", {
    vesselId: V3, raisedOn: TODAY, title: "Tyre rotation and brake check", kind: "tyre",
    place: "in_house", mechanicEmployeeId: MK2, odometerInKm: 12000
  });
  const id3 = C3.json?.id as string;
  const ref3 = C3.json?.ref as string;
  check("a card can be raised on a plate that is out on hire — the paper is a request",
    C3.status === 201, { status: C3.status, json: C3.json });

  const onAssignment = await call(`/work-orders/${id3}/workshop`, tok.wsm, {
    method: "POST", body: JSON.stringify({ status: "in_workshop" })
  });
  check("…but it cannot take the vehicle while a handover is open",
    refusedAs(onAssignment, 409, "VESSEL_ON_ASSIGNMENT", /End the handover/),
    { status: onAssignment.status, message: msg(onAssignment) });
  check("…the refusal names the driver holding it and prints no identifier of theirs",
    msg(onAssignment).includes(DRIVER_NAME)
    && !/nida|phone/i.test(msg(onAssignment)) && !msg(onAssignment).includes(PII),
    msg(onAssignment));
  const v3status = await oi(`select status, status_reason from vessels where id = $1`, [V3]);
  check("…the assignment register and the card still agree, because the plate never moved",
    v3status.rows[0]?.status === "standby" && v3status.rows[0]?.status_reason === null,
    v3status.rows[0]);
  const noStamp = await oi(`select status, opened_at from work_orders where id = $1`, [id3]);
  check("…and the refused move left no opening stamp on the card",
    noStamp.rows[0]?.status === "raised" && !noStamp.rows[0]?.opened_at, noStamp.rows[0]);

  await oi(`update vessel_assignments set status = 'ended', ended_at = now(),
                 end_odometer_km = 12000 where id = $1`, [AS]);
  await oi(`update drivers set assigned_vessel_id = null, status = 'available' where id = $1`, [DR]);
  const afterRelease = await call(`/work-orders/${id3}/workshop`, tok.wsm, {
    method: "POST", body: JSON.stringify({ status: "in_workshop" })
  });
  check("end the handover and the same call goes through",
    afterRelease.status === 200 && afterRelease.json?.vesselMoved === true,
    { status: afterRelease.status, json: afterRelease.json, message: msg(afterRelease) });

  const clerkCancel = await call(`/work-orders/${id3}/cancel`, tok.aud, {
    method: "POST", body: JSON.stringify({ reason: "Typed by the wrong clerk" })
  });
  check("a view-only desk that did not write the card cannot call it off once work started",
    refusedAs(clerkCancel, 403, "FORBIDDEN", /Work has started/),
    { status: clerkCancel.status, message: msg(clerkCancel) });
  const dspCancel = await call(`/work-orders/${id3}/cancel`, tok.dsp, {
    method: "POST", body: JSON.stringify({ reason: "Dispatcher wants it gone" })
  });
  check("…nor can the desk that only reads the register",
    refusedAs(dspCancel, 403, "FORBIDDEN", /Only a seat that closes work orders/),
    { status: dspCancel.status, message: msg(dspCancel) });
  const reasonTooShort = await call(`/work-orders/${id3}/cancel`, tok.wsm, {
    method: "POST", body: JSON.stringify({ reason: "no" })
  });
  check("a call-off has to be a reason, not a shrug",
    reasonTooShort.status === 400 && field(reasonTooShort.json).includes("reason"),
    { status: reasonTooShort.status, fields: field(reasonTooShort.json) });

  const cancel3 = await call(`/work-orders/${id3}/cancel`, tok.wsm, {
    method: "POST", body: JSON.stringify({ reason: "The brake job was done at the checkpoint, not here" })
  });
  check("a closing desk calls the card off and puts the plate back on standby",
    cancel3.status === 200 && cancel3.json?.status === "cancelled"
    && cancel3.json?.vessel_released === true, { status: cancel3.status, json: cancel3.json });
  const c3 = await oi(
    `select status, cancel_reason, cancelled_by, parts_cost, labour_cost, other_cost
       from work_orders where id = $1`, [id3]);
  check("…the reason is stored with the seat that gave it, and the bill is gone",
    c3.rows[0]?.status === "cancelled" && /checkpoint/.test(String(c3.rows[0]?.cancel_reason ?? ""))
    && c3.rows[0]?.cancelled_by === uid.wsm && n(c3.rows[0]?.parts_cost) === 0
    && n(c3.rows[0]?.labour_cost) === 0, c3.rows[0]);
  const v3after = await oi(`select status, status_reason from vessels where id = $1`, [V3]);
  check("…the plate reads standby again, with the call-off as its reason",
    v3after.rows[0]?.status === "standby"
    && String(v3after.rows[0]?.status_reason ?? "").includes(ref3), v3after.rows[0]);
  const journalCancel = await oi(
    `select title, detail from vessel_log_entries where tenant_id = $1 and vessel_id = $2
       and title like $3`, [T, V3, `Work order ${ref3} called off%`]);
  check("…and the diary shows the job was called off, with the reason spelled out",
    journalCancel.rowCount === 1 && /checkpoint/.test(String(journalCancel.rows[0]?.detail ?? "")),
    journalCancel.rows[0]);

  const cancelAgain = await call(`/work-orders/${id3}/cancel`, tok.wsm, {
    method: "POST", body: JSON.stringify({ reason: "Called off twice" })
  });
  check("a called-off card cannot be called off again",
    refusedAs(cancelAgain, 409, "CONFLICT", /already cancelled/), { status: cancelAgain.status });

  // =========================================================================
  console.log("\n--- 6 · who may take back a card they wrote ---");
  // =========================================================================

  const C4 = await card("fr", {
    vesselId: V4, raisedOn: TODAY, title: "Belt replaced in error", kind: "other",
    place: "in_house", mechanicEmployeeId: MK, odometerInKm: 300000, partsCost: 60000
  });
  const id4 = C4.json?.id as string;
  const frHoldsClose = await oi(
    `select 1 as has from user_roles ur join role_permissions rp on rp.role_id = ur.role_id
      where ur.user_id = $1 and rp.permission_key = 'work_orders.close'`, [uid.fr]);
  check("the foreman seat holds view, create and edit — and deliberately not close",
    C4.status === 201 && frHoldsClose.rowCount === 0, { raise: C4.status, closeKey: !!frHoldsClose.rowCount });
  const selfCancel = await call(`/work-orders/${id4}/cancel`, tok.fr, {
    method: "POST", body: JSON.stringify({ reason: "Written against the wrong plate" })
  });
  check("its author may still call off a card that has not moved the vehicle",
    selfCancel.status === 200 && selfCancel.json?.status === "cancelled"
    && selfCancel.json?.vessel_released === false,
    { status: selfCancel.status, message: msg(selfCancel), json: selfCancel.json });
  const c4 = await oi(
    `select status, parts_cost, labour_cost, other_cost, cancel_reason from work_orders where id = $1`, [id4]);
  check("…the figure it was raised with is wiped, so the register cannot bill a job that never was",
    c4.rows[0]?.status === "cancelled" && n(c4.rows[0]?.parts_cost) === 0
    && n(c4.rows[0]?.labour_cost) === 0 && n(c4.rows[0]?.other_cost) === 0
    && /wrong plate/.test(String(c4.rows[0]?.cancel_reason ?? "")), c4.rows[0]);
  const v4afterCancel = await oi(`select status from vessels where id = $1`, [V4]);
  check("…and a card that never parked the plate leaves its state alone",
    v4afterCancel.rows[0]?.status === "standby", v4afterCancel.rows[0]);

  const C9 = await card("fr", {
    vesselId: V4, raisedOn: TODAY, title: "Another belt, mistyped", kind: "other",
    place: "in_house", mechanicEmployeeId: MK, odometerInKm: 300000, partsCost: 30000
  });
  const id9 = C9.json?.id as string;
  const notMineRaised = await call(`/work-orders/${id9}/cancel`, tok.dsp, {
    method: "POST", body: JSON.stringify({ reason: "Not my card either" })
  });
  check("a view-only desk is refused another seat's untouched card, and told it was not theirs",
    refusedAs(notMineRaised, 403, "FORBIDDEN", /written by another seat/),
    { status: notMineRaised.status, message: msg(notMineRaised) });
  const frCloses = await call(`/work-orders/${id9}/workshop`, tok.fr, {
    method: "POST", body: JSON.stringify({ status: "in_workshop" })
  });
  check("the foreman can move their own card, because that is the edit key",
    frCloses.status === 200, { status: frCloses.status, message: msg(frCloses) });
  const selfAfterMove = await call(`/work-orders/${id9}/cancel`, tok.fr, {
    method: "POST", body: JSON.stringify({ reason: "Now it has moved, so I cannot take it back" })
  });
  check("…but once the plate has moved, only a closing desk may call it off",
    refusedAs(selfAfterMove, 403, "FORBIDDEN", /Work has started/),
    { status: selfAfterMove.status, message: msg(selfAfterMove) });
  const v4moved = await oi(`select status from vessels where id = $1`, [V4]);
  check("…the plate stayed parked while the refusal was answered",
    v4moved.rows[0]?.status === "in_garage", v4moved.rows[0]);
  const dirCancels = await call(`/work-orders/${id9}/cancel`, tok.dir, {
    method: "POST", body: JSON.stringify({ reason: "Mistyped twice, filed as nothing" })
  });
  check("a director with the closing key ends it and releases the plate",
    dirCancels.status === 200 && dirCancels.json?.vessel_released === true,
    { status: dirCancels.status, json: dirCancels.json });

  const C5 = await card("wsm", {
    vesselId: V5, raisedOn: TODAY, title: "Clutch slip investigated", kind: "repair",
    place: "in_house", mechanicEmployeeId: MK, odometerInKm: 60000, labourCost: 40000
  });
  const id5 = C5.json?.id as string;
  const C6 = await card("wsm", {
    vesselId: V5, raisedOn: TODAY, title: "Second: radiator flush", kind: "service",
    place: "in_house", mechanicEmployeeId: MK2, odometerInKm: 60000
  });
  const id6 = C6.json?.id as string;
  const ref6 = C6.json?.ref as string;
  await call(`/work-orders/${id5}/workshop`, tok.wsm, { method: "POST", body: JSON.stringify({ status: "in_workshop" }) });
  await call(`/work-orders/${id6}/workshop`, tok.wsm, { method: "POST", body: JSON.stringify({ status: "awaiting_parts" }) });
  const v5held = await oi(`select status from vessels where id = $1`, [V5]);
  check("two cards now hold one plate in the workshop",
    v5held.rows[0]?.status === "in_garage", v5held.rows[0]);
  const cancel5 = await call(`/work-orders/${id5}/cancel`, tok.wsm, {
    method: "POST", body: JSON.stringify({ reason: "Duplicated the clutch job already open on it" })
  });
  check("cancelling one of them releases nothing, because the other still has the truck",
    cancel5.status === 200 && cancel5.json?.vessel_released === false,
    { status: cancel5.status, json: cancel5.json });
  const v5still = await oi(`select status from vessels where id = $1`, [V5]);
  check("…the plate stays parked until the last card on it is closed",
    v5still.rows[0]?.status === "in_garage", v5still.rows[0]);

  const dspRaise = await card("dsp", {
    vesselId: V4, raisedOn: TODAY, title: "Nothing", kind: "service", place: "in_house", mechanicEmployeeId: MK
  });
  check("the dispatcher cannot raise a card even by accident",
    refusedAs(dspRaise, 403, "FORBIDDEN"), dspRaise.status);

  // =========================================================================
  console.log("\n--- 7 · a close that must not move a plate somebody else parked ---");
  // =========================================================================

  const C8 = await card("wsm", {
    vesselId: V4, raisedOn: TODAY, title: "Coolant hose split", kind: "repair",
    place: "in_house", mechanicEmployeeId: MK, odometerInKm: 300000
  });
  const id8 = C8.json?.id as string;
  await oi(`update vessels set status = 'on_route' where id = $1`, [V4]);
  const closeOnRoute = await call(`/work-orders/${id8}/return`, tok.wsm, {
    method: "POST", body: JSON.stringify({ odometerOutKm: 300120, roadworthy: true })
  });
  check("closing a card does not pull a truck off a route it has since gone out on",
    closeOnRoute.status === 200 && closeOnRoute.json?.vessel_status_changed === false,
    { status: closeOnRoute.status, json: closeOnRoute.json });
  const v4route = await oi(`select status, odometer_km from vessels where id = $1`, [V4]);
  check("…its state stays on_route while its reading still moves forward",
    v4route.rows[0]?.status === "on_route" && n(v4route.rows[0]?.odometer_km) === 300120,
    v4route.rows[0]);

  // =========================================================================
  console.log("\n--- 8 · the register, read by the desks that may read it ---");
  // =========================================================================

  const asWsm = await call("/work-orders", tok.wsm, { method: "GET" });
  const list = asWsm.json as any[];
  check("the workshop desk sees every card this company has",
    asWsm.status === 200 && Array.isArray(list) && list.length === 8,
    { status: asWsm.status, length: Array.isArray(list) ? list.length : null, body: list?.[0] });
  const closedRow = list.find((r) => r.id === id1);
  check("…with the reference, the plate, the mechanic's name and the total on each row",
    closedRow?.ref === ref1 && closedRow?.plate_number === `WSA${STAMP}1`
    && closedRow?.mechanic_name === MECH_NAME && n(closedRow?.total_cost) === 345000, closedRow);
  check("…and the vehicle's own state comes back beside the card, not guessed from it",
    closedRow?.vessel_status === "standby" && n(closedRow?.vessel_odometer_km) === 50600, closedRow);
  check("…a returned card offers no buttons and says why",
    closedRow?.can_edit === false && closedRow?.can_move === false
    && closedRow?.can_return === false && closedRow?.can_cancel === false
    && closedRow?.close_block === "returned" && closedRow?.cancel_block === "closed", closedRow);
  const openRow = list.find((r) => r.id === id6);
  check("…the one card still open, written by this seat, offers all four",
    openRow?.can_edit === true && openRow?.can_move === true && openRow?.can_return === true
    && openRow?.can_cancel === true && openRow?.close_block === null
    && openRow?.cancel_block === null, openRow);
  const openOrder = list.map((r) => r.status);
  check("…the register leads with what the workshop still has, and ends with history",
    openOrder.findIndex((s) => s === "returned") > openOrder.lastIndexOf("awaiting_parts"),
    openOrder);
  const frRow = (await call("/work-orders?status=cancelled", tok.fr, { method: "GET" })).json as any[];
  const mineFringe = frRow.find((r) => r.id === id9);
  check("a foreman who wrote a card but holds no closing key is offered nothing on it once closed",
    mineFringe?.can_cancel === false && mineFringe?.can_return === false
    && mineFringe?.close_block === "cancelled" && mineFringe?.cancel_block === "closed", mineFringe);
  const cancelledRow = list.find((r) => r.id === id5);
  check("…a called-off card reports zero cost, whatever it was raised with",
    n(cancelledRow?.total_cost) === 0 && cancelledRow?.cancel_reason
    && cancelledRow?.cancelled_by_name === "Amina Ya Keragi", cancelledRow);

  const asAud = await call("/work-orders", tok.aud, { method: "GET" });
  const audList = asAud.json as any[];
  check("a view-only desk sees the same rows and is offered no buttons at all",
    asAud.status === 200 && audList.length === list.length
    && audList.every((r) => r.can_edit === false && r.can_move === false
      && r.can_return === false && r.can_cancel === false),
    { length: audList.length, first: audList[0] });
  const audOpen = audList.find((r) => r.id === id6);
  check("…and the refusal it is given says the reason is the missing key, not a closed card",
    audOpen?.close_block === "no_key" && audOpen?.cancel_block === "no_key", audOpen);

  const noPii = JSON.stringify(asAud.json).toLowerCase();
  check("the register prints no identifier a screen does not need",
    !noPii.includes("nida") && !noPii.includes("phone_encrypted")
    && !noPii.includes(PII.toLowerCase()), noPii.slice(0, 120));

  const onlyOpen = await call("/work-orders?status=open", tok.wsm, { method: "GET" });
  check("the open filter answers only cards still in the workshop",
    onlyOpen.status === 200 && (onlyOpen.json as any[]).length === 1
    && (onlyOpen.json as any[]).every((r) =>
      ["raised", "in_workshop", "awaiting_parts"].includes(r.status)),
    (onlyOpen.json as any[]).map((r) => ({ ref: r.ref, status: r.status })));
  const onlyCancelled = await call("/work-orders?status=cancelled", tok.wsm, { method: "GET" });
  check("…and a single state reads exactly that state",
    (onlyCancelled.json as any[]).length === 4
    && (onlyCancelled.json as any[]).every((r) => r.status === "cancelled"),
    (onlyCancelled.json as any[]).map((r) => r.ref));
  const onePlate = await call(`/work-orders?vesselId=${V1}`, tok.wsm, { method: "GET" });
  check("a plate's own cards can be pulled out of the register",
    onePlate.status === 200 && (onePlate.json as any[]).length === 1
    && (onePlate.json as any[])[0]?.id === id1, (onePlate.json as any[]).map((r) => r.ref));
  const outside = await call("/work-orders?place=outside_garage", tok.wsm, { method: "GET" });
  check("…so can the jobs that went to a garage",
    (outside.json as any[]).length === 1 && (outside.json as any[])[0]?.id === id2,
    (outside.json as any[]).map((r) => r.ref));
  const byGarage = await call(`/work-orders?q=${encodeURIComponent("Diesel Works")}`, tok.wsm, { method: "GET" });
  check("search finds a card by the garage's name, not only by its number",
    (byGarage.json as any[]).some((r) => r.id === id2), (byGarage.json as any[]).map((r) => r.ref));
  const byRef = await call(`/work-orders?q=${ref1}`, tok.dsp, { method: "GET" });
  check("…a dispatcher can find the card they were quoted over the phone",
    (byRef.json as any[]).length === 1 && (byRef.json as any[])[0]?.ref === ref1,
    (byRef.json as any[]).map((r) => r.ref));
  const byWord = await call("/work-orders?q=radiator", tok.wsm, { method: "GET" });
  check("…and by a word of the job, which is what a clerk actually remembers",
    (byWord.json as any[]).length === 1 && (byWord.json as any[])[0]?.id === id6,
    (byWord.json as any[]).map((r) => r.ref));
  const byDay = await call(`/work-orders?from=${shift(TODAY, -1)}&to=${TODAY}`, tok.wsm, { method: "GET" });
  check("a date window keeps last month's cards out and today's in",
    byDay.status === 200 && (byDay.json as any[]).length === list.length,
    { window: (byDay.json as any[])?.length, all: list.length });
  const noneDay = await call(`/work-orders?from=${shift(TODAY, 1)}`, tok.wsm, { method: "GET" });
  check("…a window that starts tomorrow answers nothing rather than everything",
    noneDay.status === 200 && (noneDay.json as any[]).length === 0,
    (noneDay.json as any[])?.length);
  const page1 = await call("/work-orders?limit=3&offset=0", tok.wsm, { method: "GET" });
  const page2 = await call("/work-orders?limit=3&offset=3", tok.wsm, { method: "GET" });
  const walked = new Set([...(page1.json as any[]).map((r) => r.id),
    ...(page2.json as any[]).map((r) => r.id)]);
  check("…and paging walks the register without repeating a card",
    page1.status === 200 && (page1.json as any[]).length === 3
    && (page2.json as any[]).length === 3 && walked.size === 6, walked.size);
  const badFilter = await call("/work-orders?status=nonsense", tok.wsm, { method: "GET" });
  check("a state the register does not have is refused, not ignored",
    badFilter.status === 400, { status: badFilter.status });
  const badUuid = await call("/work-orders?vesselId=not-a-plate", tok.wsm, { method: "GET" });
  check("…so is a plate that is not an id", badUuid.status === 400, badUuid.status);

  // =========================================================================
  console.log("\n--- 9 · who can hold a wrench ---");
  // =========================================================================

  const mechanics = await call("/work-orders/mechanics", tok.aud, { method: "GET" });
  const mlist = mechanics.json as any[];
  check("the picker answers the workshop's own key, so a view-only desk can open it",
    mechanics.status === 200 && mlist.length === 2, { status: mechanics.status, length: mlist.length });
  const foreman = mlist.find((m) => m.id === MK);
  const beater = mlist.find((m) => m.id === MK2);
  check("…naming the staff record and its trade",
    foreman?.full_name === MECH_NAME && foreman?.job_title === "Workshop foreman"
    && foreman?.department === "Workshop" && foreman?.status === "active", foreman);
  check("…and how many cards each pair of hands is holding right now",
    n(foreman?.open_cards) === 0 && n(beater?.open_cards) === 1,
    { foreman: foreman?.open_cards, beater: beater?.open_cards });
  const keys = Object.keys(mlist[0] ?? {}).sort().join(",");
  check("…and nothing else — no salary, no contract, no contact details",
    keys === "department,full_name,id,job_title,open_cards,status", keys);
  const drvMech = await call("/work-orders/mechanics", tok.drv, { method: "GET" });
  check("a seat with no workshop key is refused the staff list",
    refusedAs(drvMech, 403, "FORBIDDEN"), drvMech.status);
  const neighbourMechs = await call("/work-orders/mechanics", tok.dir2, { method: "GET" });
  check("…and another company's desk is told about its own staff only",
    (neighbourMechs.json as any[]).length === 1
    && (neighbourMechs.json as any[]).every((m) => m.full_name !== MECH_NAME
      && m.full_name !== MECH2_NAME), neighbourMechs.json);

  // =========================================================================
  console.log("\n--- 10 · what the workshop is costing ---");
  // =========================================================================

  const summary = await call("/work-orders/summary", tok.flm, { method: "GET" });
  const s = summary.json as any;
  check("the rollups answer the read key, not a money one",
    summary.status === 200 && Array.isArray(s?.perVessel), summary.status);
  const exact = await oi(
    `select (select count(*) from work_orders where tenant_id = $1 and deleted_at is null
              and raised_on >= current_date - 365) as orders,
            (select count(*) from work_orders where tenant_id = $1 and deleted_at is null
              and status in ('raised','in_workshop','awaiting_parts')
              and raised_on >= current_date - 365) as open,
            (select count(*) from work_orders where tenant_id = $1 and deleted_at is null
              and status = 'cancelled' and raised_on >= current_date - 365) as cancelled,
            -- A called-off card is a card, so it belongs in the counts. It is only the money that
            -- it cannot touch — and that is 109's trigger talking, not this desk's opinion.
            (select count(*) from work_orders where tenant_id = $1 and deleted_at is null
              and currency = 'TZS' and raised_on >= current_date - 365) as tzs_cards,
            (select coalesce(sum(parts_cost + labour_cost + other_cost), 0)
               from work_orders where tenant_id = $1 and deleted_at is null
                 and status <> 'cancelled' and currency = 'TZS') as tzs,
            (select coalesce(sum(parts_cost + labour_cost + other_cost), 0)
               from work_orders where tenant_id = $1 and deleted_at is null
                 and status <> 'cancelled' and currency = 'USD') as usd,
            (select count(*) from work_orders where tenant_id = $1 and deleted_at is null
              and kind = 'tyre' and raised_on >= current_date - 365) as tyre_cards,
            (select count(*) from work_orders where tenant_id = $1 and deleted_at is null
              and kind = 'repair' and raised_on >= current_date - 365) as repair_cards,
            (select count(*) from work_orders where tenant_id = $1 and deleted_at is null
              and coalesce(garage_name, 'in house') = 'in house'
              and status in ('returned','cancelled') and raised_on >= current_date - 365) as house_cards,
            (select count(*) from work_orders where tenant_id = $1 and deleted_at is null
              and parts_cost + labour_cost + other_cost > 0 and status = 'cancelled') as cancelled_with_a_bill`,
    [T]);
  const ex = exact.rows[0];
  check("…the register's own counts come back whole, and the called-off ones are named",
    n(s?.totals?.orders) === n(ex.orders) && n(s?.totals?.open) === n(ex.open)
    && n(s?.totals?.cancelled) === n(ex.cancelled),
    { api: s?.totals, sql: ex });
  check("…and a cancelled card never carries a bill, so counting it cannot move the money",
    n(ex["cancelled_with_a_bill"]) === 0, ex["cancelled_with_a_bill"]);
  check("…the money is never added across currencies, and says which two are on file",
    JSON.stringify(s?.totals?.currencies) === JSON.stringify(["TZS", "USD"])
    && (s?.byCurrency ?? []).length === 2
    && n(s?.byCurrency?.[0]?.total) === n(ex.tzs) && n(s?.byCurrency?.[1]?.total) === n(ex.usd),
    { currencies: s?.totals?.currencies, byCurrency: s?.byCurrency, sql: ex });
  const tzsRow = (s?.byCurrency ?? []).find((r: any) => r.currency === "TZS");
  check("…broken into parts, labour and other, so a runaway line is findable",
    n(tzsRow?.parts) === 240000 && n(tzsRow?.labour) === 90000 && n(tzsRow?.other) === 15000
    && n(tzsRow?.orders) === n(ex.tzs_cards), tzsRow);
  const pv = (s?.perVessel ?? []).find((r: any) => r.vessel_id === V1);
  check("a plate's own figure counts the visit that ended, and none of the cards called off",
    pv?.returned_orders === 1 && n(pv?.spent) === 345000 && n(pv?.open_orders) === 0, pv);
  const pvTwo = (s?.perVessel ?? []).find((r: any) => r.vessel_id === V5);
  check("…a plate standing in the workshop is listed with its open card and nothing spent yet",
    n(pvTwo?.open_orders) === 1 && n(pvTwo?.returned_orders) === 0 && n(pvTwo?.spent) === 0
    && pvTwo?.vessel_status === "in_garage", pvTwo);
  const pvCancelled = (s?.perVessel ?? []).find((r: any) => r.vessel_id === V3);
  check("…and a cancelled card leaves the plate in the list with nothing spent on it",
    n(pvCancelled?.open_orders) === 0 && n(pvCancelled?.spent) === 0, pvCancelled);
  const garageRow = (s?.perGarage ?? []).find((r: any) => r.garage === GARAGE);
  check("the garage's own line is its finished jobs and their bill",
    garageRow?.orders === 1 && n(garageRow?.cost) === 690, garageRow);
  const pgHouse = (s?.perGarage ?? []).find((r: any) => r.garage === "in house");
  check("…and everything done in house is counted as one workshop, not as nobody",
    n(pgHouse?.orders ?? -1) === n(ex.house_cards) && n(pgHouse?.cost) === 345000,
    { api: pgHouse, sql: ex.house_cards });
  const kindTyre = (s?.perKind ?? []).find((r: any) => r.kind === "tyre");
  check("…the tyre job that was called off is in the kind list at zero — a card was raised, no bill was",
    !!kindTyre && n(kindTyre?.cost) === 0 && n(kindTyre?.orders) === n(ex.tyre_cards),
    { tyre: kindTyre, sql_tyre_cards: ex.tyre_cards });
  const kindRepair = (s?.perKind ?? []).find((r: any) => r.kind === "repair");
  check("…and a kind totals the bills of the cards that had one, whatever it was called off as",
    n(kindRepair?.orders) === n(ex.repair_cards) && n(kindRepair?.cost) === 690,
    { repair: kindRepair, sql_repair_cards: ex.repair_cards });

  // The window is only worth a control on the desk if every figure in the panel obeys it, and the
  // fixture raises every card today. A closed row cannot be re-dated — that is 109's own rule — so
  // the test files a card of its own from before a year began, reads the panel on both sides of
  // that date, then deletes the card it made.
  const oldId = crypto.randomUUID();
  const filed = await oi(
    `insert into work_orders (id, tenant_id, vessel_id, ref, raised_on, title, kind, place,
               garage_name, status, odometer_in_km, odometer_out_km, parts_cost, labour_cost,
               currency, opened_at, opened_by, returned_at, returned_by, created_by)
         values ($1,$2,$3,$6, (current_date - 400),
               'Old visit, filed by the window test', 'repair', 'outside_garage',
               $4, 'returned', 100000, 100500, 100, 50, 'USD',
               now(), $5, now(), $5, $5)`,
    [oldId, T, V2, GARAGE, uid.wsm, `WO-2024-${STAMP}`]);
  check("…the card the window test filed is in the register", n(filed.rowCount) === 1, filed.rowCount);
  const wide = await call("/work-orders/summary?days=730", tok.flm, { method: "GET" });
  const tight = await call("/work-orders/summary?days=365", tok.flm, { method: "GET" });
  const w = wide.json as any, t = tight.json as any;
  const wGarage = (w?.perGarage ?? []).find((g: any) => g.garage === GARAGE);
  check("a window of two years takes in the old visit, in the counts and in all three rollups",
    wide.status === 200 && n(w?.totals?.orders) === n(ex.orders) + 1
    && n(wGarage?.orders) === 2 && n(wGarage?.cost) === 840
    && n((w?.perKind ?? []).find((k: any) => k.kind === "repair")?.orders) === n(ex.repair_cards) + 1
    && n((w?.byCurrency ?? []).find((r: any) => r.currency === "USD")?.total) === n(ex.usd) + 150,
    { totals: w?.totals, garage: wGarage, kinds: w?.perKind, money: w?.byCurrency });
  check("…and a window of one year leaves it out of every one of them, not just the money",
    tight.status === 200 && n(t?.totals?.orders) === n(ex.orders)
    && n((t?.perGarage ?? []).find((g: any) => g.garage === GARAGE)?.orders) === 1
    && n((t?.perGarage ?? []).find((g: any) => g.garage === GARAGE)?.cost) === 690
    && n((t?.perKind ?? []).find((k: any) => k.kind === "repair")?.orders) === n(ex.repair_cards)
    && n((t?.byCurrency ?? []).find((r: any) => r.currency === "USD")?.total) === n(ex.usd)
    && JSON.stringify(t?.byCurrency) === JSON.stringify(s?.byCurrency),
    { totals: t?.totals, garage: t?.perGarage, money: t?.byCurrency });
  const buried = await oi(`delete from work_orders where id = $1 and tenant_id = $2`, [oldId, T]);
  check("…the card the window test filed is taken back out again", n(buried.rowCount) === 1,
    buried.rowCount);
  const win = await call("/work-orders/summary?days=30", tok.flm, { method: "GET" });
  check("the window is the caller's, and travels with the answer",
    win.status === 200 && win.json?.window_days === 30, win.json?.window_days);
  const badWin = await call("/work-orders/summary?days=7", tok.flm, { method: "GET" });
  check("…a window shorter than the register is refused rather than quietly widened",
    badWin.status === 400, badWin.status);
  const audSum = await call("/work-orders/summary", tok.aud, { method: "GET" });
  check("the auditor reads the same rollups, because the money is read by the desks that pay it",
    audSum.status === 200 && JSON.stringify(audSum.json?.byCurrency) === JSON.stringify(s?.byCurrency),
    { status: audSum.status, aud: audSum.json?.byCurrency });

  // =========================================================================
  console.log("\n--- 11 · the garage's bill, filed with the job it bills ---");
  // =========================================================================

  const fd = new FormData();
  fd.append("entityType", "work_order");
  fd.append("entityId", id2);
  fd.append("kind", "invoice");
  fd.append("file", new Blob([pdf("gearbox invoice")], { type: "application/pdf" }), "kigamboni-invoice.pdf");
  const up = await call("/documents", tok.upl, { method: "POST", body: fd });
  if (up.status === 503) {
    console.log("note  this API has no file store configured, so the paper half below has nothing to",
      "read back — the register's own attachment count is still checked.");
  }
  check("a garage invoice files against the card it bills",
    up.status === 201 && !!up.json?.id, { status: up.status, message: msg(up) });
  const docRow = up.status === 201 ? (await oi(
    `select entity_type, entity_id, kind, file_name, size_bytes from documents where id = $1`,
    [up.json.id])).rows[0] : null;
  check("…as this company's paper, on the work order and nowhere else",
    up.status !== 201 || (!!docRow && docRow.entity_type === "work_order" && docRow.entity_id === id2
      && docRow.kind === "invoice" && docRow.file_name === "kigamboni-invoice.pdf"), docRow);
  const listed = await call(`/documents?entityType=work_order&entityId=${id2}`, tok.aud, { method: "GET" });
  check("the desk reads it back from the vault by the card's id",
    listed.status === 200 && (listed.json as any[]).length === (up.status === 201 ? 1 : 0)
    && (up.status !== 201 || (listed.json as any[])[0]?.file_name === "kigamboni-invoice.pdf"),
    { status: listed.status, json: listed.json });
  const countOnCard = await call("/work-orders?place=outside_garage", tok.wsm, { method: "GET" });
  check("…and the register says how much paper each card carries",
    (countOnCard.json as any[])?.[0]?.attachments === (up.status === 201 ? 1 : 0),
    (countOnCard.json as any[])?.[0]?.attachments);
  const strayFd = new FormData();
  strayFd.append("entityType", "work_order");
  strayFd.append("entityId", crypto.randomUUID());
  strayFd.append("kind", "invoice");
  strayFd.append("file", new Blob([pdf("nothing")], { type: "application/pdf" }), "stray.pdf");
  const strayRes = await call("/documents", tok.upl, { method: "POST", body: strayFd });
  check("a bill cannot be filed against a card that does not exist",
    strayRes.status === 503 || refusedAs(strayRes, 404, "NOT_FOUND"),
    { status: strayRes.status, json: strayRes.json });
  const foreignDoc = await call(`/documents?entityType=work_order&entityId=${id2}`, tok.dir2, { method: "GET" });
  check("…and a neighbour asking for that card's paper is answered with none",
    foreignDoc.status === 200 && (foreignDoc.json as any[]).length === 0, foreignDoc.json);

  // =========================================================================
  console.log("\n--- 12 · the neighbour ---");
  // =========================================================================

  // Their own workshop, their own paper: without a card of theirs in the register, every "their
  // register is empty" assertion below would pass on a company that has no fleet at all.
  const theirCard = await card("dir2", {
    vesselId: V0, raisedOn: TODAY, title: "Stranger oil service", kind: "service",
    place: "in_house", mechanicEmployeeId: MK0, odometerInKm: 9000, partsCost: 25000
  });
  const theirId = theirCard.json?.id as string;
  check("the same doors open for a second company, in its own words",
    theirCard.status === 201 && theirCard.json?.tenant === undefined, theirCard.status);
  const theirCancel = await call(`/work-orders/${theirId}/cancel`, tok.dir2, {
    method: "POST", body: JSON.stringify({ reason: "Written by the wrong desk" })
  });
  check("…and their own seat closes their own card without touching ours",
    theirCancel.status === 200 && theirCancel.json?.vessel_released === false,
    { status: theirCancel.status, message: msg(theirCancel) });

  const neighbourList = await call("/work-orders", tok.dir2, { method: "GET" });
  check("a director of another company reads their own register, not this one's",
    neighbourList.status === 200 && (neighbourList.json as any[]).length === 1
    && (neighbourList.json as any[])[0]?.plate_number === `WSB${STAMP}0`,
    { status: neighbourList.status, json: neighbourList.json });
  const neighbourText = JSON.stringify(neighbourList.json);
  check("…and none of our card numbers are in it",
    ![ref1, ref2, ref3, ref6].some((ref) => neighbourText.includes(String(ref))),
    neighbourText.slice(0, 200));
  const neighbourSum = await call("/work-orders/summary", tok.dir2, { method: "GET" });
  // Their single card was called off, so it belongs in the count and in none of the money. The
  // point of this check is isolation, not emptiness: a rollup of zero cards would be a different
  // wrong, because the register immediately above lists this one.
  check("…their rollups hold their own one called-off card, at no cost, and nothing of ours",
    neighbourSum.status === 200 && n(neighbourSum.json?.totals?.orders) === 1
    && n(neighbourSum.json?.totals?.open) === 0 && n(neighbourSum.json?.totals?.cancelled) === 1
    && (neighbourSum.json?.byCurrency ?? []).every((r: any) => n(r.total) === 0)
    && (neighbourSum.json?.perVessel ?? []).length === 1
    && (neighbourSum.json?.perVessel ?? []).every((r: any) => r.plate_number === `WSB${STAMP}0`
      && n(r.spent) === 0)
    && (neighbourSum.json?.perGarage ?? []).every((g: any) => g.garage !== GARAGE && n(g.cost) === 0),
    neighbourSum.json);

  for (const [label, path, init] of [
    ["edit", `/${id1}`, { method: "PUT", body: JSON.stringify({ raisedOn: TODAY, title: "Stolen correction", kind: "service", place: "in_house", mechanicEmployeeId: MK0 }) }],
    ["move", `/${id6}/workshop`, { method: "POST", body: JSON.stringify({ status: "in_workshop" }) }],
    ["close", `/${id6}/return`, { method: "POST", body: JSON.stringify({ odometerOutKm: 60100 }) }],
    ["cancel", `/${id6}/cancel`, { method: "POST", body: JSON.stringify({ reason: "Not my truck" }) }]
  ] as [string, string, RequestInit][]) {
    const r = await call(`/work-orders${path}`, tok.dir2, init);
    check(`a foreign seat cannot ${label} another company's card`,
      refusedAs(r, 404, "NOT_FOUND"), { status: r.status, code: r.json?.error?.code, message: msg(r) });
  }
  const borrowedMechanic = await card("dir2", { vesselId: V0, raisedOn: TODAY, title: "Borrowed mechanic", place: "in_house", mechanicEmployeeId: MK });
  check("…nor file one of our staff records on their own card",
    refusedAs(borrowedMechanic, 400, "VALIDATION_FAILED", /not a staff record/),
    { status: borrowedMechanic.status, message: msg(borrowedMechanic) });
  const stolenVessel = await card("dir2", { vesselId: V1, raisedOn: TODAY, title: "Their plate", place: "in_house", mechanicEmployeeId: MK0 });
  check("…and a card written against our plate is answered as no plate at all",
    refusedAs(stolenVessel, 404, "NOT_FOUND"), stolenVessel.status);
  const afterIntrusion = await oi(
    `select (select title from work_orders where id = $1) as still_titled,
            (select status from work_orders where id = $2) as still_open,
            (select count(*)::int from work_orders where tenant_id = $3) as their_cards,
            (select status from vessels where id = $4) as their_plate,
            (select count(*)::int from vessel_log_entries where tenant_id = $3) as their_diary`,
    [id1, id6, T2, V0]);
  check("…the refusals changed nothing of ours and wrote nothing into their register",
    afterIntrusion.rows[0]?.still_titled === "Oil service, injector pump replaced"
    && afterIntrusion.rows[0]?.still_open === "awaiting_parts"
    && n(afterIntrusion.rows[0]?.their_cards) === 1
    && n(afterIntrusion.rows[0]?.their_diary) === 2
    && afterIntrusion.rows[0]?.their_plate === "standby", afterIntrusion.rows[0]);
  const neighbourDiary = await oi(
    `select count(*)::int as n from vessel_log_entries where tenant_id = $1 and title like 'Work order%'`, [T2]);
  check("…their plate's diary carries only their own card",
    neighbourDiary.rows[0].n === 2, neighbourDiary.rows[0]);

  // =========================================================================
  console.log("\n--- 13 · what the database itself is holding ---");
  // =========================================================================

  const auditActions = await oi(
    `select action, count(*)::int as n from audit_logs where tenant_id = $1
       and entity = 'work_orders' group by action order by action`, [T]);
  const seen = new Set(auditActions.rows.map((r: any) => r.action as string));
  for (const a of ["work_order.raised", "work_order.edited", "work_order.in_workshop",
    "work_order.awaiting_parts", "work_order.returned", "work_order.cancelled"]) {
    check(`audited ${a}`, seen.has(a), [...seen]);
  }
  const leaky = await oi(
    `select count(*)::int as n from audit_logs where tenant_id = $1
       and ("after"::text like '%' || $2 || '%' or "before"::text like '%' || $2 || '%')`, [T, PII]);
  check("no audit line in this register carries the identifier planted beside it",
    leaky.rows[0].n === 0, leaky.rows[0]);
  const paper = await oi(
    `select (select count(*)::int from work_orders where tenant_id = $1) as cards,
            (select count(*)::int from work_orders where tenant_id = $1
               and status = 'cancelled' and parts_cost + labour_cost + other_cost <> 0) as billed_off,
            -- 109's trigger demands an opening stamp for work that has started or finished. A card
            -- called off before anyone touched it never had one, so the promise is only about the
            -- cards that came back.
            (select count(*)::int from work_orders where tenant_id = $1
               and status = 'returned' and opened_at is null) as unstamped,
            (select count(*)::int from work_orders where tenant_id = $1
               and status = 'returned' and odometer_out_km is null) as unread,
            (select count(*)::int from work_orders where tenant_id = $1
               and status = 'cancelled' and coalesce(trim(cancel_reason),'') = '') as reasonless,
            (select count(*)::int from work_orders where tenant_id = $1 and place = 'in_house'
               and coalesce(garage_reference,'') <> '') as inhouse_with_billno,
            (select count(*)::int from vessel_log_entries where tenant_id = $1
               and title like 'Work order%') as journal,
            (select count(*)::int from documents where tenant_id = $1) as paper,
            (select count(*)::int from vessels where tenant_id = $1 and status = 'in_garage') as parked`,
    [T]);
  check("the register's own promises still hold row for row",
    n(paper.rows[0].cards) === 8 && paper.rows[0].billed_off === 0
    && paper.rows[0].unstamped === 0 && paper.rows[0].unread === 0
    && paper.rows[0].reasonless === 0 && paper.rows[0].inhouse_with_billno === 0
    && paper.rows[0].paper === (up.status === 201 ? 1 : 0), paper.rows[0]);
  console.log("note  this company's registers now hold:", JSON.stringify(paper.rows[0]),
    "— every one of them written through the API.");

  // =========================================================================
  console.log("\n--- teardown ---");
  // =========================================================================

  for (const tid of [T, T2]) await sweep(tid);
  const left = await oi(
    `select (select count(*)::int from work_orders where tenant_id = any($1::uuid[])) as cards,
            (select count(*)::int from documents where tenant_id = any($1::uuid[])) as paper,
            (select count(*)::int from vessel_log_entries where tenant_id = any($1::uuid[])) as diary,
            (select count(*)::int from vessel_assignments where tenant_id = any($1::uuid[])) as hands,
            (select count(*)::int from vessels where tenant_id = any($1::uuid[])) as plates,
            (select count(*)::int from drivers where tenant_id = any($1::uuid[])) as drivers,
            (select count(*)::int from employees where tenant_id = any($1::uuid[])) as staff,
            (select count(*)::int from roles where tenant_id = any($1::uuid[])) as duties,
            (select count(*)::int from users where tenant_id = any($1::uuid[])) as seats,
            (select count(*)::int from tenants where id = any($1::uuid[])) as companies`, [[T, T2]]);
  check("the fixture is gone from every register it wrote",
    Object.values(left.rows[0]).every((v) => Number(v) === 0), left.rows[0]);
  const stray = await oi(
    `select (select count(*)::int from work_orders where title ilike '%workshop smoke%'
               or detail ilike '%workshop smoke%' or invoice_ref ilike '%workshop smoke%') as cards,
            (select count(*)::int from vessel_log_entries where title ilike '%workshop smoke%'
               or detail ilike '%workshop smoke%') as diary,
            (select count(*)::int from vessels where name like '%workshop smoke%') as plates,
            (select count(*)::int from drivers where full_name like 'Kilian Smoke Held Driver%') as drivers,
            (select count(*)::int from employees where full_name like 'Kilian Smoke %Mechanic%') as staff,
            (select count(*)::int from roles where key = 'workshop_foreman') as duties,
            (select count(*)::int from users where email like '%.ws.%@example.org') as seats,
            (select count(*)::int from tenants where name ~ '^Workshop (Smoke|Stranger) [0-9]{8}$') as companies`);
  check("…and nothing this run minted is left anywhere on the database",
    Object.values(stray.rows[0]).every((v) => Number(v) === 0), stray.rows[0]);
  const kept = await oi(
    `select count(*)::int as n from audit_logs where tenant_id = any($1::uuid[])`, [[T, T2]]);
  console.log(`(audit_logs keeps ${kept.rows[0].n} rows for the swept tenants — the register is append-only)`);
  console.log("(documents' storage objects stay in the bucket after this sweep, the way every earlier smoke leaves its uploads)");

  await owner.end();
}

main().then(() => {
  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nwork order smoke passed");
}).catch((e) => { console.error(e); process.exit(1); });
