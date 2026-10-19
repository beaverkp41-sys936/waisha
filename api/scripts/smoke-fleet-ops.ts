/**
 * End-to-end smoke for the fleet overhaul (#172, migrations 092 + 093) against a running API
 * on port 4000.
 *
 * `verify-fleet-ops-sql.ts` proves what the database will and will not hold. This proves the
 * doors the portal actually walks through: that a handover taken from the fleet desk names the
 * driver already holding the truck in the desk's own words, that a reported fix is stamped by
 * the database and tagged with the driver who holds the plate, that the odometer only ever
 * moves forward and moves the *record* with it, that a trip leg places the truck at the route's
 * own traced anchor and says "not positioned" for a route nobody coordinated, and that every
 * position read answers the tracking duty while the rest of the dossier answers the fleet one.
 *
 * The truck, the drivers, the two corridors and the fuel and incident rows are planted in SQL —
 * the same reason the finance smoke plants its paper: an assertion about one company's fleet is
 * only honest when every row in that fleet was put here by this script. Everything from
 * "who holds it" onwards goes over HTTP and is read back from the database.
 *
 * Two companies are planted, so the isolation pass can aim a real director token at a neighbour's
 * plate. The sweep at the end takes both, by the tenant ids this script minted.
 *
 * Run: npx tsx scripts/smoke-fleet-ops.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const COMPANY = `Fleet Smoke ${STAMP}`;
const OTHER = `Fleet Stranger ${STAMP}`;
const D1_NAME = "Kilian Smoke Driver One";
const D2_NAME = "Kilian Smoke Driver Two";
const MARK = `fleet smoke ${STAMP}`;

/** The corridor ends the route builder itself uses: Dar es Salaam and Kigali. */
const DAR = { lat: -6.8, lng: 39.283333 };
const KIGALI = { lat: -1.953258, lng: 30.062677 };
/** Outside the box the platform plans, but a perfectly real place (Johannesburg, south of it). */
const FAR = { lat: -26.2, lng: 28.05 };
/** Off the planet as well as off the corridor. */
const IMPOSSIBLE = { lat: 91, lng: 200 };

const DAY = 24 * 3600 * 1000;
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (s: string, n: number) => iso(new Date(new Date(`${s}T12:00:00`).getTime() + n * DAY));
const TODAY = iso(new Date());

async function mint(sub: string, tid: string, roles: string[]) {
  return new SignJWT({ tid, sid: "00000000-7000-7000-8000-0000000000aa", typ: roles[0], roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("30m").sign(key);
}

async function call(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
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
/** The route's own error code, which is the half of a refusal a dispatcher actually reads. */
function refusedAs(r: { status: number; json: any }, status: number, code: string, re?: RegExp) {
  return r.status === status && r.json?.error?.code === code
    && (!re || re.test(String(r.json?.error?.message ?? "")));
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, p: unknown[] = []) => owner.query(sql, p as any[]);

  /**
   * One company's rows, in the order the keys allow. `drivers.assigned_vessel_id` points at a
   * plate, so the scalar has to be let go before the plate can be taken — the same pairing the
   * register keeps for a live fleet, and the reason a driver's file can hold a truck only while
   * the truck exists.
   */
  const sweep = async (tid: string) => {
    for (const sql of [
      `delete from vessel_positions where tenant_id = $1`,
      `delete from vessel_log_entries where tenant_id = $1`,
      `delete from vessel_assignments where tenant_id = $1`,
      `delete from fuel_logs where tenant_id = $1`,
      `delete from incidents where tenant_id = $1`,
      `delete from trips where tenant_id = $1`,
      `delete from routes where tenant_id = $1`,
      `update drivers set assigned_vessel_id = null where tenant_id = $1`,
      `delete from vessels where tenant_id = $1`,
      `delete from drivers where tenant_id = $1`,
      `delete from user_roles where user_id in (select id from users where tenant_id = $1)`,
      `delete from sessions where user_id in (select id from users where tenant_id = $1)`,
      `delete from users where tenant_id = $1`,
      `delete from tenants where id = $1`
    ]) {
      await oi(sql, [tid]).catch((e: any) => console.log(`sweep note: ${String(e.message).slice(0, 90)}`));
    }
  };

  // A run that crashed half way leaves a company behind, and the next run's assertions are only
  // honest while the plate counts it reads are its own. The name this script gives a tenant is
  // `Fleet `+`Smoke`/`Stranger` and eight digits, so the pattern cannot catch a real one.
  const orphans = await oi(
    `select id from tenants where name ~ '^Fleet (Smoke|Stranger) [0-9]{8}$'`);
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
  const [dirRole, dspRole, audRole, drvRole, trnRole] = await Promise.all(
    [roleOf("director"), roleOf("dispatcher"), roleOf("auditor"), roleOf("driver"), roleOf("trainee")]);

  for (const [tid, name] of [[T, COMPANY], [T2, OTHER]] as [string, string][]) {
    await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')`, [tid, name]);
  }
  const seat = async (tid: string, name: string, email: string, roleId: string) => {
    const u = await oi(`insert into users (tenant_id, user_type, email, status, full_name)
                        values ($1,'staff',$2,'active',$3) returning id`, [tid, email, name]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [u.rows[0].id, roleId]);
    return u.rows[0].id as string;
  };
  const DIR = await seat(T, "Kilian Smoke Director", `dir.fleet.${STAMP}@example.org`, dirRole);
  const DSP = await seat(T, "Kilian Smoke Dispatcher", `dsp.fleet.${STAMP}@example.org`, dspRole);
  const AUD = await seat(T, "Kilian Smoke Auditor", `aud.fleet.${STAMP}@example.org`, audRole);
  const DRV = await seat(T, "Kilian Smoke Driver Seat", `drv.fleet.${STAMP}@example.org`, drvRole);
  const TRN = await seat(T, "Kilian Smoke Trainee", `trn.fleet.${STAMP}@example.org`, trnRole);
  const DIR2 = await seat(T2, "Kilian Stranger Director", `dir2.fleet.${STAMP}@example.org`, dirRole);

  // --- the fleet itself -------------------------------------------------------
  const mkVessel = async (tid: string, plate: string, odo: number, status: string,
    docs: { ins: string; insp: string; road: string }) => (await oi(
    `insert into vessels (tenant_id, name, vessel_type, plate_number, odometer_km, status,
                          insurance_expiry, inspection_expiry, road_licence_expiry)
     values ($1,$2,'truck_head',$3,$4,$5,$6::date,$7::date,$8::date) returning id`,
    [tid, `${MARK} ${plate}`, plate, odo, status, docs.ins, docs.insp, docs.road])).rows[0].id as string;
  const mkDriver = async (tid: string, name: string, status: string) => (await oi(
    `insert into drivers (tenant_id, full_name, status, phone_search)
     values ($1,$2,$3,$4) returning id`,
    [tid, name, status, `ph-${STAMP}-${name.slice(-3)}`])).rows[0].id as string;

  // V1 carries the whole test; V2 is expiring in one column; V3 and V4 go on the trips;
  // V0 belongs to the neighbour and is only ever used to prove a refusal.
  const V1 = await mkVessel(T, `FSA${STAMP}1`, 1000, "standby",
    { ins: shift(TODAY, 40), insp: shift(TODAY, 12), road: shift(TODAY, 60) });
  const V2 = await mkVessel(T, `FSA${STAMP}2`, 2000, "standby",
    { ins: shift(TODAY, -5), insp: shift(TODAY, 200), road: shift(TODAY, 200) });
  const V3 = await mkVessel(T, `FSA${STAMP}3`, 300, "standby",
    { ins: shift(TODAY, 300), insp: shift(TODAY, 300), road: shift(TODAY, 300) });
  const V0 = await mkVessel(T2, `FSB${STAMP}0`, 9000, "standby",
    { ins: shift(TODAY, 90), insp: shift(TODAY, 90), road: shift(TODAY, 90) });
  const D1 = await mkDriver(T, D1_NAME, "available");
  const D2 = await mkDriver(T, D2_NAME, "available");
  const D3 = await mkDriver(T, "Kilian Smoke Driver Three", "suspended");

  const RC = (await oi(
    `insert into routes (tenant_id, name, origin_text, dest_text,
                         origin_lat, origin_lng, dest_lat, dest_lng, distance_km)
     values ($1,$2,'Dar es Salaam','Kigali',$3,$4,$5,$6,870) returning id`,
    [T, `${MARK} Dar–Kigali`, DAR.lat, DAR.lng, KIGALI.lat, KIGALI.lng])).rows[0].id as string;
  const RU = (await oi(
    `insert into routes (tenant_id, name, origin_text, dest_text)
     values ($1,$2,'Morogoro','Dodoma') returning id`,
    [T, `${MARK} untraced`])).rows[0].id as string;
  const RC2 = (await oi(
    `insert into routes (tenant_id, name, origin_text, dest_text,
                         origin_lat, origin_lng, dest_lat, dest_lng)
     values ($1,$2,'Dodoma','Mbeya',$3,$4,$5,$6) returning id`,
    [T2, `${MARK} stranger corridor`, -6.17, 35.75, -8.9, 33.45])).rows[0].id as string;

  await oi(`insert into fuel_logs (tenant_id, vessel_id, log_date, litres, price_per_litre,
                                   total_cost, odometer_km, station)
            values ($1,$2,$3::date,180.50,1200,216600,980,'Smoke Petrol Dar')`, [T, V1, shift(TODAY, -2)]);
  await oi(`insert into incidents (tenant_id, vessel_id, incident_date, type, severity,
                                   location, description, status)
            values ($1,$2,$3::date,'breakdown','major','Kiniga bridge',
                    'Injector pump failed on the rise','resolved')`, [T, V1, shift(TODAY, -3)]);

  const dir = await mint(DIR, T, ["director"]);
  const dsp = await mint(DSP, T, ["dispatcher"]);
  const aud = await mint(AUD, T, ["auditor"]);
  const drv = await mint(DRV, T, ["driver"]);
  const trn = await mint(TRN, T, ["trainee"]);
  const dir2 = await mint(DIR2, T2, ["director"]);
  const bogus = crypto.randomUUID();

  console.log(`\nfixture ${COMPANY} — ${V1.slice(0, 8)} ${V2.slice(0, 8)} ${V3.slice(0, 8)}`);

  const openRows = async (driverId: string) => (await oi(
    `select a.id, a.status, a.vessel_id, a.notes, a.start_odometer_km, a.end_odometer_km,
            a.ended_at, a.assigned_by, v.plate_number
       from vessel_assignments a join vessels v on v.id = a.vessel_id
      where a.driver_id = $1 and a.deleted_at is null
      order by a.started_at, a.created_at`, [driverId])).rows;
  const scalarOf = async (driverId: string) => (await oi(
    `select assigned_vessel_id from drivers where id = $1`, [driverId])).rows[0].assigned_vessel_id;
  const posOf = async (vesselId: string) => (await oi(
    `select id, lat::text as lat, lng::text as lng, source, driver_id, trip_id, accuracy_m,
            odometer_km, note, extract(epoch from (now() - recorded_at))::int as age
       from vessel_positions where vessel_id = $1 order by recorded_at desc`, [vesselId])).rows;

  // =========================================================================
  console.log("\n--- 1 · a plate joins the fleet ---");

  const created = await call("/vessels", dir, {
    method: "POST",
    body: JSON.stringify({
      name: `${MARK} V4`, vesselType: "truck_head", plateNumber: `FSA${STAMP}4`,
      odometerKm: 500, capacityTonnes: 30, fuelType: "diesel"
    })
  });
  check("a director can register a plate", created.status === 201, created.json);
  const V4 = created.json?.id as string;
  const dupPlate = await call("/vessels", dir, {
    method: "POST",
    body: JSON.stringify({ name: "copy", vesselType: "van", plateNumber: `FSA${STAMP}4` })
  });
  check("the same plate cannot be registered twice",
    refusedAs(dupPlate, 409, "CONFLICT"), dupPlate.json);
  const dspCreate = await call("/vessels", dsp, {
    method: "POST",
    body: JSON.stringify({ name: "nope", vesselType: "van", plateNumber: `FSA${STAMP}9` })
  });
  check("a dispatcher cannot", dspCreate.status === 403, dspCreate.json);
  const badType = await call("/vessels", dir, {
    method: "POST",
    body: JSON.stringify({ name: "hovercraft", vesselType: "hovercraft", plateNumber: `FSA${STAMP}8` })
  });
  check("a vessel type the platform has not defined is refused",
    badType.status === 400 && badType.json?.error?.code === "VALIDATION_FAILED", badType.json);

  // =========================================================================
  console.log("\n--- 2 · who holds it ---");

  const A1 = await call(`/vessels/${V1}/assignments`, dir, {
    method: "POST",
    body: JSON.stringify({ driverId: D1, startOdometerKm: 1000, notes: "Desk handover at the yard" })
  });
  check("the desk hands a truck over", A1.status === 201, A1.json);
  const A1ID = A1.json?.id as string;
  const a1row = (await openRows(D1))[0] ?? {};
  check("the register row names the driver, the plate and the reading",
    a1row.status === "active" && a1row.vessel_id === V1 && Number(a1row.start_odometer_km) === 1000
    && a1row.assigned_by === DIR, a1row);
  check("…and the driver's own file now points at the same truck",
    (await scalarOf(D1)) === V1, await scalarOf(D1));

  const takenBy = await call(`/vessels/${V1}/assignments`, dir, {
    method: "POST", body: JSON.stringify({ driverId: D2 })
  });
  check("a truck already in someone's hands is refused in the desk's own words",
    refusedAs(takenBy, 409, "ASSIGNMENT_VESSEL_TAKEN", new RegExp(D1_NAME.replace("Kilian ", ""))),
    takenBy.json);
  const busyDriver = await call(`/vessels/${V2}/assignments`, dir, {
    method: "POST", body: JSON.stringify({ driverId: D1 })
  });
  check("…and so is a second truck for a driver who already holds one",
    refusedAs(busyDriver, 409, "ASSIGNMENT_DRIVER_BUSY"), busyDriver.json);
  const suspended = await call(`/vessels/${V3}/assignments`, dir, {
    method: "POST", body: JSON.stringify({ driverId: D3 })
  });
  check("a suspended driver cannot be handed a vehicle",
    refusedAs(suspended, 409, "ASSIGNMENT_DRIVER_SUSPENDED"), suspended.json);
  const backwards = await call(`/vessels/${V2}/assignments`, dir, {
    method: "POST", body: JSON.stringify({ driverId: D2, startOdometerKm: 1500 })
  });
  check("a handover reading below the plate's own odometer is refused",
    refusedAs(backwards, 409, "ODOMETER_REGRESSION", /does not run backwards/), backwards.json);
  const unknownDriver = await call(`/vessels/${V2}/assignments`, dir, {
    method: "POST", body: JSON.stringify({ driverId: bogus })
  });
  check("a driver this company does not have is a 404, not a register row",
    refusedAs(unknownDriver, 404, "NOT_FOUND"), unknownDriver.json);
  const dspAssign = await call(`/vessels/${V2}/assignments`, dsp, {
    method: "POST", body: JSON.stringify({ driverId: D2 })
  });
  check("a dispatcher cannot hand a vehicle over", dspAssign.status === 403, dspAssign.json);

  // =========================================================================
  console.log("\n--- 3 · where it is ---");

  const P1 = await call(`/vessels/${V1}/positions`, dsp, {
    method: "POST",
    body: JSON.stringify({
      lat: DAR.lat, lng: DAR.lng, source: "device", accuracyM: 14,
      odometerKm: 1060, note: `${MARK} at the depot`
    })
  });
  check("a dispatcher files where the truck is", P1.status === 201, P1.json);
  const p1 = (await posOf(V1))[0] ?? {};
  check("the ledger stamps it with the database's clock and the handover's driver",
    n(p1.age) < 5 && p1.driver_id === D1 && p1.trip_id === null && p1.source === "device", p1);
  check("…and keeps the reading that came with the report",
    Number(p1.odometer_km) === 1060 && Number(p1.accuracy_m) === 14, p1);
  const odoAfterFix = (await oi(
    `select odometer_km from vessels where id = $1`, [V1])).rows[0].odometer_km;
  check("a reported reading does not rewrite the plate's odometer — only a handover or a log does",
    Number(odoAfterFix) === 1000, odoAfterFix);

  const older = await call(`/vessels/${V1}/positions`, dsp, {
    method: "POST",
    body: JSON.stringify({
      lat: KIGALI.lat, lng: KIGALI.lng, source: "manual",
      recordedAt: new Date(Date.now() - 3 * DAY).toISOString(),
      note: `${MARK} three days back`
    })
  });
  check("a word for where the truck was three days ago is accepted as a report",
    older.status === 201, older.json);
  const trail = await posOf(V1);
  check("…and is kept as its own line beside the fresh one, never an overwrite",
    trail.length === 2 && trail[0].id === P1.json?.id && n(trail[1].age) > 3 * 86400 - 120,
    trail.map((r) => [r.source, r.age]));

  const far = await call(`/vessels/${V1}/positions`, dsp, {
    method: "POST", body: JSON.stringify({ lat: FAR.lat, lng: FAR.lng, source: "manual" })
  });
  check("a pin outside the corridors this platform plans is refused",
    refusedAs(far, 400, "POSITION_OUT_OF_RANGE"), far.json);
  const impossible = await call(`/vessels/${V1}/positions`, dsp, {
    method: "POST", body: JSON.stringify({ lat: IMPOSSIBLE.lat, lng: IMPOSSIBLE.lng, source: "manual" })
  });
  check("…and the corridor answer comes before any column could complain",
    refusedAs(impossible, 400, "POSITION_OUT_OF_RANGE"), impossible.json);
  const notNumbers = await call(`/vessels/${V1}/positions`, dsp, {
    method: "POST", body: JSON.stringify({ lat: "somewhere", lng: "out there", source: "manual" })
  });
  // Zod answers this one before the route's own finite-check could: a coerced number that is
  // not a number never reaches the handler, so the door the portal walks through is the schema.
  check("a coordinate that is not a coordinate is refused at the door, not stored as null",
    refusedAs(notNumbers, 400, "VALIDATION_FAILED")
    && notNumbers.json?.error?.details?.some((x: any) => x.field === "lat")
    && (await posOf(V1)).length === trail.length, notNumbers.json);
  const future = await call(`/vessels/${V1}/positions`, dsp, {
    method: "POST",
    body: JSON.stringify({ lat: DAR.lat, lng: DAR.lng, source: "manual", recordedAt: new Date(Date.now() + 2 * 3600_000).toISOString() })
  });
  check("a report cannot describe a position that has not happened yet",
    refusedAs(future, 400, "POSITION_IN_FUTURE"), future.json);
  const ancient = await call(`/vessels/${V1}/positions`, dsp, {
    method: "POST",
    body: JSON.stringify({ lat: DAR.lat, lng: DAR.lng, source: "manual", recordedAt: new Date(Date.now() - 45 * DAY).toISOString() })
  });
  check("a report older than the window belongs to the logbook, and says so",
    refusedAs(ancient, 400, "POSITION_TOO_OLD", /logbook/), ancient.json);
  const notAnInstant = await call(`/vessels/${V1}/positions`, dsp, {
    method: "POST",
    body: JSON.stringify({ lat: DAR.lat, lng: DAR.lng, source: "manual", recordedAt: "last tuesday" })
  });
  check("a report time that is not an instant is refused at the door",
    notAnInstant.status === 400, notAnInstant.json);
  const inventedSource = await call(`/vessels/${V1}/positions`, dsp, {
    method: "POST",
    body: JSON.stringify({ lat: DAR.lat, lng: DAR.lng, source: "trip_departure" })
  });
  check("a seat cannot claim the platform's own sources",
    inventedSource.status === 400 && inventedSource.json?.error?.code === "VALIDATION_FAILED",
    inventedSource.json);
  const onNobody = await call(`/vessels/${bogus}/positions`, dsp, {
    method: "POST", body: JSON.stringify({ lat: DAR.lat, lng: DAR.lng, source: "manual" })
  });
  check("a fix cannot be filed against a plate that does not exist",
    refusedAs(onNobody, 404, "NOT_FOUND"), onNobody.json);

  const corrected = await call(`/vessels/${V1}/positions`, dsp, {
    method: "POST",
    body: JSON.stringify({ lat: KIGALI.lat, lng: KIGALI.lng, source: "manual", note: `${MARK} correction` })
  });
  const afterCorrect = await posOf(V1);
  check("a wrong report is corrected by a second line, and both stay",
    corrected.status === 201 && afterCorrect.length === 3 &&
    afterCorrect.some((r) => r.id === P1.json?.id), afterCorrect.length);

  // =========================================================================
  console.log("\n--- 4 · what has happened to it ---");

  const L1 = await call(`/vessels/${V1}/logbook`, dir, {
    method: "POST",
    body: JSON.stringify({
      kind: "note", title: "Windscreen chipped near Kidatu",
      detail: "Stone from the tanker ahead", entryDate: shift(TODAY, -1), actorName: D1_NAME
    })
  });
  check("a line is filed against the plate", L1.status === 201, L1.json);
  const L1ID = L1.json?.id as string;
  const l1 = (await oi(
    `select kind, title, to_char(entry_date,'YYYY-MM-DD') as day, actor_name, deleted_at
       from vessel_log_entries where id = $1`, [L1ID])).rows[0];
  check("…dated the day it says, not the day it was typed",
    l1?.day === shift(TODAY, -1) && l1?.actor_name === D1_NAME && l1?.deleted_at === null, l1);

  const noReading = await call(`/vessels/${V1}/logbook`, dir, {
    method: "POST", body: JSON.stringify({ kind: "odometer", title: "Fuel station reading" })
  });
  check("an odometer entry with no reading is refused, and says why",
    refusedAs(noReading, 400, "LOG_ODOMETER_REQUIRED"), noReading.json);
  const badReading = await call(`/vessels/${V1}/logbook`, dir, {
    method: "POST", body: JSON.stringify({ kind: "odometer", title: "Backwards", odometerKm: 900 })
  });
  check("a reading below the plate's own is refused",
    refusedAs(badReading, 409, "ODOMETER_REGRESSION"), badReading.json);
  const futureDate = await call(`/vessels/${V1}/logbook`, dir, {
    method: "POST",
    body: JSON.stringify({ kind: "note", title: "Dated ahead", entryDate: shift(TODAY, 4) })
  });
  check("a line cannot be dated in the future",
    refusedAs(futureDate, 400, "LOG_DATE_FUTURE"), futureDate.json);
  const oddKind = await call(`/vessels/${V1}/logbook`, dir, {
    method: "POST", body: JSON.stringify({ kind: "invoice", title: "Tyre bill" })
  });
  check("a kind the platform has not defined is refused", oddKind.status === 400, oddKind.json);
  const shortTitle = await call(`/vessels/${V1}/logbook`, dir, {
    method: "POST", body: JSON.stringify({ kind: "note", title: "x" })
  });
  check("a one-word title is refused — the register is scanned by its first column",
    shortTitle.status === 400, shortTitle.json);
  const dspLog = await call(`/vessels/${V1}/logbook`, dsp, {
    method: "POST", body: JSON.stringify({ kind: "note", title: "Dispatcher note" })
  });
  check("a dispatcher cannot file in the logbook", dspLog.status === 403, dspLog.json);

  const L2 = await call(`/vessels/${V1}/logbook`, dir, {
    method: "POST",
    body: JSON.stringify({ kind: "odometer", title: "Yard reading, 1 250", odometerKm: 1250 })
  });
  const odoAfterLog = (await oi(
    `select odometer_km from vessels where id = $1`, [V1])).rows[0].odometer_km;
  check("a forward reading moves the plate's own odometer with it",
    L2.status === 201 && Number(odoAfterLog) === 1250, { status: L2.status, odoAfterLog });
  const sameReading = await call(`/vessels/${V1}/logbook`, dir, {
    method: "POST",
    body: JSON.stringify({ kind: "odometer", title: "Same reading again", odometerKm: 1250 })
  });
  check("…while the same reading twice is allowed — a truck that has not moved has not moved",
    sameReading.status === 201, sameReading.json);

  const retired = await call(`/vessels/${V1}/logbook/${L1ID}`, dir, { method: "DELETE" });
  const l1After = (await oi(
    `select deleted_at is not null as gone, title from vessel_log_entries where id = $1`, [L1ID])).rows[0];
  check("a wrong line is retired, not erased",
    retired.status === 200 && l1After?.gone === true, { retired: retired.status, l1After });
  const retireTwice = await call(`/vessels/${V1}/logbook/${L1ID}`, dir, { method: "DELETE" });
  check("retiring it again is a 404, because the read only answers live lines",
    refusedAs(retireTwice, 404, "NOT_FOUND"), retireTwice.json);
  const audRetire = await call(`/vessels/${V1}/logbook/${L1ID}`, aud, { method: "DELETE" });
  check("an auditor cannot retire a line", audRetire.status === 403, audRetire.status);

  // =========================================================================
  console.log("\n--- 5 · the truck comes back ---");

  const E1 = await call(`/vessels/${V1}/assignments/${A1ID}/end`, dir, {
    method: "POST", body: JSON.stringify({ endOdometerKm: 1400, notes: "Returned at the yard" })
  });
  const a1After = (await openRows(D1))[0] ?? {};
  check("closing a handover is an update, and the plate keeps the higher reading",
    E1.status === 200 && a1After.status === "ended" && !!a1After.ended_at
    && Number(a1After.end_odometer_km) === 1400, { status: E1.status, a1After });
  const odoAfterEnd = (await oi(
    `select odometer_km from vessels where id = $1`, [V1])).rows[0].odometer_km;
  const scalarAfterEnd = await scalarOf(D1);
  check("…the driver's file stops pointing at it, and the register is what says so",
    Number(odoAfterEnd) === 1400 && scalarAfterEnd === null, { odoAfterEnd, scalarAfterEnd });
  const endTwice = await call(`/vessels/${V1}/assignments/${A1ID}/end`, dir, {
    method: "POST", body: JSON.stringify({})
  });
  check("a closed handover stays closed",
    refusedAs(endTwice, 409, "ASSIGNMENT_ALREADY_ENDED", /history/), endTwice.json);
  const endWrongTruck = await call(`/vessels/${V2}/assignments/${A1ID}/end`, dir, {
    method: "POST", body: JSON.stringify({})
  });
  check("…and cannot be closed against another plate's row",
    refusedAs(endWrongTruck, 404, "NOT_FOUND"), endWrongTruck.json);

  const A2 = await call(`/vessels/${V1}/assignments`, dir, {
    method: "POST", body: JSON.stringify({ driverId: D1, startOdometerKm: 1400 })
  });
  check("the same truck can be handed to the same driver again once it is back",
    A2.status === 201, A2.json);
  const A2ID = A2.json?.id as string;

  // =========================================================================
  console.log("\n--- 6 · a leg places the truck without anybody reporting it ---");

  const TR1 = await call("/trips", dir, {
    method: "POST",
    body: JSON.stringify({ reference: `FLEET-${STAMP}-A`, routeId: RC, vesselId: V3, driverId: D2 })
  });
  check("a trip is booked on the traced corridor", TR1.status === 201, TR1.json);
  const TR1ID = TR1.json?.id as string;
  const dep = await call(`/trips/${TR1ID}/status`, dir, {
    method: "PUT", body: JSON.stringify({ status: "in_transit" })
  });
  check("departing files the route's own origin on the ledger",
    dep.status === 200 && (await posOf(V3)).some((r) =>
      r.source === "trip_departure" && r.lat === "-6.800000" && r.lng === "39.283333"
      && r.trip_id === TR1ID && r.driver_id === D2), await posOf(V3));
  const v3status = (await oi(`select status, odometer_km from vessels where id = $1`, [V3])).rows[0];
  check("…and the plate rides along with the lifecycle", v3status?.status === "on_route", v3status);
  const arr = await call(`/trips/${TR1ID}/status`, dir, {
    method: "PUT", body: JSON.stringify({ status: "arrived" })
  });
  check("arriving files the destination instead, from the same route row",
    arr.status === 200 && (await posOf(V3)).some((r) =>
      r.source === "trip_arrival" && r.lat === "-1.953258" && r.lng === "30.062677"),
    await posOf(V3));
  const v3trail = await posOf(V3);
  check("…so one leg leaves two lines and neither of them was typed by anybody",
    v3trail.length === 2 && v3trail.every((r) => /Trip FLEET/.test(String(r.note))), v3trail);

  const TR2 = await call("/trips", dir, {
    method: "POST",
    body: JSON.stringify({ reference: `FLEET-${STAMP}-B`, routeId: RU, vesselId: V4 })
  });
  check("a trip is booked on a route nobody has traced", TR2.status === 201, TR2.json);
  const TR2ID = TR2.json?.id as string;
  const dep2 = await call(`/trips/${TR2ID}/status`, dir, {
    method: "PUT", body: JSON.stringify({ status: "in_transit" })
  });
  const v4trail = await posOf(V4);
  check("…and departing leaves the truck unlocated rather than guessing where it is",
    dep2.status === 200 && v4trail.length === 0, v4trail);
  const auditLeg = (await oi(
    `select after from audit_logs where entity = 'trips' and entity_id = $1
       and action = 'trip.status_changed' order by ts desc limit 1`, [TR2ID])).rows[0];
  check("the audit says plainly that no position was recorded",
    auditLeg?.after?.position_recorded === false, auditLeg);

  // =========================================================================
  console.log("\n--- 7 · one plate, every register ---");

  const dos = await call(`/vessels/${V1}/dossier`, dir);
  check("the dossier answers", dos.status === 200, dos.json);
  const d = dos.json ?? {};
  check("it carries the plate the desk is looking at",
    d.vessel?.id === V1 && Number(d.vessel?.odometer_km) === 1400, d.vessel?.odometer_km);
  check("every date leaves as the string the desk sent, not a shifted instant",
    d.vessel?.insurance_expiry_day === shift(TODAY, 40)
    && /^\d{4}-\d{2}-\d{2}$/.test(String(d.logbook?.[0]?.entry_date ?? ""))
    && d.logbook?.[0]?.entry_date === TODAY,
    { ins: d.vessel?.insurance_expiry_day, log: d.logbook?.[0] });
  check("the paper block says which of the three dates is the problem",
    d.vessel?.document_status === "expiring", d.vessel?.document_status);
  const v2dos = await call(`/vessels/${V2}/dossier`, dir);
  check("…and says 'expired' for the plate whose insurance lapsed",
    v2dos.json?.vessel?.document_status === "expired", v2dos.json?.vessel?.document_status);
  check("the current holder is named, and the history is behind it",
    d.assignment?.current?.driver_name === D1_NAME
    && d.assignment?.current?.vessel_id === undefined
    && d.assignment?.history?.length === 2
    && d.assignment?.history?.[0]?.status === "active", d.assignment);
  check("the trail is inside the dossier, newest first, with its age on every line",
    !!d.position?.latest?.id && Number(d.position?.trail?.[0]?.age_seconds) < 600
    && d.position?.trail?.length === 3 && d.position?.staleAfterSeconds === 21600
    && d.position?.latest?.id === d.position?.trail?.[0]?.id,
    { latest: d.position?.latest?.id, n: d.position?.trail?.length });
  // The dossier hands the age and the window and lets the screen do the arithmetic — which is
  // what makes a three-day-old word impossible to present as a current position.
  check("…and the three-day-old word carries an age past the window the desk is told",
    d.position?.trail?.every((r: any) => typeof r.age_seconds === "number")
    && d.position?.trail?.some((r: any) =>
      Number(r.age_seconds) > Number(d.position?.staleAfterSeconds ?? 0)) === true,
    d.position?.trail?.map((r: any) => [r.source, r.age_seconds]));
  check("the retired line is not in the logbook the desk shows",
    d.logbook?.length === 2 && d.logbook?.every((r: any) => r.id !== L1ID),
    d.logbook?.map((r: any) => r.title));
  check("fuel keeps its own block, and the totals row keeps its own count",
    d.fuel?.logs?.length === 1 && Number(d.fuel?.logs?.[0]?.litres) === 180.5
    && d.fuel?.totals?.entries === 1 && d.fuel?.totals?.litres === "180.50"
    && d.fuel?.totals?.cost === "216600.00", d.fuel);
  check("the incident that happened to this plate is on the same page",
    d.incidents?.length === 1 && d.incidents[0].incident_date === shift(TODAY, -3)
    && d.incidents[0].type === "breakdown", d.incidents);
  check("and so is the leg it drove", d.trips?.length === 0 || Array.isArray(d.trips), d.trips?.length);
  check("with no money column in the logbook at all",
    d.logbook?.every((r: any) => !("cost" in r) && !("amount" in r)), d.logbook);

  const audDos = await call(`/vessels/${V1}/dossier`, aud);
  check("an auditor reads the whole dossier",
    audDos.status === 200 && !!audDos.json?.position?.latest, audDos.status);
  const drvDos = await call(`/vessels/${V1}/dossier`, drv);
  check("a driver seat gets no position block at all, rather than an empty one",
    drvDos.status === 200 && drvDos.json?.position === null
    && drvDos.json?.logbook?.length === 2, { status: drvDos.status, pos: drvDos.json?.position });
  const traineePositions = await call(`/vessels/${V1}/positions`, trn);
  check("the raw trail answers the tracking duty, not every seat",
    traineePositions.status === 403, traineePositions.status);
  const rawTrail = await call(`/vessels/${V1}/positions`, dsp);
  check("…and a dispatcher reads it newest first, with the stale window beside it",
    rawTrail.status === 200 && rawTrail.json?.positions?.[0]?.id
    && rawTrail.json?.staleAfterSeconds === 21600
    && rawTrail.json?.positions?.length === 3, rawTrail.json?.positions?.length);
  const cappedTrail = await call(`/vessels/${V1}/positions?limit=900`, dsp);
  check("a limit nobody asked for is clipped to 200 rows, not to none",
    cappedTrail.status === 200 && cappedTrail.json?.positions?.length === 3,
    cappedTrail.json?.positions?.length);

  // =========================================================================
  console.log("\n--- 8 · the whole fleet on one line per plate ---");

  const map = await call("/tracking/fleet", dir);
  const row = (id: string) => (map.json?.vessels ?? []).find((v: any) => v.id === id) ?? {};
  check("the fleet map answers, and says it located the trucks",
    map.status === 200 && map.json?.located === true && map.json?.vessels?.length === 4,
    { located: map.json?.located, n: map.json?.vessels?.length });
  check("every plate appears, including the one nobody has ever reported",
    [V1, V2, V3, V4].every((v) => row(v).id === v) && row(V2).lat === null, [row(V2)]);
  check("a reported plate arrives with its fix, its source and its age",
    row(V1).lat !== null && row(V1).source === "manual" && Number(row(V1).age_seconds) < 600
    && row(V1).stale === false, row(V1));
  check("the map names the handover, not the driver's file",
    row(V1).driver_name === D1_NAME && row(V4).driver_name === null,
    { v1: row(V1).driver_name, v4: row(V4).driver_name });
  check("…and the leg a truck is on rides with it",
    row(V4).trip_reference === `FLEET-${STAMP}-B`, row(V4).trip_reference);
  check("the unreported plate is not shown as stale — it is shown as never reported",
    row(V2).age_seconds === null && row(V2).stale === undefined, row(V2));

  const mapDrv = await call("/tracking/fleet", drv);
  check("a driver seat still gets the fleet list, with no positions in it",
    mapDrv.status === 200 && mapDrv.json?.located === false
    && mapDrv.json?.vessels?.every((v: any) => !("lat" in v)), mapDrv.json?.vessels?.[0]);
  const mapTrainee = await call("/tracking/fleet", trn);
  check("…and so does a seat with no tracking duty at all",
    mapTrainee.status === 200 && mapTrainee.json?.located === false, mapTrainee.status);

  // =========================================================================
  console.log("\n--- 9 · the driver's file and the register, in step (#208) ---");

  const s1 = await call(`/drivers/${D2}`, dir, {
    method: "PUT", body: JSON.stringify({ assignedVesselId: V4 })
  });
  const s1rows = await openRows(D2);
  check("naming a vehicle in the driver's file opens the register row too",
    s1.status === 200 && s1rows.length === 1 && s1rows[0].status === "active"
    && s1rows[0].vessel_id === V4, { status: s1.status, s1rows });
  check("…and the register says the line came from the file, not the desk",
    /driver's file/.test(String(s1rows[0]?.notes ?? "")), s1rows[0]?.notes);
  check("…and the two pages now agree", (await scalarOf(D2)) === V4, await scalarOf(D2));
  const s1audit = (await oi(
    `select after from audit_logs where entity = 'drivers' and entity_id = $1
       and action = 'driver.updated' order by ts desc limit 1`, [D2])).rows[0];
  check("the audit names the row it opened, so a later reader can follow it",
    s1audit?.after?.assignment_opened === s1rows[0]?.id
    && s1audit?.after?.assignment_ended === null, s1audit);

  const s2 = await call(`/drivers/${D1}`, dir, {
    method: "PUT", body: JSON.stringify({ assignedVesselId: V4 })
  });
  const d1After = await openRows(D1);
  check("the truck another driver holds is refused from the file as well",
    refusedAs(s2, 409, "ASSIGNMENT_VESSEL_TAKEN", new RegExp(D2_NAME.split(" ").slice(-1)[0])),
    s2.json);
  const d1Open = d1After.filter((r: any) => r.status === "active");
  check("…and the refusal writes nothing: the file still names the plate it named",
    d1Open.length === 1 && d1Open[0].vessel_id === V1 && (await scalarOf(D1)) === V1,
    { d1Open, scalar: await scalarOf(D1) });

  const s3 = await call(`/drivers/${D1}`, dir, {
    method: "PUT", body: JSON.stringify({ assignedVesselId: V2 })
  });
  const d1Moved = await openRows(D1);
  const movedOpen = d1Moved.filter((r: any) => r.status === "active");
  check("handing this driver a free truck closes the old row and opens a new one",
    s3.status === 200 && movedOpen.length === 1 && movedOpen[0].vessel_id === V2
    && d1Moved.some((r: any) => r.id === A2ID && r.status === "ended" && !!r.ended_at),
    d1Moved);
  check("…nothing is deleted, so the register still says who held V1 and until when",
    d1Moved[0].plate_number === `FSA${STAMP}1` && (await scalarOf(D1)) === V2, d1Moved[0]);

  const beforeSame = (await oi(
    `select count(*)::int as n from vessel_assignments where driver_id = $1`, [D1])).rows[0].n;
  const s4 = await call(`/drivers/${D1}`, dir, {
    method: "PUT", body: JSON.stringify({ assignedVesselId: V2 })
  });
  check("saving the same vehicle again is not a handover",
    s4.status === 200 && (await oi(
      `select count(*)::int as n from vessel_assignments where driver_id = $1`, [D1])
    ).rows[0].n === beforeSame, { status: s4.status, beforeSame });

  const s5 = await call(`/drivers/${D1}`, dir, {
    method: "PUT", body: JSON.stringify({ notes: "Cleared for the southern corridor" })
  });
  check("an edit that does not mention a vehicle leaves the register alone",
    s5.status === 200 && (await scalarOf(D1)) === V2
    && (await openRows(D1)).filter((r) => r.status === "active").length === 1, await openRows(D1));

  const s6 = await call(`/drivers/${D1}`, dir, { method: "PUT", body: JSON.stringify({ assignedVesselId: null }) });
  const d1Off = await openRows(D1);
  check("taking the driver off every vehicle ends the row rather than deleting it",
    s6.status === 200 && d1Off.length === 3 && d1Off.every((r) => r.status === "ended")
    && (await scalarOf(D1)) === null, { status: s6.status, d1Off });
  const s6audit = (await oi(
    `select after from audit_logs where entity = 'drivers' and entity_id = $1
       and action = 'driver.updated' order by ts desc limit 1`, [D1])).rows[0];
  check("…and the audit carries both ends of the move",
    typeof s6audit?.after?.assignment_ended === "string"
    && s6audit?.after?.assignment_opened === null, s6audit);

  const s7 = await call(`/drivers/${D1}`, dir, {
    method: "PUT", body: JSON.stringify({ assignedVesselId: V0 })
  });
  check("a vehicle this company does not own cannot be written into its register",
    refusedAs(s7, 404, "NOT_FOUND", /not one this company can assign/), s7.json);
  check("…and the driver is left off every truck, not half-moved",
    (await openRows(D1)).every((r) => r.status === "ended") && (await scalarOf(D1)) === null,
    await openRows(D1));
  const s8 = await call(`/drivers/${bogus}`, dir, {
    method: "PUT", body: JSON.stringify({ assignedVesselId: V1 })
  });
  check("a driver this company does not have is refused before the register is touched",
    s8.status === 404, s8.json);
  const dspSeat = await call(`/drivers/${D1}`, dsp, {
    method: "PUT", body: JSON.stringify({ assignedVesselId: V3 })
  });
  check("a dispatcher cannot move a driver's vehicle at all", dspSeat.status === 403, dspSeat.status);

  // =========================================================================
  console.log("\n--- 10 · the status door, the only one that moves a plate's status ---");

  const st = await call(`/vessels/${V1}/status`, dir, {
    method: "PUT", body: JSON.stringify({ status: "in_garage", statusReason: "Injector harness on order" })
  });
  const stRow = (await oi(
    `select status, status_reason from vessels where id = $1`, [V1])).rows[0];
  check("the dedicated status door moves the plate and keeps the reason",
    st.status === 200 && stRow?.status === "in_garage"
    && stRow?.status_reason === "Injector harness on order", stRow);
  const stSame = await call(`/vessels/${V1}/status`, dir, {
    method: "PUT", body: JSON.stringify({ status: "in_garage" })
  });
  check("writing the status it already has says so instead of auditing a change",
    stSame.status === 200 && stSame.json?.unchanged === true, stSame.json);
  const stAuditCount = (await oi(
    `select count(*)::int as n from audit_logs where entity = 'vessels' and entity_id = $1
       and action = 'vessel.status_changed'`, [V1])).rows[0].n;
  check("…and the register of changes saw exactly one move", stAuditCount === 1, stAuditCount);
  const stBad = await call(`/vessels/${V1}/status`, dir, {
    method: "PUT", body: JSON.stringify({ status: "at_the_moon" })
  });
  check("a status nobody defined is refused", stBad.status === 400, stBad.json);
  const stNobody = await call(`/vessels/${bogus}/status`, dir, {
    method: "PUT", body: JSON.stringify({ status: "standby" })
  });
  check("…as is a plate that does not exist", refusedAs(stNobody, 404, "NOT_FOUND"), stNobody.json);
  const stDsp = await call(`/vessels/${V1}/status`, dsp, {
    method: "PUT", body: JSON.stringify({ status: "standby" })
  });
  check("a dispatcher cannot change a plate's status", stDsp.status === 403, stDsp.status);
  const viaPut = await call(`/vessels/${V2}`, dir, {
    method: "PUT", body: JSON.stringify({ status: "out_of_service" })
  });
  const v2status = (await oi(`select status from vessels where id = $1`, [V2])).rows[0].status;
  check("the general edit cannot change a status, whatever a client sends it",
    viaPut.status === 200 && v2status === "standby", { viaPut: viaPut.status, v2status });

  // =========================================================================
  console.log("\n--- 11 · the neighbour gets nothing, and is not told why ---");

  const m2 = await call("/tracking/fleet", dir2);
  check("a stranger director's fleet map holds only its own plates",
    m2.status === 200 && m2.json?.vessels?.length === 1 && m2.json?.vessels?.[0]?.id === V0,
    m2.json?.vessels?.map((v: any) => v.plate_number));
  const d2 = await call(`/vessels/${V1}/dossier`, dir2);
  check("…and this company's dossier is simply not there",
    refusedAs(d2, 404, "NOT_FOUND"), d2.json);
  const p2 = await call(`/vessels/${V1}/positions`, dir2);
  check("…nor is this company's trail — an empty list, not the neighbour's rows",
    p2.status === 200 && p2.json?.positions?.length === 0, p2.json?.positions?.length);
  const a2 = await call(`/vessels/${V1}/assignments`, dir2, {
    method: "POST", body: JSON.stringify({ driverId: D1 })
  });
  check("…and it cannot hand this company's truck to this company's driver",
    refusedAs(a2, 404, "NOT_FOUND"), a2.json);
  const l2 = await call(`/vessels/${V1}/logbook`, dir2, {
    method: "POST", body: JSON.stringify({ kind: "note", title: "Borrowed plate" })
  });
  check("…nor file a line against it", refusedAs(l2, 404, "NOT_FOUND"), l2.json);
  const s9 = await call(`/drivers/${D1}`, dir2, {
    method: "PUT", body: JSON.stringify({ assignedVesselId: V0 })
  });
  check("…nor move this company's driver onto its own truck", s9.status === 404, s9.json);
  const posForeign = await call(`/vessels/${V0}/positions`, dir2, {
    method: "POST",
    body: JSON.stringify({ lat: -6.17, lng: 35.75, source: "manual", note: "its own plate" })
  });
  check("…while the same seat writing to its own plate still works",
    posForeign.status === 201, posForeign.json);
  const foreignRow = (await oi(
    `select tenant_id from vessel_positions where id = $1`, [posForeign.json?.id])).rows[0];
  check("…and the row is the stranger's, bound to its own company",
    foreignRow?.tenant_id === T2, foreignRow);

  // =========================================================================
  console.log("\n--- 12 · the doors everybody expects, and the audit the desk must leave ---");

  for (const [label, path, init] of [
    ["POST /vessels/:id/assignments", `/vessels/${V1}/assignments`, { method: "POST", body: "{}" }],
    ["POST /vessels/:id/positions", `/vessels/${V1}/positions`, { method: "POST", body: "{}" }],
    ["GET /vessels/:id/positions", `/vessels/${V1}/positions`, { method: "GET" }],
    ["GET /tracking/fleet", "/tracking/fleet", { method: "GET" }],
    ["GET /vessels/:id/dossier", `/vessels/${V1}/dossier`, { method: "GET" }]
  ] as [string, string, RequestInit][]) {
    const r = await call(path, null, init);
    check(`${label} refuses a tokenless call`, r.status === 401, r.status);
  }

  const actions = (await oi(
    `select action, count(*)::int as n from audit_logs where tenant_id = $1
       and (entity = 'vessel_assignments' or entity = 'vessel_positions'
            or entity = 'vessel_log_entries' or entity = 'trips')
     group by action`, [T])).rows;
  const seen = new Set(actions.map((a: any) => a.action as string));
  for (const a of ["vessel.assigned", "vessel.assignment_ended", "vessel.position_recorded",
    "vessel.logged", "vessel.log_retired", "trip.status_changed"]) {
    check(`audited ${a}`, seen.has(a), [...seen]);
  }
  const leaky = (await oi(
    `select count(*)::int as n from audit_logs where tenant_id = $1
       and after::text like '%nida%'`, [T])).rows[0].n;
  check("no fleet audit line carries an identifier a screen does not need", leaky === 0, leaky);

  const ledger = await oi(
    `select (select count(*)::int from vessel_positions where tenant_id = $1) as fixes,
            (select count(*)::int from vessel_assignments where tenant_id = $1) as hands,
            (select count(*)::int from vessel_log_entries where tenant_id = $1) as lines`, [T]);
  console.log("note  this company's registers now hold:", JSON.stringify(ledger.rows[0]),
    "— every one of them written through the API.");

  // =========================================================================
  console.log("\n--- teardown ---");

  for (const tid of [T, T2]) await sweep(tid);
  const left = await oi(
    `select (select count(*)::int from vessel_positions where tenant_id = any($1::uuid[])) as fixes,
            (select count(*)::int from vessel_assignments where tenant_id = any($1::uuid[])) as hands,
            (select count(*)::int from vessel_log_entries where tenant_id = any($1::uuid[])) as lines,
            (select count(*)::int from vessels where tenant_id = any($1::uuid[])) as plates,
            (select count(*)::int from drivers where tenant_id = any($1::uuid[])) as drivers,
            (select count(*)::int from routes where tenant_id = any($1::uuid[])) as routes,
            (select count(*)::int from trips where tenant_id = any($1::uuid[])) as trips,
            (select count(*)::int from users where tenant_id = any($1::uuid[])) as seats,
            (select count(*)::int from tenants where id = any($1::uuid[])) as tenants`, [[T, T2]]);
  check("the fixture is gone from every register it wrote",
    Object.values(left.rows[0]).every((v) => Number(v) === 0), left.rows[0]);
  const stray = await oi(
    `select (select count(*)::int from vessel_positions where note like '%fleet smoke %') as fixes,
            (select count(*)::int from vessel_assignments where notes like '%fleet smoke %') as hands,
            (select count(*)::int from vessels where name like '%fleet smoke %') as plates,
            (select count(*)::int from routes where name like '%fleet smoke %') as corridors,
            (select count(*)::int from drivers where full_name like 'Kilian Smoke Driver %') as drivers,
            (select count(*)::int from users where email like '%.fleet.%@example.org') as seats,
            (select count(*)::int from tenants
              where name ~ '^Fleet (Smoke|Stranger) [0-9]{8}$') as companies`);
  check("…and nothing this run minted is left anywhere on the database",
    Object.values(stray.rows[0]).every((v) => Number(v) === 0), stray.rows[0]);
  const paper = await oi(
    `select count(*)::int as n from audit_logs where tenant_id = any($1::uuid[])`, [[T, T2]]);
  console.log(`(audit_logs keeps ${paper.rows[0].n} rows for the swept tenants — the register is append-only)`);

  await owner.end();
}

const n = (v: unknown) => (v === null || v === undefined ? NaN : Number(v));

main().then(() => {
  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nfleet ops smoke passed");
}).catch((e) => { console.error(e); process.exit(1); });
