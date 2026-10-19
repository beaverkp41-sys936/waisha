/**
 * Driver pay smoke — migrations 094/095 and driver-pay.routes.ts walked end to end, with the
 * payroll seam they feed (task #173).
 *
 * Like the payroll smoke it runs on a throwaway company it creates and destroys: 094 puts one
 * agreement per driver and one row per (trip, driver) into a register that 095 carries onto a
 * payslip, so a half-cleaned fixture would mis-price a real month.
 *
 * What it exists to prove:
 *  - the accrual is a trigger, not a step in a route. A leg completed by the desk and a leg
 *    completed by a backfill produce the same kind of row, priced from the driver's own
 *    arrangement at the moment the trip became completed, dated the arrival rather than today;
 *  - each of the five bases does its own arithmetic, and the row that comes out agrees with
 *    its own label — the CHECK 094 put on quantity/rate/amount is asserted from the outside;
 *  - a missing arrangement leaves an honest trace instead of an exception. No driver, no
 *    terms, salary only and no seat each say something different in the gaps view, and the
 *    zero row a per-kilometre driver earns on an untraced route is kept rather than skipped;
 *  - the claim is keyed on the roster seat and has no lower bound. An October run does not pay
 *    September's legs once September has been issued, and a September leg registered after
 *    September was signed falls into the next unissued month instead of vanishing;
 *  - two drafts cannot pay one leg. Issuing re-derives the tenant's other drafts, cancelling
 *    releases them again — the second cheque is the one nobody notices;
 *  - the register is not deletable and a claimed row is not editable, by the desk or by the
 *    owner connection;
 *  - nobody types trip pay. There is no field for it on the line route, and a figure written
 *    through the back door is re-derived by the same write it arrived on;
 *  - the matrix. fleet_officer reads, only director and finance_officer set, and the seat that
 *    builds the roster sees none of it.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-driver-pay.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const COMPANY = `Driver Pay Smoke Haulers Ltd ${STAMP}`;
const SWEEP = `Driver Pay Smoke %`;
const P = "DPS";

const E_KM = `${P}Km Driver ${STAMP}`;
const E_TON = `${P}Tonne Driver ${STAMP}`;
const E_PCT = `${P}Freight-share Driver ${STAMP}`;
const E_FLAT = `${P}Flat Driver ${STAMP}`;
const E_SAL = `${P}Salaried Driver ${STAMP}`;
const E_LATE = `${P}Late Terms Driver ${STAMP}`;
const E_UNL = `${P}Unseated Driver ${STAMP}`;
const E_CLERK = `${P}Office Clerk ${STAMP}`;
const E_GONE = `${P}Leaver ${STAMP}`;

const D_KM = `${P}km driver ${STAMP}`;
const D_TON = `${P}tonne driver ${STAMP}`;
const D_PCT = `${P}percent driver ${STAMP}`;
const D_FLAT = `${P}flat driver ${STAMP}`;
const D_SAL = `${P}salary only driver ${STAMP}`;
const D_LATE = `${P}late terms driver ${STAMP}`;
const D_UNLINKED = `${P}unseated driver ${STAMP}`;
const D_NOTERMS = `${P}no terms driver ${STAMP}`;

const SAL: Record<string, number> = {
  [E_KM]: 500_000, [E_TON]: 400_000, [E_PCT]: 300_000, [E_FLAT]: 250_000,
  [E_SAL]: 200_000, [E_LATE]: 120_000, [E_UNL]: 100_000, [E_CLERK]: 150_000
};

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

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
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const g = (path: string, token: string | null) => call(path, token);
const pu = (path: string, token: string | null, body: { method: string; body: string }) =>
  call(path, token, body);

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) =>
  iso(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000));
const firstOfMonth = (s: string) => `${s.slice(0, 7)}-01`;
const addMonths = (s: string, n: number) =>
  iso(new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1 + n, 1)));
const lastOfMonth = (s: string) =>
  iso(new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0)));
const isWeekday = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
};
const weekdaysBetween = (from: string, to: string) => {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWeekday(d)) n++;
  return n;
};
const money = (n: number) => n.toFixed(2);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The expected figure, written here in JavaScript as an independent witness, in two languages
 * on purpose: if 094's accrual ever disagrees with the basis its own row claims, this is the
 * suite that says so.
 */
function priceFor(basis: string, rate: number, qty: number) {
  return money(round2(basis === "percent_of_freight" ? qty * rate / 100 : qty * rate));
}

/**
 * The register's gate refuses DELETE for every role — that is the point of it — so a fixture
 * leaves through the same exit the module gives a real office: cancel the run that claimed the
 * earnings, then take the rows with the gate held open for the statement. Without this a
 * crashed run would leave money permanently stamped as paid.
 */
async function teardown(oi: (sql: string, params?: any[]) => Promise<any>, tid: string,
  sweep = false) {
  await oi(`update payroll_runs set status = 'cancelled',
                   cancelled_by = coalesce(cancelled_by, $2::uuid),
                   cancelled_at = coalesce(cancelled_at, now()),
                   cancel_reason = coalesce(cancel_reason, 'Smoke teardown')
              where tenant_id = $1 and status = 'issued'`, [tid, randomUUID()]).catch(() => { });
  await oi("begin").catch(() => { });
  await oi(`alter table trip_pay_entries disable trigger trg_trip_pay_gate`).catch(() => { });
  for (const sql of [
    `delete from trip_pay_entries where tenant_id = $1`,
    `delete from driver_pay_terms where tenant_id = $1`,
    `delete from payroll_lines where tenant_id = $1`,
    `delete from payroll_runs where tenant_id = $1`,
    `delete from vessel_positions where tenant_id = $1`,
    `delete from vessel_assignments where tenant_id = $1`,
    `delete from trip_checkpoint_logs where tenant_id = $1`,
    `delete from trip_shipments where tenant_id = $1`,
    `delete from trips where tenant_id = $1`,
    `delete from routes where tenant_id = $1`,
    `delete from fuel_logs where tenant_id = $1`,
    `delete from incidents where tenant_id = $1`,
    `delete from vessels where tenant_id = $1`,
    `delete from drivers where tenant_id = $1`,
    `delete from employee_attendance where tenant_id = $1`,
    `delete from leave_requests where tenant_id = $1`,
    `delete from office_settings where tenant_id = $1`,
    `delete from company_profiles where tenant_id = $1`,
    `delete from employees where tenant_id = $1`
  ]) await oi(sql, [tid]).catch(() => { });
  await oi("commit").catch(() => { });
  await oi(`alter table trip_pay_entries enable trigger trg_trip_pay_gate`).catch(() => { });
  if (sweep) {
    const uids = (await oi(`select id from users where tenant_id = $1`, [tid]))
      .rows.map((r: any) => r.id);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    }
    await oi(`delete from users where tenant_id = $1`, [tid]).catch(() => { });
    await oi(`delete from tenants where id = $1`, [tid]).catch(() => { });
  }
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = async (sql: string, params: any[] = []) => owner.query(sql, params);

  const roleOf = async (k: string) => (await oi(
    `select id from roles where key = $1 and tenant_id is null`, [k])).rows[0]?.id as string;
  const roleKeys = ["director", "finance_officer", "hr_officer", "auditor",
    "fleet_manager", "dispatcher"];
  const roles: Record<string, string> = {};
  for (const k of roleKeys) {
    roles[k] = await roleOf(k);
    if (!roles[k]) throw new Error(`No global ${k} role`);
  }

  const T = randomUUID();
  const FOREIGN = "00000000-0000-7000-8000-000000000000";

  // A crashed run leaves its own stamp behind, and a stale issued payroll or claimed register
  // would make the first assertion of this run answer 409 before it started.
  const orphans = (await oi(`select id from tenants where name like $1`, [SWEEP]))
    .rows.map((r: any) => r.id as string);
  if (orphans.length) {
    console.log(`sweeping ${orphans.length} fixture company(ies) left by an earlier run`);
    for (const id of orphans) await teardown(oi, id, true);
  }
  await oi(`delete from rate_limits where bucket like 'payroll-build%'
              or bucket like 'driver-pay-accrue%'`).catch(() => { });

  // ---------- the month under test: the one that has entirely arrived ----------
  const period = firstOfMonth(addDays(firstOfMonth(iso(new Date())), -1));
  const monthEnd = lastOfMonth(period);
  const divisor = weekdaysBetween(period, monthEnd);
  const thisMonth = addMonths(period, 1);
  // The legs below are dated by day-of-month, so they are built from the YYYY-MM prefix;
  // `period` itself stays a full date because that is what the payroll routes are keyed on.
  const month = period.slice(0, 7);
  const today = iso(new Date());

  await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')`,
    [T, COMPANY]);
  await oi(`insert into company_profiles (id, tenant_id, company_name) values ($1,$2,$3)`,
    [randomUUID(), T, COMPANY]);
  await oi(`insert into office_settings (tenant_id, work_start, work_end, late_grace_minutes,
             annual_leave_days, timezone)
           values ($1, time '08:00', time '17:00', 15, 28, 'Africa/Dar_es_Salaam')`, [T]);

  const seats: [string, string, string][] = [
    [randomUUID(), "Driver Pay Smoke Director", "director"],
    [randomUUID(), "Driver Pay Smoke Finance", "finance_officer"],
    [randomUUID(), "Driver Pay Smoke HR", "hr_officer"],
    [randomUUID(), "Driver Pay Smoke Auditor", "auditor"],
    [randomUUID(), "Driver Pay Smoke Fleet", "fleet_manager"],
    [randomUUID(), "Driver Pay Smoke Dispatcher", "dispatcher"]
  ];
  const uDir = seats[0][0];
  const uFin = seats[1][0];
  const tok: Record<string, string> = {};
  for (const [id, name, role] of seats) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
              values ($1,$2,'staff',$3,'active',$4)`,
      [id, T, name, `${role}.${STAMP}@waisha.test`]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [id, roles[role]]);
  }
  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);
  for (const [id, , role] of seats) tok[role] = await mint(id, T, [role]);
  const dir = tok.director;
  const fin = tok.finance_officer;

  // ---------- the roster the earnings are paid into ----------
  const EMP: Record<string, string> = {};
  const roster: [string, number, string][] = [
    [E_KM, SAL[E_KM], "active"], [E_TON, SAL[E_TON], "active"], [E_PCT, SAL[E_PCT], "active"],
    [E_FLAT, SAL[E_FLAT], "active"], [E_SAL, SAL[E_SAL], "active"], [E_LATE, SAL[E_LATE], "active"],
    [E_UNL, SAL[E_UNL], "active"], [E_CLERK, SAL[E_CLERK], "active"], [E_GONE, 900_000, "left"]
  ];
  for (const [name, salary, status] of roster) {
    const id = randomUUID();
    EMP[name] = id;
    await oi(`insert into employees (id, tenant_id, full_name, job_title, department,
               employment_type, status, monthly_salary, hired_date)
             values ($1,$2,$3,$4,'Operations','permanent',$5,$6,date '2024-01-15')`,
      [id, T, name, name.includes("Clerk") ? "Accounts clerk" : "Driver", status, salary]);
  }

  // ---------- the drivers, and what each of them is paid for driving ----------
  const DRV: Record<string, string> = {};
  const mkDriver = async (name: string) => (await oi(
    `insert into drivers (tenant_id, full_name, status, phone_search)
     values ($1,$2,'available',$3) returning id`,
    [T, name, `ph-${STAMP}-${name.slice(-6)}`])).rows[0].id as string;
  for (const n of [D_KM, D_TON, D_PCT, D_FLAT, D_SAL, D_LATE, D_UNLINKED, D_NOTERMS])
    DRV[n] = await mkDriver(n);
  // Seeded straight in, because the desk's own way of writing an arrangement is
  // PUT /driver-pay/terms and phase 2 is what exercises it. These rows only have to exist
  // before the legs are completed: a leg is priced from the terms in front of it at the
  // moment it becomes completed, so terms set afterwards would test the re-price instead.
  const seedTerms = async (driver: string, basis: string, rate: number, employee?: string) => {
    await oi(`insert into driver_pay_terms
                (id, tenant_id, driver_id, employee_id, basis, rate, currency, created_by, updated_by)
              values ($1,$2,$3,$4,$5,$6,'TZS',$7,$7)`,
      [randomUUID(), T, DRV[driver], employee ? EMP[employee] : null, basis, rate, uDir]);
  };
  await seedTerms(D_TON, "per_tonne", 4000, E_TON);
  await seedTerms(D_FLAT, "per_trip", 75_000, E_FLAT);
  await seedTerms(D_SAL, "salary_only", 0, E_SAL);
  await seedTerms(D_UNLINKED, "per_trip", 50_000);          // earned, but nobody to pay it into
  // D_KM, D_PCT, D_LATE and D_NOTERMS are left without an arrangement on purpose: the first
  // two get theirs from the desk in phase 2 and 5, and the last one stays the register's
  // `no_terms` gap for the whole run.

  // ---------- the fleet, the corridors and the legs ----------
  const V1 = (await oi(`insert into vessels (tenant_id, name, vessel_type, plate_number,
                        odometer_km, status)
                        values ($1,$2,'truck_head',$3,1000,'standby') returning id`,
    [T, `${P}Vessel ${STAMP}`, `DPS${STAMP}1`])).rows[0].id as string;
  const mkRoute = async (label: string, km: number | null, traced = false) => (await oi(
    `insert into routes (tenant_id, name, origin_text, dest_text, distance_km,
                         origin_lat, origin_lng, dest_lat, dest_lng)
     values ($1,$2,'Dar es Salaam','Kigali',$3,$4,$5,$6,$7) returning id`,
    [T, `${P}${label} ${STAMP}`, km, traced ? -6.8 : null, traced ? 39.2 : null,
     traced ? -1.9 : null, traced ? 30.06 : null])).rows[0].id as string;
  const R_LONG = await mkRoute("long", 412);
  const R_NEAR = await mkRoute("near", 97);
  const R_BLANK = await mkRoute("blank", null);
  const R_TODAY = await mkRoute("today", 300, true);

  let seq = 0;
  /**
   * A leg is inserted already arrived, with its own arrival date, and completed by a second
   * statement. Deliberate: `trip_pay_accrue` takes `earned_on` from the arrival, so a fixture
   * that let the clock complete it would put every September figure in October's money and
   * prove nothing about which month claims what.
   */
  const mkLeg = async (driver: string | null, route: string, km: number | null,
    earnedOn: string, cargo: [number | null, number | null][] = [], vessel: string | null = null) => {
    seq++;
    const id = randomUUID();
    await oi(`insert into trips (id, tenant_id, reference, route_id, vessel_id, driver_id,
               status, planned_departure, actual_departure, actual_arrival, distance_km,
               notes, created_by, updated_by)
             values ($1,$2,$3,$4,$5,$6,'arrived',$7::timestamptz,$7::timestamptz,
                     $7::timestamptz,$8,$9,$10,$10)`,
      [id, T, `${P}L${seq} ${STAMP}`, route, vessel, driver ? DRV[driver] : null,
       `${earnedOn}T10:00:00Z`, km, `smoke leg ${seq}`, uDir]);
    for (const [kg, freight] of cargo) {
      await oi(`insert into trip_shipments (id, tenant_id, trip_id, customer_name,
                 goods_description, package_count, weight_kg, freight_charge, created_by, updated_by)
               values ($1,$2,$3,'Driver Pay Smoke Cargo','Smoke goods',5,$4,$5,$6,$6)`,
        [randomUUID(), T, id, kg, freight, uDir]);
    }
    return id;
  };

  // Each leg is one sentence about one basis; the figure it must produce is written beside it.
  const L: Record<string, string> = {};
  L.kmLong = await mkLeg(D_KM, R_LONG, 412, `${month}-08`, [], V1);   // 412 x 250      = 103,000.00
  L.kmShort = await mkLeg(D_KM, R_NEAR, 97, `${month}-19`);            //  97 x 250      =  24,250.00
  L.kmNoDistance = await mkLeg(D_KM, R_BLANK, null, `${month}-25`);     //    0 km        =      0.00
  L.tonnes = await mkLeg(D_TON, R_LONG, 500, `${month}-11`,
    [[14500, 900000], [6000, 400000]]);                                 // 20.5 t x 4,000 =  82,000.00
  L.freight = await mkLeg(D_PCT, R_LONG, 620, `${month}-15`,
    [[9000, 1200000], [4000, 350000]]);                                 // 1,550,000 x 12.5% = 193,750.00
  L.flat = await mkLeg(D_FLAT, R_NEAR, 97, `${month}-28`);              // one leg        =  75,000.00
  L.seatless = await mkLeg(D_UNLINKED, R_NEAR, 97, `${month}-05`);       // one leg        =  50,000.00
  L.salary = await mkLeg(D_SAL, R_NEAR, 97, `${month}-12`);              // salary only   -> no row
  L.noDriver = await mkLeg(null, R_NEAR, 97, `${month}-13`);              // no driver     -> no row
  L.noTerms = await mkLeg(D_NOTERMS, R_NEAR, 97, `${month}-16`);          // no arrangement -> gap
  L.lateTerms = await mkLeg(D_LATE, R_NEAR, 97, `${month}-21`);            // no terms yet   -> no row
  L.notYet = await mkLeg(D_FLAT, R_NEAR, 97, `${month}-23`);                // still arrived  -> nothing owed
  const LATE_DAY = `${month}-21`;

  // September's money, per roster seat. Every payroll assertion below is measured against this.
  const SEPT: Record<string, number> = {
    [E_KM]: 103_000 + 24_250 + 0, [E_TON]: 82_000, [E_PCT]: 193_750, [E_FLAT]: 75_000,
    [E_SAL]: 0, [E_LATE]: 60_000, [E_UNL]: 50_000, [E_CLERK]: 0
  };
  const septTotal = Object.values(SEPT).reduce((a, b) => a + b, 0);   // 588,000
  const OCT_WANTED = 100_000;      // 800,000 of freight x 12.5%, earned today
  const LATE_LEG = 75_000;          // a September leg that appears after the month was built
  // What the register holds before phase 5 gives the late driver his arrangement: everything
  // except his own leg, plus the leg the desk completed through the API today.
  const EARLY_TOTAL = septTotal - SEPT[E_LATE] + OCT_WANTED;          // 628,000

  // Two absences for the kilometre driver: the day arithmetic and the leg arithmetic must not
  // lean on each other, and a fixture where everybody was present would miss that.
  for (const day of [`${month}-03`, `${month}-04`]) {
    await oi(`insert into employee_attendance
                (id, tenant_id, employee_id, work_date, day_status, note, created_by, updated_by)
              values ($1,$2,$3,$4::date,'absent','Smoke no-show',$5,$5)`,
      [randomUUID(), T, EMP[E_KM], day, seats[2][0]]);
  }

  const terms = "/driver-pay/terms";
  const register = "/driver-pay/register";
  let septRunId = "";
  let octRunId = "";

  try {
    // =========================================================================
    phase("1 · the seats driver pay is not for");
    const anon = await g(terms, null);
    check("the terms desk without a seat → 401", anon.status === 401, anon.status);
    const hrRead = await g(terms, tok.hr_officer);
    check("hr_officer — the seat that builds the roster — sees none of this",
      hrRead.status === 403, hrRead.status);
    const dispRead = await g(register, tok.dispatcher);
    check("nor does a dispatcher, who is the person the register is about → 403",
      dispRead.status === 403, dispRead.status);
    const hrSet = await pu(`${terms}/${DRV[D_KM]}`, tok.hr_officer, {
      method: "PUT", body: JSON.stringify({ basis: "per_km", rate: 1 })
    });
    check("the seat that owns the roster cannot set a driver's pay → 403",
      hrSet.status === 403, hrSet.status);
    const audSet = await pu(`${terms}/${DRV[D_KM]}`, tok.auditor, {
      method: "PUT", body: JSON.stringify({ basis: "per_km", rate: 1 })
    });
    check("nor can the auditor, who is only ever meant to see it → 403",
      audSet.status === 403, audSet.status);
    const fleetRead = await g(terms, tok.fleet_manager);
    check("a fleet manager reads every arrangement, so a per-tonne argument is explainable",
      fleetRead.status === 200 && (fleetRead.json?.drivers ?? []).length === 8,
      { s: fleetRead.status, n: (fleetRead.json?.drivers ?? []).length });
    check("and is told what each basis means in the desk's own words",
      fleetRead.json?.basisLabels?.per_tonne === "per tonne actually carried",
      fleetRead.json?.basisLabels);
    const fleetSet = await pu(`${terms}/${DRV[D_KM]}`, tok.fleet_manager, {
      method: "PUT", body: JSON.stringify({ basis: "per_km", rate: 1 })
    });
    check("reading an arrangement and setting one are different duties → 403",
      fleetSet.status === 403, fleetSet.status);
    const foreign = await g(terms, await mint(uDir, FOREIGN, ["director"]));
    check("another company's director is let in and given nothing",
      foreign.status === 200 && (foreign.json?.drivers ?? []).length === 0,
      { s: foreign.status, n: (foreign.json?.drivers ?? []).length });
    const foreignReg = await g(register, await mint(uDir, FOREIGN, ["director"]));
    check("the register is emptied by the same wall, not by a filter the route forgot",
      foreignReg.status === 200 && (foreignReg.json?.entries ?? []).length === 0
        && foreignReg.json?.totals?.unpaid_count === 0,
      { s: foreignReg.status, t: foreignReg.json?.totals });
    const noSeatTerms = await g(`${terms}?driverId=${DRV[D_KM]}`, tok.fleet_manager);
    check("one driver's row can be asked for on its own",
      noSeatTerms.json?.drivers?.length === 1
        && noSeatTerms.json.drivers[0].driver_name === D_KM, noSeatTerms.json?.drivers?.length);

    // =========================================================================
    phase("2 · setting an arrangement, and the refusals on the way");
    const noRate = await pu(`${terms}/${DRV[D_FLAT]}`, fin, {
      method: "PUT", body: JSON.stringify({ basis: "per_trip", rate: 0 })
    });
    check("a flat rate of nothing is refused, and says which field",
      noRate.status === 400 && /rate/.test(JSON.stringify(noRate.json)), noRate.json);
    check("in the words the desk needs, not a constraint name",
      /needs a rate above zero/.test(JSON.stringify(noRate.json)), noRate.json);
    const negative = await pu(`${terms}/${DRV[D_KM]}`, fin, {
      method: "PUT", body: JSON.stringify({ basis: "per_km", rate: -250 })
    });
    check("a negative rate never reaches the database → 400", negative.status === 400, negative.status);
    const goneSeat = await pu(`${terms}/${DRV[D_FLAT]}`, fin, {
      method: "PUT", body: JSON.stringify({ basis: "per_trip", rate: 75000, employeeId: EMP[E_GONE] })
    });
    check("a seat that is not an active employee cannot be paid through",
      goneSeat.status === 400 && /employeeId/.test(JSON.stringify(goneSeat.json)), goneSeat.json);
    const clash = await pu(`${terms}/${DRV[D_PCT]}`, fin, {
      method: "PUT", body: JSON.stringify({ basis: "percent_of_freight", rate: 12.5, employeeId: EMP[E_TON] })
    });
    check("two drivers on one payslip line is refused, and names the driver already in that seat",
      clash.status === 409 && /tonne driver/.test(JSON.stringify(clash.json)), clash.json);
    const notThere = await pu(`${terms}/${randomUUID()}`, fin, {
      method: "PUT", body: JSON.stringify({ basis: "per_km", rate: 250 })
    });
    check("a driver who is not on this company's books → 404", notThere.status === 404, notThere.status);
    const sneaked = await pu(`${terms}/${DRV[D_PCT]}`, fin, {
      method: "PUT", body: JSON.stringify({ basis: "percent_of_freight", rate: 12.5, amount: 999 })
    });
    check("a typed earnings figure is not a thing an arrangement accepts → 400",
      sneaked.status === 400, sneaked.status);
    const pctOk = await pu(`${terms}/${DRV[D_PCT]}`, fin, {
      method: "PUT",
      body: JSON.stringify({ basis: "percent_of_freight", rate: 12.5, employeeId: EMP[E_PCT] })
    });
    check("the same share claimed through the driver's own seat is accepted → 200",
      pctOk.status === 200 && pctOk.json?.basis === "percent_of_freight", pctOk.json);
    check("a percentage is stored to four places, not rounded to a whole percent",
      pctOk.json?.rate === "12.5000", pctOk.json?.rate);
    const salOnly = await pu(`${terms}/${DRV[D_SAL]}`, fin, {
      method: "PUT",
      body: JSON.stringify({ basis: "salary_only", rate: 4321, employeeId: EMP[E_SAL] })
    });
    check("salary only keeps no rate at all, whatever was typed with it",
      salOnly.status === 200 && Number(salOnly.json?.rate) === 0, salOnly.json?.rate);
    check("and says so in the meaning the desk is shown",
      salOnly.json?.basis_meaning === "salary only — driving earns nothing extra",
      salOnly.json?.basis_meaning);
    const kmOk = await pu(`${terms}/${DRV[D_KM]}`, fin, {
      method: "PUT", body: JSON.stringify({ basis: "per_km", rate: 250, employeeId: EMP[E_KM] })
    });
    check("the kilometre driver's arrangement is written → 200",
      kmOk.status === 200 && kmOk.json?.employee_name === E_KM, kmOk.json);
    const seatsRead = (await g(terms, fin)).json;
    check("the roster seats an arrangement may name are read back with their salaries",
      seatsRead?.employees?.length === 8 && seatsRead.employees.every((e: any) =>
        !!e.id && Number(e.monthly_salary) > 0), seatsRead?.employees?.length);
    check("and a person who left is not one of the seats an arrangement can pick",
      !seatsRead.employees.some((e: any) => e.full_name === E_GONE), seatsRead?.employees
        ?.map((e: any) => e.full_name));

    // =========================================================================
    phase("3 · a leg becomes completed, and the register writes itself");
    await oi(`update trips set status = 'completed', updated_at = now()
               where id = any($1::uuid[]) and tenant_id = $2`,
      [Object.values(L).filter((id) => id !== L.notYet), T]);
    const priced = await oi(
      `select t.reference, e.basis, e.rate::text as rate, e.quantity::text as quantity,
              e.amount::text as amount, to_char(e.earned_on,'YYYY-MM-DD') as earned_on,
              e.employee_id, e.paid_run_id
         from trips t join trip_pay_entries e on e.trip_id = t.id
        where t.tenant_id = $1 order by t.reference`, [T]);
    const byRef = (frag: string) => priced.rows.find((r: any) => String(r.reference).includes(frag));
    check("every priced leg carries the figure its own basis says",
      byRef("L1 ")?.amount === priceFor("per_km", 250, 412)
        && byRef("L2 ")?.amount === priceFor("per_km", 250, 97)
        && byRef("L4 ")?.amount === priceFor("per_tonne", 4000, 20.5)
        && byRef("L5 ")?.amount === priceFor("percent_of_freight", 12.5, 1_550_000)
        && byRef("L6 ")?.amount === "75000.00" && byRef("L7 ")?.amount === "50000.00",
      priced.rows.map((r: any) => `${String(r.reference).slice(2, 6)}=${r.amount}`));
    check("the kilometre rows count the trip's own snapshot, not the route's",
      byRef("L2 ")?.quantity === "97.000", byRef("L2 "));
    check("the tonne row is the cargo it actually carried, to three places",
      byRef("L4 ")?.quantity === "20.500", byRef("L4 "));
    check("the share-of-freight row counts the freight the trip charged, not the tonnes",
      byRef("L5 ")?.quantity === "1550000.000" && byRef("L5 ")?.basis === "percent_of_freight",
      byRef("L5 "));
    check("a per-kilometre leg on a route with no distance is priced at zero and KEPT",
      byRef("L3 ")?.amount === "0.00", byRef("L3 "));
    check("the money is dated by the arrival, not by the day the trigger happened to run",
      byRef("L1 ")?.earned_on === `${month}-08` && byRef("L6 ")?.earned_on === `${month}-28`,
      { a: byRef("L1 ")?.earned_on, b: byRef("L6 ")?.earned_on });
    check("nothing is claimed by any run yet",
      priced.rows.every((r: any) => r.paid_run_id === null), priced.rows[0]);
    const legCount = await oi(
      `select count(*)::int as entries from trip_pay_entries where tenant_id = $1`, [T]);
    check("one row per (trip, driver), and no row for a leg with nobody named on it",
      legCount.rows[0].entries === 7, legCount.rows[0]);
    const unpriced = await oi(
      `select count(*)::int as n from trips t
         left join trip_pay_entries e on e.trip_id = t.id and e.driver_id = t.driver_id
        where t.tenant_id = $1 and t.status = 'completed' and e.id is null`, [T]);
    check("a salary-only driver, a leg with no driver named, and two legs whose driver has no "
      + "arrangement leave no row rather than raising",
      unpriced.rows[0].n === 4, unpriced.rows[0]);

    // The desk's own completion path, priced on the day it happens.
    const liveLeg = await pu("/trips", dir, {
      method: "POST", body: JSON.stringify({
        routeId: R_TODAY, vesselId: V1, driverId: DRV[D_PCT],
        reference: `${P}live ${STAMP}`, notes: "completed by the desk"
      })
    });
    check("the desk can plan a leg on a corridor that has a distance", liveLeg.status === 201,
      liveLeg.json);
    const tripId = liveLeg.json?.id as string;
    const cargo = await pu(`/trips/${tripId}/shipments`, dir, {
      method: "POST", body: JSON.stringify({
        customerName: "Driver Pay Smoke Cargo", goodsDescription: "Sacks of cement",
        packageCount: 18, weightKg: 9000, freightCharge: 800000
      })
    });
    check("and put the freight on it before it goes → 201", cargo.status === 201, cargo.json);
    for (const st of ["in_transit", "arrived", "completed"]) {
      const s = await pu(`/trips/${tripId}/status`, dir, {
        method: "PUT", body: JSON.stringify({ status: st })
      });
      check(`a leg driven by the desk reaches ${st} → 200`, s.status === 200, s.json);
    }
    const liveReg = await g(`${register}?driverId=${DRV[D_PCT]}&state=unpaid`, fin);
    const live = (liveReg.json?.entries ?? []).find((e: any) => e.trip_id === tripId);
    check("the same trigger prices it the moment the desk marks it completed",
      live?.amount === priceFor("percent_of_freight", 12.5, 800_000), live);
    check("dated the day it arrived, which is this month's money rather than last month's",
      live?.earned_on === today, { got: live?.earned_on, wanted: today });
    check("and the desk's route reads the ledger, not a copy of it",
      Number(liveReg.json?.totals?.unpaid_total) === EARLY_TOTAL, liveReg.json?.totals);

    // =========================================================================
    phase("4 · the register as the desk reads it");
    const reg = (await g(register, dir)).json;
    const sumOf = (rows: any[]) =>
      rows.reduce((s, e) => s + Math.round(Number(e.amount) * 100), 0) / 100;
    check("the ledger foots to September's money plus today's leg",
      reg.totals.unpaid_count === 8
        && Number(reg.totals.unpaid_total) === EARLY_TOTAL, reg.totals);
    check("and states the money with no seat on it separately from the money that has one",
      reg.totals.unlinked_count === 1 && Number(reg.totals.unlinked_total) === 50_000,
      reg.totals);
    const gapOf = (r: string) => (reg.gaps ?? []).find((x: any) => x.reason === r)?.trips ?? 0;
    check("the gaps name the legs that ran and were never priced, reason by reason",
      gapOf("no_driver") === 1 && gapOf("no_terms") === 2 && gapOf("salary_only") === 1,
      reg.gaps);
    check("a leg that is only arrived is not a gap — it has not earned anything yet",
      gapOf("missing_entry") === 0 && gapOf("no_roster_seat") === 0, reg.gaps);
    const oneOnly = (await g(`${register}?limit=1`, dir)).json;
    check("a window of one row does not shrink the company's own totals",
      oneOnly.entries.length === 1 && oneOnly.returned === 1
        && oneOnly.totals.unpaid_count === 8 && oneOnly.gaps.length === reg.gaps.length,
      { n: oneOnly.entries.length, t: oneOnly.totals.unpaid_count });
    const inSept = (await g(`${register}?from=${period}&to=${monthEnd}`, fin)).json;
    check("the month window reads only September's earnings",
      inSept.entries.length === 7 && inSept.entries.every((e: any) =>
        e.earned_on >= period && e.earned_on <= monthEnd),
      { n: inSept.entries.length, window: inSept.window });
    check("while the whole company's waiting money is still stated beside it",
      Number(inSept.totals.unpaid_total) === EARLY_TOTAL, inSept.totals);
    const bySeat = (await g(`${register}?employeeId=${EMP[E_KM]}`, tok.auditor)).json;
    check("one person's legs come back as their own list, and foot",
      bySeat.entries.length === 3 && Number(sumOf(bySeat.entries)) === SEPT[E_KM],
      { n: bySeat.entries.length, sum: sumOf(bySeat.entries) });
    check("a row says what the trip was called and who drove it, so a disputed leg is findable",
      bySeat.entries.every((e: any) => !!e.trip_reference
        && !!e.driver_name && e.trip_status === "completed"), bySeat.entries[0]);
    check("and the leg that had a vehicle names the plate that moved it — the ones that had none stay blank",
      bySeat.entries.find((e: any) => e.trip_id === L.kmLong)?.plate_number === `DPS${STAMP}1`
        && !bySeat.entries.find((e: any) => e.trip_id === L.kmShort)?.plate_number,
      bySeat.entries.map((e: any) => [e.trip_reference, e.plate_number]));
    check("and the state filter separates what is paid from what is waiting",
      (await g(`${register}?state=paid`, dir)).json.entries.length === 0, "state=paid");

    // =========================================================================
    phase("5 · the desk fixes the legs its arrangements were missing for");
    const seatless = await pu(`${terms}/${DRV[D_UNLINKED]}`, fin, {
      method: "PUT",
      body: JSON.stringify({ basis: "per_trip", rate: 50000, employeeId: EMP[E_UNL] })
    });
    check("naming a seat for a driver re-links the earnings already on the register",
      seatless.status === 200 && seatless.json?.entries_relinked === 1, seatless.json);
    const relinkRow = (await oi(
      `select employee_id, amount::text as a, paid_run_id from trip_pay_entries
        where trip_id = $1`, [L.seatless])).rows[0];
    check("and the leg becomes payable without being re-priced",
      relinkRow?.employee_id === EMP[E_UNL] && relinkRow?.a === "50000.00"
        && relinkRow?.paid_run_id === null, relinkRow);
    const afterRelink = (await g(register, dir)).json;
    check("so the company's unpayable money goes to nothing",
      afterRelink.totals.unlinked_count === 0 && afterRelink.totals.unlinked_total === "0.00",
      afterRelink.totals);
    const lateFirst = await pu(`${terms}/${DRV[D_LATE]}`, fin, {
      method: "PUT", body: JSON.stringify({ basis: "per_trip", rate: 60000 })
    });
    check("an arrangement with no seat named is accepted, and is a state the desk can see",
      lateFirst.status === 200 && lateFirst.json?.employee_id === null, lateFirst.json);
    const seatGap = (await g(register, dir)).json;
    check("the leg it belongs to is then reported as unpayable rather than as unearned",
      (seatGap.gaps ?? []).find((x: any) => x.reason === "no_roster_seat")?.trips === 1,
      seatGap.gaps);
    check("and naming the seat does not invent the earning — it waits to be re-priced",
      (lateFirst.json?.entries_relinked ?? 1) === 0, lateFirst.json);
    const lateSecond = await pu(`${terms}/${DRV[D_LATE]}`, fin, {
      method: "PUT",
      body: JSON.stringify({ basis: "per_trip", rate: 60000, employeeId: EMP[E_LATE] })
    });
    check("naming the seat on a driver with no rows yet relinks nothing",
      lateSecond.status === 200 && lateSecond.json?.entries_relinked === 0, lateSecond.json);
    const beforeAccrue = (await g(register, dir)).json;
    check("and the gap moves to the one the re-price button answers",
      (beforeAccrue.gaps ?? []).find((x: any) => x.reason === "missing_entry")?.trips === 1,
      beforeAccrue.gaps);
    const accrued = await pu("/driver-pay/accrue", fin, {
      method: "POST", body: JSON.stringify({ driverId: DRV[D_LATE] })
    });
    check("re-pricing that driver prices the leg that ran",
      accrued.status === 200 && accrued.json?.tallies?.accrued === 1, accrued.json);
    check("and the answer is the arrangement's own arithmetic",
      Number(accrued.json?.sample?.[0]?.amount) === 60_000, accrued.json?.sample);
    const lateRow = (await oi(
      `select amount::text as a, to_char(earned_on,'YYYY-MM-DD') as d, employee_id
         from trip_pay_entries where trip_id = $1`, [L.lateTerms])).rows[0];
    check("dated the arrival it actually happened on, not the afternoon it was fixed",
      lateRow?.a === priceFor("per_trip", 60000, 1) && lateRow?.d === LATE_DAY
        && lateRow?.employee_id === EMP[E_LATE], lateRow);
    const afterGaps = (await g(register, dir)).json;
    check("the gaps close behind it, and the legs still waiting on an arrangement are one",
      afterGaps.gaps.find((x: any) => x.reason === "missing_entry") === undefined
        && (afterGaps.gaps ?? []).find((x: any) => x.reason === "no_terms")?.trips === 1,
      afterGaps.gaps);
    check("and the register now holds September's whole money",
      Number(afterGaps.totals.unpaid_total) === septTotal + OCT_WANTED, afterGaps.totals);
    const againSame = await pu("/driver-pay/accrue", dir, {
      method: "POST", body: JSON.stringify({ tripId: L.flat })
    });
    check("re-pricing a leg already on the register is a re-read, not a second row",
      againSame.json?.tallies?.repriced === 1, againSame.json);
    const oneFlat = (await oi(
      `select count(*)::int as n, sum(amount)::text as total from trip_pay_entries
        where trip_id = $1`, [L.flat])).rows[0];
    check("and the figure stands exactly where it was",
      oneFlat.n === 1 && oneFlat.total === "75000.00", oneFlat);
    const arrivedLeg = await pu("/driver-pay/accrue", dir, {
      method: "POST", body: JSON.stringify({ tripId: L.notYet })
    });
    check("a leg that has not completed cannot be priced, and says so → 409",
      arrivedLeg.status === 409 && /completed/.test(JSON.stringify(arrivedLeg.json)),
      arrivedLeg.json);
    const notATrip = await pu("/driver-pay/accrue", dir, {
      method: "POST", body: JSON.stringify({ tripId: randomUUID() })
    });
    check("a leg belonging to nobody is refused the same way → 409", notATrip.status === 409,
      notATrip.status);
    const extraKey = await pu("/driver-pay/accrue", dir, {
      method: "POST", body: JSON.stringify({ tripId: L.flat, actor: "me" })
    });
    check("the re-price takes nothing but the legs it was asked for → 400", extraKey.status === 400,
      extraKey.status);
    const noAuth = await pu("/driver-pay/accrue", null, { method: "POST", body: "{}" });
    check("and it is not an open door → 401", noAuth.status === 401, noAuth.status);
    const hrAccrue = await pu("/driver-pay/accrue", tok.hr_officer, {
      method: "POST", body: JSON.stringify({ driverId: DRV[D_KM] })
    });
    check("the seat that cannot read the register cannot re-price it either → 403",
      hrAccrue.status === 403, hrAccrue.status);

    // =========================================================================
    phase("6 · September's pay, previewed before it is committed");
    const pv = (await g(`/payroll/preview?period=${period}`, fin)).json;
    const pvOf = (name: string) => (pv.lines ?? []).find((l: any) => l.employee_name === name);
    const drift: string[] = [];
    for (const [name, wanted] of Object.entries(SEPT)) {
      const l = pvOf(name);
      if (!l) { drift.push(`${name} missing from the preview`); continue; }
      if (String(l.trip_pay_amount) !== money(wanted))
        drift.push(`${name} shows ${l.trip_pay_amount}, wanted ${money(wanted)}`);
    }
    check("the preview already shows every driver's trip pay, before a run exists",
      drift.length === 0, drift);
    check("with September's waiting money inside it and today's leg outside it",
      Number(pv.totals.trip_pay_total) === septTotal && pv.totals.headcount === 8,
      { t: pv.totals.trip_pay_total, h: pv.totals.headcount });
    const kmPrev = pvOf(E_KM);
    const kmBase = round2(SAL[E_KM] * (divisor - 2) / divisor);
    check("trip pay does not touch the days, and the days do not touch trip pay",
      kmPrev.days_paid === divisor - 2 && kmPrev.base_amount === money(kmBase)
        && kmPrev.trip_pay_amount === money(SEPT[E_KM])
        && kmPrev.net_amount === money(round2(kmBase + SEPT[E_KM])), kmPrev);
    check("and the legs underneath the figure name the trips that made it",
      (kmPrev.detail?.trip_pay ?? []).length === 3 && kmPrev.detail?.trip_pay_count === 3
        && String(kmPrev.detail?.trip_pay_total) === money(SEPT[E_KM]), kmPrev.detail?.trip_pay);
    check("the preview is the desk's own reading, taken with no run in front of it",
      pvOf(E_SAL).trip_pay_amount === "0.00" && pvOf(E_CLERK).net_amount === money(SAL[E_CLERK]),
      { sal: pvOf(E_SAL)?.trip_pay_amount, clerk: pvOf(E_CLERK)?.net_amount });

    const built = await pu("/payroll/runs", fin, { method: "POST", body: JSON.stringify({ period }) });
    check("the month builds → 201", built.status === 201, built.json);
    septRunId = built.json?.id as string;
    const builtOf = (name: string) =>
      (built.json?.lines ?? []).find((l: any) => l.employee_name === name);
    let mismatch = "";
    for (const name of Object.keys(SEPT)) {
      const a = pvOf(name), b = builtOf(name);
      if (!a || !b) { mismatch = `${name} missing on one side`; break; }
      for (const col of ["days_paid", "base_amount", "trip_pay_amount", "net_amount"])
        if (String(a[col]) !== String(b[col])) {
          mismatch = `${name} ${col}: preview ${a[col]} vs built ${b[col]}`;
          break;
        }
    }
    check("what the preview promised is exactly what the run wrote, trip pay included",
      mismatch === "", mismatch);
    check("the run foots its own trip pay out of its lines",
      built.json?.trip_pay_total === money(septTotal)
        && Math.abs(Number(built.json?.gross_total) - (built.json?.lines ?? [])
          .reduce((s: number, l: any) => s + Number(l.base_amount) + Number(l.trip_pay_amount), 0))
          < 0.005,
      { trip: built.json?.trip_pay_total, gross: built.json?.gross_total });
    check("and net still equals gross plus adjustments, with the bonus inside gross",
      Math.abs(Number(built.json?.net_total) - Number(built.json?.gross_total)
        - Number(built.json?.adjustment_total)) < 0.005, built.json);
    check("so a trip bonus is never a side total the summary forgets",
      Math.abs(Number(built.json?.net_total) - Number(built.json?.trip_pay_total)
        - (built.json?.lines ?? []).reduce((s: number, l: any) => s + Number(l.base_amount), 0))
        < 0.005, { net: built.json?.net_total, trip: built.json?.trip_pay_total });

    // =========================================================================
    phase("7 · nobody types a trip-pay figure, not even the owner connection");
    const typed = await pu(`/payroll/lines/${builtOf(E_KM).id}`, fin, {
      method: "PUT",
      body: JSON.stringify({ adjustmentAmount: 0, tripPayAmount: 400000 })
    });
    check("the line route has no field for it → 400", typed.status === 400, typed.json);
    await oi(`update payroll_lines set trip_pay_amount = 999999 where id = $1`,
      [builtOf(E_KM).id]).then(() => "written").catch((e: any) => String(e.message));
    const afterType = (await oi(
      `select trip_pay_amount::text as a, net_amount::text as n, base_amount::text as b
         from payroll_lines where id = $1`, [builtOf(E_KM).id])).rows[0];
    check("a figure written through the back door is re-derived by the same write",
      afterType?.a === money(SEPT[E_KM]), afterType);
    check("and the net that comes out still foots base plus legs plus adjustment",
      afterType?.n === money(round2(Number(afterType?.b) + Number(afterType?.a))), afterType);
    const clerkPriced = (await oi(
      `select count(*)::int as n from trip_pay_entries where employee_id = $1`,
      [EMP[E_CLERK]]))
      .rows[0];
    check("a driver is never paid through an office seat by accident",
      clerkPriced.n === 0, clerkPriced);

    // =========================================================================
    phase("8 · a September leg that arrives after the month was built");
    const lateLeg = await mkLeg(D_FLAT, R_NEAR, 97, `${month}-30`);
    await oi(`update trips set status = 'completed' where id = $1`, [lateLeg]);
    const panel = (await g(`/payroll/runs/${septRunId}/trip-pay`, dir)).json;
    check("the run says so itself: the register is ahead of the document by one leg",
      panel.lines_out_of_date === 1 && Number(panel.totals.stored) === septTotal
        && Number(panel.totals.current) === septTotal + LATE_LEG, panel.totals);
    check("and it names the person whose line is behind rather than just the difference",
      panel.lines.filter((l: any) => l.drift).length === 1
        && panel.lines.find((l: any) => l.drift)?.employee_name === E_FLAT,
      panel.lines.filter((l: any) => l.drift));
    check("the leg is on that line as its own entry, with the day it earned",
      panel.lines.find((l: any) => l.drift)?.entries?.length === 2
        && panel.lines.find((l: any) => l.drift)?.entries
          .some((e: any) => e.earned_on === `${month}-30`),
      panel.lines.find((l: any) => l.drift)?.entries);
    check("while the company-wide waiting money is stated beside it",
      Number(panel.totals.company_waiting.total) === septTotal + LATE_LEG + OCT_WANTED,
      panel.totals.company_waiting);
    const reRun = await pu(`/payroll/runs/${septRunId}/rebuild`, fin, { method: "POST", body: "null" });
    check("a rebuild takes the late leg in — a driver is not short paid by a calendar",
      reRun.status === 200 && reRun.json?.trip_pay_total === money(septTotal + LATE_LEG),
      { s: reRun.status, t: reRun.json?.trip_pay_total });
    const flatAfter = (reRun.json?.lines ?? []).find((l: any) => l.employee_name === E_FLAT);
    const kmAfter = (reRun.json?.lines ?? []).find((l: any) => l.employee_name === E_KM);
    check("and only that person's line moves",
      flatAfter?.trip_pay_amount === money(SEPT[E_FLAT] + LATE_LEG)
        && kmAfter?.trip_pay_amount === money(SEPT[E_KM]),
      { flat: flatAfter?.trip_pay_amount, km: kmAfter?.trip_pay_amount });
    const afterPanel = (await g(`/payroll/runs/${septRunId}/trip-pay`, dir)).json;
    check("and the run stops telling the desk it is behind",
      afterPanel.lines_out_of_date === 0 && Number(afterPanel.totals.drift) === 0,
      afterPanel.totals);

    // =========================================================================
    phase("9 · two drafts must not pay one leg twice");
    const octBuild = await pu("/payroll/runs", fin, {
      method: "POST", body: JSON.stringify({ period: thisMonth })
    });
    check("this month is built while September is still a draft → 201",
      octBuild.status === 201, octBuild.json);
    octRunId = octBuild.json?.id as string;
    check("and with no lower bound on the claim it sweeps up everything unclaimed",
      Number(octBuild.json?.trip_pay_total) === septTotal + LATE_LEG + OCT_WANTED,
      { oct: octBuild.json?.trip_pay_total, wanted: septTotal + LATE_LEG + OCT_WANTED });
    check("which is exactly the double payment the claim has to prevent",
      (octBuild.json?.lines ?? []).find((l: any) => l.employee_name === E_PCT)
        ?.trip_pay_amount === money(SEPT[E_PCT] + OCT_WANTED),
      (octBuild.json?.lines ?? []).find((l: any) => l.employee_name === E_PCT));
    const audList = await g("/payroll/runs", tok.auditor);
    check("the auditor reads both drafts and signs neither",
      (audList.json?.runs ?? []).length === 2, { s: audList.status, n: (audList.json?.runs ?? []).length });
    const audIssue = await pu(`/payroll/runs/${septRunId}/issue`, tok.auditor, {
      method: "POST", body: "null"
    });
    check("signing is a separate duty from running → 403", audIssue.status === 403, audIssue.status);
    const issued = await pu(`/payroll/runs/${septRunId}/issue`, fin, {
      method: "POST", body: JSON.stringify({ paymentReference: `DPS-${STAMP}`, paidOn: monthEnd })
    });
    check("finance issues September → 200", issued.status === 200, issued.json);
    check("issuing claims the month's earnings into the document",
      issued.json?.trip_pay_settled?.claimed === true
        && issued.json?.trip_pay_settled?.entries === 9,
      issued.json?.trip_pay_settled);
    check("and its own lines were re-priced on the way, so nothing registered since is lost",
      issued.json?.trip_pay_settled?.lines === 8 && issued.json?.trip_pay_total ===
      money(septTotal + LATE_LEG), issued.json?.trip_pay_settled);
    check("while re-deriving the draft behind it, so one leg is paid once",
      Number(issued.json?.trip_pay_settled?.drafts_refreshed?.[octRunId] ?? 0) === 8,
      issued.json?.trip_pay_settled?.drafts_refreshed);
    const octNow = (await g(`/payroll/runs/${octRunId}`, fin)).json;
    check("October is left with only what September did not take",
      Number(octNow.trip_pay_total) === OCT_WANTED
        && (octNow.lines ?? []).find((l: any) => l.employee_name === E_PCT)
          ?.trip_pay_amount === money(OCT_WANTED),
      { total: octNow.trip_pay_total });
    check("and the other driver's October line is honestly empty rather than doubled",
      (octNow.lines ?? []).find((l: any) => l.employee_name === E_KM)
        ?.trip_pay_amount === "0.00",
      (octNow.lines ?? []).find((l: any) => l.employee_name === E_KM)?.trip_pay_amount);
    const claimState = (await oi(
      `select count(*) filter (where paid_run_id = $1)::int as sept,
              count(*) filter (where paid_run_id is null)::int as waiting,
              coalesce(sum(amount) filter (where paid_run_id is null), 0)::text as waiting_total
         from trip_pay_entries where tenant_id = $2`, [septRunId, T])).rows[0];
    check("the register itself says which rows the signed document took",
      claimState.sept === 9 && claimState.waiting === 1
        && Number(claimState.waiting_total) === OCT_WANTED, claimState);
    const paidView = (await g(`${register}?state=paid`, dir)).json;
    check("and the desk sees them as paid, with the month that paid them named",
      paidView.entries.length === 9
        && paidView.entries.every((e: any) => e.paid_period === period
          && e.paid_run_status === "issued"),
      { n: paidView.entries.length, p: paidView.entries[0]?.paid_period });

    // =========================================================================
    phase("10 · an earning inside a signed payroll cannot be moved");
    const claimedId = (await oi(
      `select id from trip_pay_entries where trip_id = $1`, [L.kmLong])).rows[0].id;
    const editClaimed = await oi(`update trip_pay_entries set amount = 1 where id = $1`,
      [claimedId]).then(() => "written").catch((e: any) => String(e.message));
    check("a figure inside an issued run is refused by the database, whatever connection asks",
      /already inside run/.test(String(editClaimed)), editClaimed);
    const delClaimed = await oi(`delete from trip_pay_entries where id = $1`, [claimedId])
      .then(() => "deleted").catch((e: any) => String(e.message));
    check("and the register is never deleted out of, only corrected or cancelled",
      /not deleted/.test(String(delClaimed)), delClaimed);
    const repoint = await oi(`update trip_pay_entries set employee_id = $2 where id = $1`,
      [claimedId, EMP[E_CLERK]]).then(() => "written").catch((e: any) => String(e.message));
    check("a claimed row cannot be re-pointed at another person's line",
      /already inside run/.test(String(repoint)), repoint);
    const selfClaim = await oi(`update trip_pay_entries set paid_run_id = $2 where id = $1`,
      [claimedId, octRunId])
      .then(() => "written").catch((e: any) => String(e.message));
    check("and it cannot be claimed by a second run through a bare update",
      /already inside run/.test(String(selfClaim)), selfClaim);
    const release = await oi(`update trip_pay_entries set paid_run_id = null where id = $1`,
      [claimedId]).then(() => "written").catch((e: any) => String(e.message));
    check("releasing a stamp through the back door is the one write the gate lets a claimed "
      + "row take — and the route never offers it, so the next checks re-stamp it",
      release === "written", release);
    const restamped = await oi(`update trip_pay_entries set paid_run_id = $2 where id = $1`,
      [claimedId, septRunId]).then(() => "written").catch((e: any) => String(e.message));
    check("and putting the stamp back on is allowed the same way", restamped === "written",
      restamped);
    const repricedClaimed = await pu("/driver-pay/accrue", dir, {
      method: "POST", body: JSON.stringify({ tripId: L.kmLong })
    });
    check("the re-price button reports a claimed leg and leaves it alone",
      repricedClaimed.json?.tallies?.claimed === 1, repricedClaimed.json);
    const stillSept = (await oi(
      `select amount::text as a, paid_run_id from trip_pay_entries where id = $1`, [claimedId])).rows[0];
    check("left it exactly as the payslip said",
      stillSept.a === "103000.00" && stillSept.paid_run_id === septRunId, stillSept);
    const raised = await pu(`${terms}/${DRV[D_KM]}`, fin, {
      method: "PUT", body: JSON.stringify({ basis: "per_km", rate: 900, employeeId: EMP[E_KM] })
    });
    check("a rate raised afterwards relinks nothing that a run has taken",
      raised.status === 200 && raised.json?.entries_relinked === 0, raised.json);
    const afterRate = (await oi(
      `select amount::text as a from trip_pay_entries where trip_id = $1`, [L.kmLong])).rows[0];
    check("the row the office signed off is the row that stays",
      afterRate.a === "103000.00", afterRate);
    const settleTwice = await oi(`select public.trip_pay_settle($1, true, $2)`, [septRunId, uFin])
      .then((r) => JSON.stringify(r.rows[0])).catch((e: any) => String(e.message));
    check("settle answers a run that is no longer a draft instead of claiming again",
      /Only a draft run claims trip pay/.test(settleTwice), settleTwice);
    const lineEdit = await pu(`/payroll/lines/${(await oi(
      `select id from payroll_lines where run_id = $1 limit 1`, [septRunId])).rows[0].id}`, fin, {
      method: "PUT", body: JSON.stringify({ adjustmentAmount: 5000, adjustmentLabel: "Too late" })
    });
    check("and the issued month's lines are frozen, trip pay or not → 409",
      lineEdit.status === 409, lineEdit.status);
    const driftOnIssued = (await g(`/payroll/runs/${septRunId}/trip-pay`, tok.auditor)).json;
    check("an issued run still tells the truth about the register it was signed against",
      driftOnIssued.run?.status === "issued"
        && Number(driftOnIssued.totals.stored) === septTotal + LATE_LEG
        && Number(driftOnIssued.totals.company_waiting.total) === OCT_WANTED,
      { s: driftOnIssued.run?.status, t: driftOnIssued.totals });
    const noRun = await g(`/payroll/runs/${randomUUID()}/trip-pay`, dir);
    check("a panel for a run that is not this company's → 404", noRun.status === 404, noRun.status);

    // =========================================================================
    phase("11 · the slip, and the register the office is audited from");
    const septFull = (await g(`/payroll/runs/${septRunId}`, dir)).json;
    const kmLine = (septFull.lines ?? []).find((l: any) => l.employee_name === E_KM);
    const slip = (await g(`/payroll/runs/${septRunId}/payslip/${kmLine.id}`, tok.auditor)).json;
    check("the slip foots: the days it paid, plus the legs driven, plus what was typed",
      Math.round((Number(slip.base_amount) + Number(slip.trip_pay_amount)
        + Number(slip.adjustment_amount)) * 100) === Math.round(Number(slip.net_amount) * 100),
      { base: slip.base_amount, trip: slip.trip_pay_amount, net: slip.net_amount });
    check("and it shows the legs behind the figure, each with its basis, rate and day",
      (slip.detail?.trip_pay ?? []).length === 3 && (slip.detail?.trip_pay ?? [])
        .every((e: any) => e.basis && e.rate && e.quantity && e.amount && e.earned_on
          && e.reference),
      slip.detail?.trip_pay);
    check("with the days the register charged still on it, so the two stories agree",
      (slip.detail?.absence_dates ?? []).length === 2 && slip.days_paid === divisor - 2,
      { abs: slip.detail?.absence_dates, d: slip.days_paid });
    check("the letterhead and the name that signed it are on the same sheet",
      slip.company_name === COMPANY && slip.issued_by_name === "Driver Pay Smoke Finance",
      { co: slip.company_name, by: slip.issued_by_name });
    const leaky = Object.keys(slip).filter((k) => /phone|nida|encrypt|email|address/i.test(k));
    check("and a payslip carries no contact or identity field", leaky.length === 0, leaky);
    const foreignSlip = await g(`/payroll/runs/${septRunId}/payslip/${kmLine.id}`,
      await mint(uDir, FOREIGN, ["director"]));
    check("another company cannot read this driver's slip",
      foreignSlip.status === 404 || foreignSlip.status === 403, foreignSlip.status);
    const salaryReg = (await g(`/payroll/register?from=${period}&to=${period}`, dir)).json;
    const regOf = (name: string) =>
      (salaryReg.employees ?? []).find((e: any) => e.full_name === name);
    check("the salary register totals the legs separately from the salary",
      Number(salaryReg.totals.trip_pay) === septTotal + LATE_LEG
        && Number(regOf(E_KM)?.trip_pay_total) === SEPT[E_KM],
      { total: salaryReg.totals.trip_pay, km: regOf(E_KM)?.trip_pay_total });
    check("and a person's total is salary plus legs, not salary alone",
      Number(regOf(E_PCT)?.net_total) === SEPT[E_PCT] + SAL[E_PCT], regOf(E_PCT));
    const regRows = (salaryReg.rows ?? []).filter((r: any) => r.full_name === E_KM);
    check("its rows carry their own trip pay, so one month can be argued alone",
      regRows.length === 1 && regRows[0].trip_pay_amount === money(SEPT[E_KM]), regRows);
    check("and the register's totals foot from its people with the legs inside them",
      Math.abs(Number(salaryReg.totals.net) - (salaryReg.employees ?? [])
        .reduce((s: number, e: any) => s + Number(e.net_total), 0)) < 0.005, salaryReg.totals);

    // =========================================================================
    phase("12 · a late leg, and the only way out of a signed month");
    const frozenLeg = await mkLeg(D_KM, R_NEAR, 50, `${month}-29`);
    await oi(`update trips set status = 'completed' where id = $1`, [frozenLeg]);
    const frozenRow = (await oi(
      `select amount::text as a, paid_run_id, employee_id from trip_pay_entries where trip_id = $1`,
      [frozenLeg])).rows[0];
    check("a September leg completed after the month was signed is registered, not lost",
      frozenRow.a === priceFor("per_km", 900, 50) && frozenRow.paid_run_id === null, frozenRow);
    check("at the rate the arrangement says now, which is what the desk asked for",
      frozenRow.a === "45000.00", frozenRow);
    const issuedAgain = await pu(`/payroll/runs/${septRunId}/issue`, fin, { method: "POST", body: "null" });
    const stillUnclaimed = (await oi(
      `select paid_run_id from trip_pay_entries where trip_id = $1`, [frozenLeg])).rows[0];
    check("and re-issuing a signed month does not reach into the register for it",
      issuedAgain.json?.already === true && stillUnclaimed.paid_run_id === null,
      issuedAgain.json);
    const cancelNoReason = await pu(`/payroll/runs/${septRunId}/cancel`, fin, {
      method: "POST", body: JSON.stringify({})
    });
    check("a month cannot be un-signed without saying why → 400",
      cancelNoReason.status === 400, cancelNoReason.status);
    const cancelled = await pu(`/payroll/runs/${septRunId}/cancel`, dir, {
      method: "POST",
      body: JSON.stringify({ reason: "One driver's September legs were miscounted" })
    });
    check("a cancel releases every earning the run had claimed → 200",
      cancelled.status === 200 && cancelled.json?.trip_pay_released?.entries === 9,
      cancelled.json?.trip_pay_released);
    check("and re-derives the draft behind it, which now owes that money again",
      Number(cancelled.json?.trip_pay_released?.drafts_refreshed?.[octRunId] ?? 0) === 8,
      cancelled.json?.trip_pay_released);
    const octAfter = (await g(`/payroll/runs/${octRunId}`, fin)).json;
    check("so October pays September's late legs instead of losing them",
      Number(octAfter.trip_pay_total) === septTotal + LATE_LEG + OCT_WANTED
        + Number(frozenRow.a), { oct: octAfter.trip_pay_total });
    const kmOct = (octAfter.lines ?? []).find((l: any) => l.employee_name === E_KM);
    check("with the leg that arrived after the signature inside it, dated its own September day",
      kmOct?.trip_pay_amount === money(SEPT[E_KM] + Number(frozenRow.a))
        && (kmOct?.detail?.trip_pay ?? []).some((e: any) => e.earned_on === `${month}-29`),
      { a: kmOct?.trip_pay_amount, legs: kmOct?.detail?.trip_pay?.map((e: any) => e.earned_on) });
    const septAfter = (await g(`/payroll/runs/${septRunId}`, dir)).json;
    check("the cancelled document keeps saying what it said, lines and all",
      Number(septAfter.trip_pay_total) === septTotal + LATE_LEG
        && (septAfter.lines ?? []).length === 8, septAfter.trip_pay_total);
    const openRegister = (await g(register, dir)).json;
    check("and the ledger opens again: nothing claimed, everything still owed",
      openRegister.totals.claimed_count === 0
        && Number(openRegister.totals.unpaid_total) === septTotal + LATE_LEG + OCT_WANTED
          + Number(frozenRow.a), openRegister.totals);
    check("with no money left without a seat now that every driver is named",
      openRegister.totals.unlinked_count === 0, openRegister.totals);
    const cancelledSlip = await g(`/payroll/runs/${septRunId}/payslip/${kmLine.id}`, tok.auditor);
    check("a cancelled month still prints the slip it was signed on",
      cancelledSlip.status === 200 && cancelledSlip.json?.status === "cancelled",
      { s: cancelledSlip.status, st: cancelledSlip.json?.status });
    const reIssue = await pu(`/payroll/runs/${septRunId}/issue`, fin, { method: "POST", body: "null" });
    check("a cancelled month cannot be issued again, so its earnings are not double-taken → 409",
      reIssue.status === 409, reIssue.status);

    // =========================================================================
    phase("13 · every act is on the record");
    const audit = await oi(
      `select action, entity, after from audit_logs
        where tenant_id = $1 and (action like 'driver_pay.%' or action like 'payroll.%')
        order by ts`, [T]);
    const actions = audit.rows.map((r: any) => r.action);
    check("setting an arrangement and re-pricing the register are both audited",
      ["driver_pay.terms_set", "driver_pay.register_repriced"].every((a) => actions.includes(a)),
      actions);
    check("and the payroll acts that moved a driver's money are on the same record",
      ["payroll.run.built", "payroll.run.rebuilt", "payroll.run.issued", "payroll.run.cancelled"]
        .every((a) => actions.includes(a)), actions);
    const setRow = audit.rows.find((r: any) => r.action === "driver_pay.terms_set"
      && r.after?.driver === D_KM);
    check("the terms entry says who, on what basis, at what rate, into which seat",
      setRow?.after?.basis === "per_km" && setRow?.after?.employee === E_KM, setRow?.after);
    const repriceRow = audit.rows.find((r: any) => r.action === "driver_pay.register_repriced");
    check("the re-price records the tallies the desk was answered with",
      !!repriceRow?.after?.tallies, repriceRow?.after);
    const issueRow = audit.rows.find((r: any) => r.action === "payroll.run.issued");
    check("the issue states the trip pay that was signed off and how much was claimed",
      Number(issueRow?.after?.tripPayTotal) === septTotal + LATE_LEG
        && issueRow?.after?.tripPayClaimed?.entries === 9, issueRow?.after);
    const cancelRow = audit.rows.find((r: any) => r.action === "payroll.run.cancelled");
    check("and the cancel states what it released",
      cancelRow?.after?.tripPayReleased?.entries === 9, cancelRow?.after);
    const relinkRowAudit = audit.rows.filter((r: any) => r.action === "driver_pay.terms_set")
      .find((r: any) => r.after?.entries_relinked === 1);
    check("a re-link is on the record with the number of earnings it moved",
      !!relinkRowAudit, audit.rows.length);

    check("nothing in this suite left a leg priced at a figure that disagrees with its own basis",
      (await oi(
        `select count(*)::int as n from trip_pay_entries
          where tenant_id = $1
            and ((basis = 'percent_of_freight' and amount <> round(quantity * rate / 100, 2))
              or (basis <> 'percent_of_freight' and amount <> round(quantity * rate, 2)))`,
        [T])).rows[0].n === 0);
  } finally {
    if (septRunId) {
      await oi(`update payroll_runs set status = 'cancelled',
                       cancelled_by = coalesce(cancelled_by, $2::uuid),
                       cancelled_at = coalesce(cancelled_at, now()),
                       cancel_reason = coalesce(cancel_reason, 'Smoke teardown')
                  where id = $1 and status = 'issued'`, [septRunId, uDir]).catch(() => { });
    }
    // sweep=true: this company and its six seats were made by the fixture, so they all go.
    // (audit_logs keeps its rows — the trail outlives the company that made it.)
    await teardown(oi, T, true);
    await oi(`delete from rate_limits where bucket like 'payroll-build%'
                or bucket like 'driver-pay-accrue%'`).catch(() => { });

    const left = await oi(
      `select
        (select count(*) from trip_pay_entries where tenant_id = $1)::int as entries,
        (select count(*) from driver_pay_terms where tenant_id = $1)::int as terms,
        (select count(*) from trips where tenant_id = $1)::int as trips,
        (select count(*) from payroll_lines where tenant_id = $1)::int as lines,
        (select count(*) from payroll_runs where tenant_id = $1)::int as runs,
        (select count(*) from employees where tenant_id = $1)::int as staff,
        (select count(*) from drivers where tenant_id = $1)::int as drivers,
        (select count(*) from users where tenant_id = $1)::int as seats,
        (select count(*) from tenants where id = $1)::int as tenant`, [T]);
    console.log(`\ncleanup: ${JSON.stringify(left.rows[0])}`);
    const armed = await oi(
      `select tgname, tgenabled from pg_trigger
        where tgrelid = 'trip_pay_entries'::regclass and not tgisinternal order by tgname`);
    check("the register's gate is left armed for the next company",
      armed.rows.length > 0 && armed.rows.every((r: any) => r.tgenabled === "O"), armed.rows);
    console.log("(audit rows are append-only by design and stay — a pay trail outlives the company that made it)");
    await owner.end();
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall driver-pay smoke checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
