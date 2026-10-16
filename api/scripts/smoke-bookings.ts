/**
 * Step 6 — booking state machine + server-side timers smoke (spec Part 2).
 *
 * Expects the API on :4000, booted with the Step 6 build and
 * INTERNAL_TICK_SECRET in its environment. Builds three probe tenants — one
 * CFA that publishes, two transporters that compete for its loads — plus a
 * role that must not book. Proves: the instant a transporter books, the load
 * is hidden from every other transporter, and a latecomer gets a spoken
 * message, never a 500; two simultaneous Books resolve to exactly one winner
 * with exactly one live booking row; the publisher confirms, declines (load
 * goes straight back on the board) and cancels a confirmed booking with a
 * reason (kept and audited); the booker releases a hold and can cancel a
 * confirmed booking; the 6h reminder and 12h auto-release come from the
 * database under its own predicates, so a second tick — even racing the
 * in-process loop — changes nothing; the tick endpoint refuses any caller
 * without the server-side secret; every transition is permission-checked and
 * tenant-scoped; my-bookings never crosses tenants. Everything is cleaned up.
 * Run: npx tsx scripts/smoke-bookings.ts   (DNS_FALLBACK=1 if DNS is broken)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET);
const TICK_SECRET = process.env.INTERNAL_TICK_SECRET ?? "";
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label, String(detail).slice(0, 260)); }
}

async function mint(sub: string, tid: string, typ: string, roles: string[]) {
  return new SignJWT({ tid, sid: "00000000-7000-8000-0000-0000000000bb", typ, roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("1h").sign(key);
}

async function call(path: string, token: string | null, init: any = {}) {
  const headers: any = { ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts: any = { ...init, headers };
  if (opts.body !== undefined && !opts.method) opts.method = "POST";
  const res = await fetch(API + path, opts);
  let body: any = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}
const json = (body: any) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const post = (body: any) => ({ method: "POST", ...json(body) });
const bare = { method: "POST" };

/** The internal scheduler endpoint: header secret, never a user token. */
async function tick(secret: string | null) {
  const headers: any = {};
  if (secret !== null) headers["x-internal-secret"] = secret;
  const res = await fetch(API + "/internal/booking-timers/tick", { method: "POST", headers });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shiftDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasMsg = (b: unknown, re: RegExp) => re.test(JSON.stringify(b));

/** Poll a condition (DB end-state), because the in-process 60s loop can race a manual tick. */
async function until(fn: () => Promise<boolean>, ms = 75_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(1500);
  }
  return false;
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const health = await fetch(API + "/health").then(r => r.json()).catch(() => null);
  if (!health) { console.error("API not running on :4000 — boot it first"); process.exit(1); }
  if (!TICK_SECRET) console.error("INTERNAL_TICK_SECRET missing here — tick auth checks will fail");

  const NAMES = ["Bookprobe Cargo Ltd", "Bookprobe Freight One Ltd", "Bookprobe Freight Two Ltd",
    "Bookprobe Cargo Unready Ltd"];
  // alert_reads first: it references users, so it must go before them.
  const WIPE = ["alert_reads", "transport_bookings", "transport_requests", "job_handovers",
    "job_documents", "job_activity", "cargo_tasks", "job_stages", "jobs", "cargo_shipments",
    "documents", "routes", "company_profiles", "sessions", "otp_codes", "password_resets"];
  const wipeAll = async (ids: string[]) => {
    if (!ids.length) return;
    for (const t of WIPE) await owner.query(`delete from ${t} where tenant_id = any($1::uuid[])`, [ids]);
    await owner.query(`delete from user_roles where user_id in
      (select id from users where tenant_id = any($1::uuid[]))`, [ids]);
    await owner.query(`delete from users where tenant_id = any($1::uuid[])`, [ids]);
    await owner.query(`delete from tenants where id = any($1::uuid[])`, [ids]);
  };
  const stale = (await owner.query(
    `select id from tenants where name = any($1::text[])`, [NAMES])).rows.map(r => r.id);
  await wipeAll(stale);
  if (stale.length) console.log("pre-clean removed", stale.length, "stale probe tenants");

  const TA = randomUUID(), T1 = randomUUID(), T2 = randomUUID(), T3 = randomUUID();
  const uA = randomUUID(), uT1 = randomUUID(), uT2 = randomUUID(), uBlocked = randomUUID(),
    uT3 = randomUUID();
  const ROUTE_A = randomUUID();
  const ids = [TA, T1, T2, T3, uA, uT1, uT2, uBlocked, uT3];

  const roleOf = async (k: string) => (await owner.query(
    `select id from roles where key = $1 and tenant_id is null`, [k])).rows[0]?.id;
  const directorRole = await roleOf("director");
  const traineeRole = await roleOf("trainee");

  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter',$2)`, [TA, NAMES[0]]);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter',$2)`, [T1, NAMES[1]]);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter',$2)`, [T2, NAMES[2]]);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter',$2)`, [T3, NAMES[3]]);
  for (const [t, n, code, fleet, year] of [
    [TA, NAMES[0], "BKC", 24, 2012], [T1, NAMES[1], "BK1", 9, 2018], [T2, NAMES[2], "BK2", 4, 2022]
  ] as [string, string, string, number, number][]) {
    await oi(`insert into company_profiles (id, tenant_id, company_name, company_code,
               description, services_offered, corridors_served, website,
               fleet_size_declared, year_established,
               transport_licence_no, transport_licence_expiry)
             values ($1,$2,$3,$4,'Freight desk for the booking smoke','Haulage, clearing',
               'Dar - Arusha - Namanga',$3 || '.bookprobe.example',$5,$6,
               $4 || '-TZ-LIC', now() + interval '365 days')`,
      [randomUUID(), t, n, code, fleet, year]);
  }
  // T3 stays WITHOUT a profile on purpose — the onboarding-readiness probe.
  for (const [u, t, name, email] of [
    [uA, TA, "Cargo Director", "cargo.director@bookprobe.example"],
    [uT1, T1, "Freight One Director", "one.director@bookprobe.example"],
    [uT2, T2, "Freight Two Director", "two.director@bookprobe.example"],
    [uBlocked, T1, "Freight One Trainee", "one.trainee@bookprobe.example"],
    [uT3, T3, "Unready Director", "unready.director@bookprobe.example"]
  ] as [string, string, string, string][]) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
              values ($1,$2,'staff',$3,'active',$4)`, [u, t, name, email]);
  }
  for (const u of [uA, uT1, uT2, uT3]) await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [u, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uBlocked, traineeRole]);

  const regions = (await owner.query(
    `select id, name_en, lat, lng from geo_regions
      where country = 'TZ' and is_active and lat is not null and lng is not null
      order by id limit 3`)).rows;
  if (regions.length < 2) { console.error("geo_regions seed missing"); process.exit(1); }

  await oi(`insert into routes (id, tenant_id, name, origin_region_id, dest_region_id,
             distance_km, expected_duration_hours, rate_per_km, created_by, updated_by)
            values ($1,$2,'Cargo corridor',$3,$4,610,14,915.25,$5,$5)`,
    [ROUTE_A, TA, regions[0].id, regions[1].id, uA]);

  const tokA = await mint(uA, TA, "director", ["director"]);
  const tokT1 = await mint(uT1, T1, "director", ["director"]);
  const tokT2 = await mint(uT2, T2, "director", ["director"]);
  const tokBlocked = await mint(uBlocked, T1, "staff", ["trainee"]);
  const tokT3 = await mint(uT3, T3, "director", ["director"]);

  // Two transporter lists worth of bookings, tracked so isolation is provable.
  const t1Ids = new Set<string>(), t2Ids = new Set<string>(), t3Ids = new Set<string>();

  async function newFile(tok: string, consignee: string) {
    const c = await call("/cargo", tok, post({
      shipmentType: "import", containerType: "40ft", containerCount: 2,
      containerNumbers: ["BKPU7654321", "BKPU1122334"], cargoDescription: "Ceramic tiles",
      hsCode: "6907.21.00", declarationMode: "PSSL", tansadNumber: "TSAD-7711221",
      rcnNumber: "RCN-7711222", billNumber: "BL-BK-0001", shippingLine: "Ocean Line Agency",
      cabinetPosition: "YARD-C2", termsDelivery: "CIF", consigneeName: consignee,
      consignorName: consignee.replace("Trading", "Supplier"), weightTonnes: 26, cbm: 28,
      eta: shiftDays(2), dischargeDate: shiftDays(4), carryInDate: shiftDays(5),
      nominatedIcd: "TPIC Dar", borderPoint: "Namanga", processingCost: 4700000,
      paymentAmount: 1100000, paymentStatus: "partial", notes: "Call before delivery"
    }));
    const s = c.body?.id;
    const j = s ? (await call("/jobs", tok)).body?.find?.((x: any) => x.shipment_id === s) : null;
    return { shipment: s, job: j?.id, created: c.status };
  }

  // ---- five cargo files, five jobs, five consent records, five publishes ----
  const files: { shipment: string; job: string }[] = [];
  for (let i = 1; i <= 5; i++) {
    const f = await newFile(tokA, `Bookprobe Client ${i} Trading`);
    if (!f.job) { console.error("cargo/job fixture failed", i, f); process.exit(1); }
    files.push(f as { shipment: string; job: string });
  }
  check("five probe cargo files opened with their job pipelines", true);

  for (const f of files) {
    const d = await call(`/jobs/${f.job}/decision`, tokA,
      json({ recordKind: "live", transportNeeded: true, consent: "granted" }));
    if (d.status !== 200) { console.error("consent failed", d.status, d.body); process.exit(1); }
  }

  const R: string[] = [];
  for (let i = 0; i < 5; i++) {
    const p = await call(`/jobs/${files[i].job}/transport-request`, tokA, post({
      cargoLabel: `Bookprobe load ${i + 1}, 2 x 40ft`, containerType: "40ft", containerCount: 2,
      weightTonnes: 26, cbm: 28, vehicleTypes: ["truck_head", "trailer"], routeId: ROUTE_A,
      pickupText: "TPIC Dar es Salaam", pickupRegionId: regions[0].id,
      destText: "Arusha", destRegionId: regions[1].id, viaLabel: "Namanga border",
      requiredDate: shiftDays(3 + i), contactName: "Cargo Director",
      contactChannel: "desk@cargo.bookprobe.example",
      publicNote: "Weekly departures, tarpaulin available"
    }));
    if (p.status !== 201) { console.error("publish failed", i + 1, p.status, p.body); process.exit(1); }
    R.push(p.body.id);
  }
  const [R1, R2, R3, R4, R5] = R;
  check("five requests published by the CFA", R.length === 5 && R.every(Boolean));

  const bookBody = (name = "Booker Desk", channel = "desk@booker.bookprobe.example") =>
    ({ contactName: name, contactChannel: channel });
  const withdraw = (tok: string, id: string) => call(`/transport-requests/${id}/cancel`, tok, bare);
  const reqRow = async (id: string) => (await owner.query(
    `select status, released_at, confirmed_at, reminder_sent_at, temp_booked_at,
            booked_company_name, booked_contact_name,
            booked_company_description, booked_company_services, booked_company_corridors,
            booked_fleet_size, booked_year_established, booked_licence_no,
            booked_licence_expiry::text as booked_licence_expiry
       from transport_requests where id = $1`, [id])).rows[0];
  const bkRow = async (id: string) => (await owner.query(
    `select status, ended_at, ended_by, ended_reason, reminder_sent_at, temp_booked_at,
            booker_description, booker_services, booker_corridors, booker_fleet_size,
            booker_year_established, booker_licence_no,
            booker_licence_expiry::text as booker_licence_expiry
       from transport_bookings where id = $1`, [id])).rows[0];

  // ================= 1. who may book =================
  const anon = await call(`/board/${R1}/book`, null, post(bookBody()));
  check("a signed-out caller cannot book", anon.status === 401, `[${anon.status}]`);
  const blockedBook = await call(`/board/${R1}/book`, tokBlocked, post(bookBody()));
  check("a role without board.book cannot book", blockedBook.status === 403, `[${blockedBook.status}]`);
  const blockedMine = await call("/my-bookings", tokBlocked);
  check("a role without board.book cannot list bookings", blockedMine.status === 403, `[${blockedMine.status}]`);
  const shortContact = await call(`/board/${R1}/book`, tokT1, post({ contactName: "x", contactChannel: "y" }));
  check("a too-short contact is refused before anything moves", shortContact.status === 400,
    `[${shortContact.status}]`);
  const own = await call(`/board/${R1}/book`, tokA, post(bookBody()));
  check("the publisher cannot book its own load", own.status === 409 && hasMsg(own.body, /own load/i),
    `[${own.status}] ${JSON.stringify(own.body)}`);

  // ================= 1b. onboarding readiness: profile + licence gate booking =================
  const readyT1 = await call("/board/readiness", tokT1);
  check("a company with a full profile and a live licence reads ready",
    readyT1.status === 200 && readyT1.body?.ready === true &&
      (readyT1.body?.items ?? []).every((i: any) => i.done),
    JSON.stringify(readyT1.body));
  const readyAnon = await call("/board/readiness", null);
  check("a signed-out caller cannot read a readiness checklist", readyAnon.status === 401, `[${readyAnon.status}]`);

  const readyT3a = await call("/board/readiness", tokT3);
  check("a company with no profile at all is not ready, and told what is required",
    readyT3a.status === 200 && readyT3a.body?.ready === false &&
      readyT3a.body?.items?.filter((i: any) => i.required && !i.done).map((i: any) => i.key)
        .sort().join(",") === "company_name,licence_expiry,licence_no",
    JSON.stringify(readyT3a.body));
  const bookT3a = await call(`/board/${R4}/book`, tokT3, post(bookBody("Unready Desk", "desk@unready.bookprobe.example")));
  check("booking without a profile is refused, naming the missing items",
    bookT3a.status === 409 && hasMsg(bookT3a.body, /not ready/i) &&
      (bookT3a.body?.error?.details ?? []).some((d: any) => d.field === "licence_no"),
    `[${bookT3a.status}] ${JSON.stringify(bookT3a.body)}`);

  // Profile on file, but the licence already lapsed — still not ready.
  await oi(`insert into company_profiles (id, tenant_id, company_name,
             transport_licence_no, transport_licence_expiry)
           values ($1,$2,'Bookprobe Cargo Unready Ltd','BK3-TZ-LIC', now() - interval '30 days')`,
    [randomUUID(), T3]);
  const readyT3b = await call("/board/readiness", tokT3);
  const expiryItem = (readyT3b.body?.items ?? []).find((i: any) => i.key === "licence_expiry");
  check("an expired licence keeps the company unready",
    readyT3b.body?.ready === false && expiryItem?.done === false &&
      String(expiryItem?.detail ?? "").toLowerCase().includes("expired"),
    JSON.stringify(readyT3b.body));
  const bookT3b = await call(`/board/${R4}/book`, tokT3, post(bookBody("Unready Desk", "desk@unready.bookprobe.example")));
  check("booking with an expired licence is refused too", bookT3b.status === 409, `[${bookT3b.status}]`);

  await oi(`update company_profiles set transport_licence_expiry = now() + interval '200 days'
             where tenant_id = $1`, [T3]);
  const readyT3c = await call("/board/readiness", tokT3);
  check("renewing the licence flips the company to ready", readyT3c.body?.ready === true,
    JSON.stringify(readyT3c.body));
  const bookT3c = await call(`/board/${R4}/book`, tokT3, post(bookBody("Unready Desk", "desk@unready.bookprobe.example")));
  check("a newly ready company books on the first try", bookT3c.status === 201 && !!bookT3c.body?.bookingId,
    `[${bookT3c.status}] ${JSON.stringify(bookT3c.body)}`);
  const b3u: string = bookT3c.body?.bookingId ?? "";
  if (b3u) t3Ids.add(b3u);
  const relT3 = await call(`/bookings/${b3u}/release`, tokT3, post({}));
  check("the readiness probe releases its hold and R4 is open again", relT3.status === 200 &&
    (await reqRow(R4)).status === "open", `[${relT3.status}]`);

  // ================= 2. the hold hides the load, the latecomer is told =================
  const before = await call("/board?limit=100", tokT2);
  const b1res = await call(`/board/${R1}/book`, tokT1, post(bookBody("Book One Desk", "desk@one.bookprobe.example")));
  check("the first book wins and reports the booking", b1res.status === 201 && !!b1res.body?.bookingId &&
    b1res.body?.company === NAMES[1], `[${b1res.status}] ${JSON.stringify(b1res.body)}`);
  const b1: string = b1res.body?.bookingId ?? "";
  if (b1) t1Ids.add(b1);

  // The booker's company card is snapshotted at booking time — both on the
  // request (for the publisher) and on the booking row (for the history).
  const snapReq = await reqRow(R1);
  const snapBk = await bkRow(b1);
  check("the booker's company card is copied onto the request at book time",
    snapReq.booked_company_description === "Freight desk for the booking smoke" &&
      snapReq.booked_fleet_size === 9 && snapReq.booked_year_established === 2018 &&
      snapReq.booked_licence_no === "BK1-TZ-LIC" && !!snapReq.booked_licence_expiry,
    JSON.stringify(snapReq));
  check("the same card is frozen onto the booking row itself",
    snapBk.booker_description === "Freight desk for the booking smoke" &&
      snapBk.booker_licence_no === "BK1-TZ-LIC" && !!snapBk.booker_licence_expiry,
    JSON.stringify(snapBk));

  const gone = await call(`/board/${R1}`, tokT2);
  check("the held load vanishes from the board for everyone else",
    gone.status === 404 && hasMsg(gone.body, /no longer on the board/i), `[${gone.status}]`);
  const after = await call("/board?limit=100", tokT2);
  check("the board list shrinks by exactly this one card, and the other four stay",
    after.body?.total === before.body?.total - 1 &&
      !(after.body?.rows ?? []).some((r: any) => r.id === R1) &&
      [R2, R3, R4, R5].every(id => (after.body?.rows ?? []).some((r: any) => r.id === id)),
    `before=${before.body?.total} after=${after.body?.total}`);
  const late = await call(`/board/${R1}/book`, tokT2, post(bookBody("Book Two Desk", "desk@two.bookprobe.example")));
  check("a latecomer gets the 'someone was faster' message, never a 500",
    late.status === 409 && hasMsg(late.body, /moments before/i), `[${late.status}] ${JSON.stringify(late.body)}`);

  const mineA = await call("/transport-requests?status=temp_booked", tokA);
  const holdRow = (mineA.body ?? []).find((r: any) => r.id === R1);
  check("the publisher still sees the load, marked held with the booker's card",
    holdRow?.status === "temp_booked" && holdRow?.booked_company_name === NAMES[1] &&
      holdRow?.booked_contact_name === "Book One Desk" && !!holdRow?.temp_booked_at,
    JSON.stringify(holdRow ?? mineA.body));

  const alertsA = await call("/notifications", tokA);
  check("the publisher's alert feed counts the hold down",
    (alertsA.body?.items ?? []).some((i: any) =>
      i.type === "booking_hold" && String(i.title).includes(NAMES[1])),
    JSON.stringify((alertsA.body?.items ?? []).slice(0, 3)));

  // ================= 2b. unread state on derived alerts =================
  const holdItem = (alertsA.body?.items ?? []).find((i: any) =>
    i.type === "booking_hold" && String(i.title).includes(NAMES[1]));
  const holdKey = String(holdItem?.key ?? "booking_hold:missing");
  check("the hold alert carries a stable key and starts unseen",
    typeof holdItem?.key === "string" && holdItem.key.length > 8 && holdItem?.seen === false &&
      (alertsA.body?.counts?.unread ?? 0) > 0,
    JSON.stringify({ key: holdItem?.key, seen: holdItem?.seen, counts: alertsA.body?.counts }));
  const anonRead = await call("/notifications/read", null, post({ all: true }));
  check("a signed-out caller cannot mark alerts read", anonRead.status === 401, `[${anonRead.status}]`);
  const emptyRead = await call("/notifications/read", tokA, post({}));
  check("marking read with neither keys nor all is refused", emptyRead.status === 400, `[${emptyRead.status}]`);
  const mark1 = await call("/notifications/read", tokA, post({ keys: [holdKey] }));
  check("marking one key reports exactly one new read",
    mark1.status === 200 && mark1.body?.marked === 1, `[${mark1.status}] ${JSON.stringify(mark1.body)}`);
  const mark1again = await call("/notifications/read", tokA, post({ keys: [holdKey] }));
  check("marking the same key again is idempotent",
    mark1again.status === 200 && mark1again.body?.marked === 0,
    `[${mark1again.status}] ${JSON.stringify(mark1again.body)}`);
  const seen1 = await call("/notifications", tokA);
  const seenHold = (seen1.body?.items ?? []).find((i: any) => i.key === holdKey);
  check("the refetch shows the key as seen and the unread count down by one",
    seenHold?.seen === true && seen1.body?.counts?.unread === (alertsA.body?.counts?.unread ?? 0) - 1,
    JSON.stringify({ seen: seenHold?.seen, unread: seen1.body?.counts?.unread,
      before: alertsA.body?.counts?.unread }));
  const unreadAfter1 = seen1.body?.counts?.unread ?? -1;
  const markAll = await call("/notifications/read", tokA, post({ all: true }));
  check("mark-all-read clears every remaining unread",
    markAll.status === 200 && markAll.body?.marked === unreadAfter1,
    `[${markAll.status}] ${JSON.stringify(markAll.body)} unreadAfter1=${unreadAfter1}`);
  const seen2 = await call("/notifications", tokA);
  check("nothing is left unread afterwards", seen2.body?.counts?.unread === 0,
    JSON.stringify(seen2.body?.counts));
  const seenHold2 = (seen2.body?.items ?? []).find((i: any) => i.key === holdKey);
  check("the alert itself still stands — read, not gone", seenHold2?.seen === true, JSON.stringify(seenHold2));

  // ================= 3. confirm, then cancel with a reason (R1) =================
  const cf = await call(`/transport-requests/${R1}/confirm`, tokA, bare);
  check("the publisher confirms the hold", cf.status === 200 && cf.body?.ok === true, `[${cf.status}]`);
  const cfAgain = await call(`/transport-requests/${R1}/confirm`, tokA, bare);
  check("confirming twice is refused as a conflict, not applied twice",
    cfAgain.status === 409 && hasMsg(cfAgain.body, /cancel it with a reason/i), `[${cfAgain.status}]`);

  const relConf = await call(`/bookings/${b1}/release`, tokT1, post({ reason: "plans changed" }));
  check("a confirmed booking cannot be 'released' — it needs a reasoned cancel",
    relConf.status === 409 && hasMsg(relConf.body, /cancel it with a reason/i), `[${relConf.status}]`);
  const shortCancel = await call(`/bookings/${b1}/cancel-booking`, tokT1, post({ reason: "x" }));
  check("cancelling a confirmed booking without a real reason is refused", shortCancel.status === 400,
    `[${shortCancel.status}]`);
  const t2Cancel = await call(`/transport-requests/${R1}/cancel-booking`, tokT2, post({ reason: "I want this load" }));
  const r1AfterOutsider = await reqRow(R1);
  check("a company that is not part of the booking cannot cancel it",
    t2Cancel.status >= 400 && r1AfterOutsider.status === "confirmed", `[${t2Cancel.status}]`);
  const crossRel = await call(`/bookings/${b1}/release`, tokT2, post({ reason: "mine now" }));
  check("another company cannot touch a booking that is not its own", crossRel.status === 404,
    `[${crossRel.status}]`);

  const cancelReason = "Client changed the delivery window";
  const cancel1 = await call(`/transport-requests/${R1}/cancel-booking`, tokA, post({ reason: cancelReason }));
  check("the publisher cancels the confirmed booking with a reason", cancel1.status === 200 && cancel1.body?.ok === true,
    `[${cancel1.status}] ${JSON.stringify(cancel1.body)}`);
  const r1 = await reqRow(R1);
  const k1 = await bkRow(b1);
  check("the request is open again, stamped with released_at",
    r1.status === "open" && !!r1.released_at, JSON.stringify(r1));
  check("the booking is cancelled, and the reason is kept",
    k1.status === "cancelled" && k1.ended_reason === cancelReason && !!k1.ended_at && k1.ended_by === uA,
    JSON.stringify(k1));
  // The audit entry lives on the request (entity_id = R1); the booking id and
  // the reason travel inside `after`.
  const audit = await owner.query(
    `select count(*)::int as n from audit_logs
      where entity_id = $1 and action = 'transport.booking_cancelled'
        and after->>'reason' = $2 and after->>'bookingId' = $3`, [R1, cancelReason, b1]);
  check("the reasoned cancellation is written to the audit trail", audit.rows[0].n >= 1,
    `audit rows=${audit.rows[0].n}`);
  check("the load is back on the board after the cancellation",
    (await call(`/board/${R1}`, tokT2)).status === 200);

  const wd = await withdraw(tokA, R1);
  check("the publisher withdraws the open request", wd.status === 200 && wd.body?.ok === true, `[${wd.status}]`);
  const wd2 = await withdraw(tokA, R1);
  check("withdrawing twice is idempotent", wd2.status === 200 && wd2.body?.ok === true, `[${wd2.status}]`);
  const bookGone = await call(`/board/${R1}/book`, tokT2, post(bookBody()));
  check("a withdrawn request cannot be booked", bookGone.status === 409 &&
    hasMsg(bookGone.body, /no longer on the board/i), `[${bookGone.status}]`);

  // ================= 4. decline returns the load, rebook, then release (R2) =================
  const b2res = await call(`/board/${R2}/book`, tokT2, post(bookBody("Book Two Desk", "desk@two.bookprobe.example")));
  check("a second transporter books a load", b2res.status === 201, `[${b2res.status}]`);
  const b2: string = b2res.body?.bookingId ?? "";
  if (b2) t2Ids.add(b2);

  const declineReason = "Rate too high for this corridor";
  const rej = await call(`/transport-requests/${R2}/reject`, tokA, post({ reason: declineReason }));
  check("the publisher declines the hold", rej.status === 200 && rej.body?.ok === true, `[${rej.status}]`);
  const r2a = await reqRow(R2);
  const k2 = await bkRow(b2);
  check("declining puts the load straight back on the board",
    r2a.status === "open" && !!r2a.released_at && (await call(`/board/${R2}`, tokT1)).status === 200);
  check("the declined booking keeps its reason",
    k2.status === "rejected" && k2.ended_reason === declineReason, JSON.stringify(k2));

  const b2bRes = await call(`/board/${R2}/book`, tokT1, post(bookBody("Book One Desk", "desk@one.bookprobe.example")));
  check("after a decline another company can book the same load",
    b2bRes.status === 201 && !!b2bRes.body?.bookingId && b2bRes.body.bookingId !== b2,
    `[${b2bRes.status}]`);
  const b2b: string = b2bRes.body?.bookingId ?? "";
  if (b2b) t1Ids.add(b2b);
  const activeR2 = await owner.query(
    `select count(*)::int as n from transport_bookings
      where request_id = $1 and status in ('temp_booked','confirmed')`, [R2]);
  check("exactly one live booking row sits on the load", activeR2.rows[0].n === 1,
    `active=${activeR2.rows[0].n}`);

  const releaseReason = "Truck broke down overnight";
  const rel2 = await call(`/bookings/${b2b}/release`, tokT1, post({ reason: releaseReason }));
  check("the booker releases its hold", rel2.status === 200 && rel2.body?.ok === true, `[${rel2.status}]`);
  const k2b = await bkRow(b2b);
  check("the released booking keeps its reason, the load is open again",
    k2b.status === "released" && k2b.ended_reason === releaseReason &&
      (await reqRow(R2)).status === "open", JSON.stringify(k2b));

  const alertsT2 = await call("/notifications", tokT2);
  check("the booker's feed shows the decline with the publisher's reason",
    (alertsT2.body?.items ?? []).some((i: any) =>
      i.type === "booking_mine_rejected" && String(i.detail).includes(declineReason)),
    JSON.stringify((alertsT2.body?.items ?? []).slice(0, 4)));
  const alertsA2 = await call("/notifications", tokA);
  check("the publisher's feed announces the load is back on the board",
    (alertsA2.body?.items ?? []).some((i: any) => i.type === "booking_released"),
    JSON.stringify((alertsA2.body?.items ?? []).slice(0, 4)));

  // ================= 5. the race: two simultaneous books, one winner (R5) =================
  const [raceA, raceB] = await Promise.all([
    call(`/board/${R5}/book`, tokT1, post(bookBody("Race Desk One", "one@race.bookprobe.example"))),
    call(`/board/${R5}/book`, tokT2, post(bookBody("Race Desk Two", "two@race.bookprobe.example")))
  ]);
  const statuses = [raceA.status, raceB.status].sort();
  const loser = raceA.status === 409 ? raceA : raceB;
  const winner = raceA.status === 201 ? raceA : raceB;
  const winTok = raceA.status === 201 ? tokT1 : tokT2;
  check("two simultaneous books resolve to exactly one winner",
    statuses[0] === 201 && statuses[1] === 409, JSON.stringify([raceA.status, raceB.status]));
  check("the loser is told, and not with an error page",
    loser.status === 409 && hasMsg(loser.body, /moments before/i), JSON.stringify(loser.body));
  const raceAct = await owner.query(
    `select id from transport_bookings
      where request_id = $1 and status in ('temp_booked','confirmed')`, [R5]);
  check("exactly one live booking row exists after the race",
    raceAct.rows.length === 1 && raceAct.rows[0].id === winner.body?.bookingId,
    JSON.stringify(raceAct.rows));
  const winBooking: string = winner.body?.bookingId ?? "";
  if (winBooking) (winner === raceA ? t1Ids : t2Ids).add(winBooking);
  const relRace = await call(`/bookings/${winBooking}/release`, winTok, post({}));
  check("the race winner can release its hold right away", relRace.status === 200, `[${relRace.status}]`);
  const wdR5 = await withdraw(tokA, R5);
  check("the raced load is withdrawn cleanly afterwards", wdR5.status === 200);

  // ================= 6. the timers: 6h reminder, 12h release, idempotent (R3) =================
  const b3res = await call(`/board/${R3}/book`, tokT1, post(bookBody("Timer Desk", "timer@one.bookprobe.example")));
  check("a hold is opened for the timer run", b3res.status === 201 && !!b3res.body?.bookingId, `[${b3res.status}]`);
  const b3: string = b3res.body?.bookingId ?? "";
  if (b3) t1Ids.add(b3);

  const alertsT1 = await call("/notifications", tokT1);
  check("the booker's feed shows its live hold with the deadline",
    (alertsT1.body?.items ?? []).some((i: any) =>
      i.type === "booking_mine_hold" && String(i.title).includes("Bookprobe load 3")),
    JSON.stringify((alertsT1.body?.items ?? []).slice(0, 4)));

  // Backdate past the 6h mark — owner SQL; app_runtime cannot write these columns.
  await owner.query(`update transport_requests set temp_booked_at = now() - interval '7 hours' where id = $1`, [R3]);
  const t1res = await tick(TICK_SECRET);
  check("the tick endpoint runs with the server-side secret",
    t1res.status === 200 && typeof t1res.body?.reminded === "number" && typeof t1res.body?.released === "number",
    `[${t1res.status}] ${JSON.stringify(t1res.body)}`);
  const stamped = await until(async () =>
    (await reqRow(R3)).reminder_sent_at !== null);
  check("the 6h reminder is stamped (by the tick or the in-process loop)", stamped);
  const stamps = await owner.query(
    `select t.reminder_sent_at as req, b.reminder_sent_at as bk
       from transport_requests t
       join transport_bookings b on b.request_id = t.id and b.status = 'temp_booked'
      where t.id = $1`, [R3]);
  const reqStamp = stamps.rows[0]?.req, bkStamp = stamps.rows[0]?.bk;
  check("request and booking were stamped in the same instant — one atomic pass",
    reqStamp instanceof Date && bkStamp instanceof Date && reqStamp.getTime() === bkStamp.getTime(),
    JSON.stringify({ reqStamp, bkStamp }));
  // The clock is an actor too: the reminder must be on the record, not just in a column.
  const remAudit = await owner.query(
    `select count(*)::int as n from audit_logs
      where entity_id = $1 and action = 'transport.booking_reminded' and actor_role = 'system'`, [R3]);
  check("the 6h reminder is written to the audit trail with the system as actor",
    remAudit.rows[0].n === 1, `audit rows=${remAudit.rows[0].n}`);
  const remAct = await owner.query(
    `select count(*)::int as n from job_activity
      where entity_id = $1 and action = 'transport.reminder_sent' and actor_role = 'system'`, [R3]);
  check("the publisher's job timeline also sees the reminder", remAct.rows[0].n === 1,
    `timeline rows=${remAct.rows[0].n}`);
  check("a hold at 7h is still held — nothing released early",
    (await reqRow(R3)).status === "temp_booked");
  const alertsA3 = await call("/notifications", tokA);
  check("the publisher's countdown now says the 6h reminder went out",
    (alertsA3.body?.items ?? []).some((i: any) =>
      i.type === "booking_hold" && String(i.detail).includes("6h reminder sent")),
    JSON.stringify((alertsA3.body?.items ?? []).slice(0, 4)));

  const t1resAgain = await tick(TICK_SECRET);
  const stampAfter = (await reqRow(R3)).reminder_sent_at;
  check("running the tick again does not re-stamp the reminder",
    t1resAgain.status === 200 && stampAfter instanceof Date && stampAfter.getTime() === (reqStamp as Date).getTime());

  // Past the 12h mark the database itself lets go — whenever it fires.
  await owner.query(`update transport_requests set temp_booked_at = now() - interval '13 hours' where id = $1`, [R3]);
  await tick(TICK_SECRET);
  const released = await until(async () => {
    const r = await reqRow(R3), b = await bkRow(b3);
    return r.status === "open" && r.released_at !== null && b.status === "expired" && b.ended_at !== null;
  });
  check("at 13h the hold auto-releases: request open, booking expired", released);
  const r3fin = await reqRow(R3), b3fin = await bkRow(b3);
  check("the expiry carries no actor and no reason — only ended_at",
    b3fin.ended_reason === null && b3fin.ended_by === null && b3fin.ended_at !== null,
    JSON.stringify(b3fin));
  // The silent auto-release now leaves a trace: audit trail + job timeline,
  // both naming the booking that expired.
  const relAudit = await owner.query(
    `select count(*)::int as n from audit_logs
      where entity_id = $1 and action = 'transport.booking_auto_released'
        and actor_role = 'system' and after->>'bookingId' = $2`, [R3, b3]);
  check("the auto-release is written to the audit trail, naming the booking",
    relAudit.rows[0].n === 1, `audit rows=${relAudit.rows[0].n}`);
  const relAct = await owner.query(
    `select count(*)::int as n from job_activity
      where entity_id = $1 and action = 'transport.hold_expired' and actor_role = 'system'`, [R3]);
  check("the publisher's job timeline also sees the expiry", relAct.rows[0].n === 1,
    `timeline rows=${relAct.rows[0].n}`);
  const releasedStamp = (r3fin.released_at as Date).getTime();
  const t3res = await tick(TICK_SECRET);
  const t4res = await tick(TICK_SECRET);
  check("re-running the tick on a released hold changes nothing, and releases nothing",
    t3res.status === 200 && t3res.body?.released === 0 && t4res.body?.released === 0 &&
      (await reqRow(R3)).status === "open" &&
      ((await reqRow(R3)).released_at as Date).getTime() === releasedStamp,
    JSON.stringify({ t3: t3res.body, t4: t4res.body }));
  const relAuditAfter = await owner.query(
    `select count(*)::int as n from audit_logs
      where entity_id = $1 and action = 'transport.booking_auto_released'`, [R3]);
  check("the idempotent re-runs wrote no duplicate audit rows",
    relAuditAfter.rows[0].n === 1, `audit rows=${relAuditAfter.rows[0].n}`);
  check("the auto-released load is on the board again",
    (await call(`/board/${R3}`, tokT2)).status === 200);
  const wdR3 = await withdraw(tokA, R3);
  check("the timer load is withdrawn cleanly afterwards", wdR3.status === 200);

  // ================= 7. the tick endpoint's own door =================
  const noSec = await tick(null);
  check("the tick endpoint refuses a caller with no secret", noSec.status === 403, `[${noSec.status}]`);
  const badSec = await tick("0".repeat(Math.max(TICK_SECRET.length, 32)));
  check("the tick endpoint refuses a wrong secret", badSec.status === 403, `[${badSec.status}]`);
  const anonTick = await call("/internal/booking-timers/tick", tokA, post({}));
  check("a signed-in user token is no substitute for the secret",
    anonTick.status === 403, `[${anonTick.status}]`);

  // ================= 8. cross-tenant and confirmed-state guards (R4) =================
  const b4res = await call(`/board/${R4}/book`, tokT2, post(bookBody("Guard Desk", "guard@two.bookprobe.example")));
  check("a hold for the guard run is open", b4res.status === 201, `[${b4res.status}]`);
  const b4: string = b4res.body?.bookingId ?? "";
  if (b4) t2Ids.add(b4);

  const t1conf = await call(`/transport-requests/${R4}/confirm`, tokT1, bare);
  check("a rival transporter cannot confirm someone else's booking", t1conf.status === 404, `[${t1conf.status}]`);
  const t1canc = await call(`/transport-requests/${R4}/cancel-booking`, tokT1, post({ reason: "give me this load" }));
  const r4mid = await reqRow(R4);
  check("a rival cannot cancel a booking it is not part of",
    t1canc.status >= 400 && r4mid.status === "temp_booked", `[${t1canc.status}]`);
  const cf4 = await call(`/transport-requests/${R4}/confirm`, tokA, bare);
  check("the publisher confirms the guarded hold", cf4.status === 200, `[${cf4.status}]`);
  const rej4 = await call(`/transport-requests/${R4}/reject`, tokA, post({ reason: "changed my mind" }));
  check("a confirmed booking cannot be declined — only cancelled with a reason",
    rej4.status === 409 && hasMsg(rej4.body, /reason/i), `[${rej4.status}]`);
  const wd4 = await withdraw(tokA, R4);
  check("a request with an engaged booking cannot be withdrawn", wd4.status === 409, `[${wd4.status}]`);
  const canc4 = await call(`/transport-requests/${R4}/cancel-booking`, tokA, post({ reason: "Delivery window moved again" }));
  check("the publisher cancels the confirmed booking with a reason", canc4.status === 200, `[${canc4.status}]`);
  const wd4b = await withdraw(tokA, R4);
  check("once the booking is cancelled the request withdraws cleanly", wd4b.status === 200, `[${wd4b.status}]`);

  // ================= 9. my-bookings: own rows only, final state =================
  await withdraw(tokA, R2);
  const mineT1 = await call("/my-bookings", tokT1);
  const mineT2 = await call("/my-bookings", tokT2);
  const rowsT1 = mineT1.body ?? [], rowsT2 = mineT2.body ?? [];
  check("my-bookings returns exactly this company's bookings, and never the other's",
    mineT1.status === 200 && rowsT1.length === t1Ids.size && rowsT1.every((r: any) => t1Ids.has(r.id)) &&
      rowsT2.length === t2Ids.size && rowsT2.every((r: any) => t2Ids.has(r.id)) &&
      !rowsT1.some((r: any) => t2Ids.has(r.id)) && !rowsT2.some((r: any) => t1Ids.has(r.id)),
    JSON.stringify({ t1: rowsT1.map((r: any) => r.id), t2: rowsT2.map((r: any) => r.id) }));
  const mineB3 = rowsT1.find((r: any) => r.id === b3);
  check("the expired hold is in the booker's list, ending clean",
    mineB3?.status === "expired" && mineB3?.ended_reason === null && !!mineB3?.ended_at,
    JSON.stringify(mineB3));

  const rowsT3 = (await call("/my-bookings", tokT3)).body ?? [];
  check("the readiness probe's released booking appears in its own company's list only",
    rowsT3.length === t3Ids.size && rowsT3.every((r: any) => t3Ids.has(r.id)) &&
      rowsT3.every((r: any) => r.status === "released"),
    JSON.stringify(rowsT3.map((r: any) => ({ id: r.id, status: r.status }))));

  const finBoard = await call("/board?limit=100", tokT2);
  check("after the run none of the probe loads are on the board",
    !(finBoard.body?.rows ?? []).some((r: any) => R.includes(r.id)),
    JSON.stringify((finBoard.body?.rows ?? []).map((r: any) => r.id)));
  const st = await owner.query(`select status from transport_requests where id = any($1::uuid[])`, [R]);
  check("every probe request ended withdrawn", st.rows.length === 5 && st.rows.every((r: any) => r.status === "cancelled"),
    JSON.stringify(st.rows.map((r: any) => r.status)));
  const live = await owner.query(
    `select count(*)::int as n from transport_bookings
      where request_id = any($1::uuid[]) and ended_at is null`, [R]);
  check("no live booking rows are left behind", live.rows[0].n === 0, `live=${live.rows[0].n}`);

  // ---- teardown ----
  await wipeAll(ids);
  const residue = async (sql: string) =>
    Number((await owner.query(sql, [ids])).rows[0].n);
  check("residue: tenants gone", await residue(`select count(*)::int n from tenants where id = any($1::uuid[])`) === 0);
  check("residue: users gone", await residue(`select count(*)::int n from users where tenant_id = any($1::uuid[])`) === 0);
  check("residue: requests gone", await residue(`select count(*)::int n from transport_requests where tenant_id = any($1::uuid[])`) === 0);
  check("residue: bookings gone", await residue(`select count(*)::int n from transport_bookings where tenant_id = any($1::uuid[])`) === 0);
  check("residue: company profiles gone", await residue(`select count(*)::int n from company_profiles where tenant_id = any($1::uuid[])`) === 0);
  check("residue: alert reads gone", await residue(`select count(*)::int n from alert_reads where tenant_id = any($1::uuid[])`) === 0);

  await owner.end();
  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nbooking state machine, timers and the tick door all hold");
}

main().catch((e) => { console.error(e); process.exit(1); });
