/**
 * Step 5 — notice board + realtime smoke (spec Part 2, step 1's "appears on the
 * notice board in real time for all registered transporters").
 * Expects the API on :4000. Builds three probe tenants: two CFAs that publish,
 * one transporter that watches, plus a role that must not see the board. Proves:
 * the board is readable across tenants and is the ONLY cross-tenant surface;
 * every card carries exactly the reviewed board_card columns and nothing else;
 * a card is an inert copy — editing the cargo file, the client name or the
 * company profile after publishing changes nothing on the board; filters and
 * paging are applied server-side and bounded; a withdrawn request vanishes;
 * the SSE stream authenticates with a header, greets with a snapshot, pushes
 * publishes and withdrawals, never carries more than the REST board would, and
 * caps sockets per tenant; unauthorised and unprivileged callers are refused.
 * Everything is cleaned up.
 * Run: npx tsx scripts/smoke-board.ts   (DNS_FALLBACK=1 if local DNS is broken)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { BOARD_CARD_COLUMNS, BOARD_FORBIDDEN_KEYS } from "../src/util/board.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET);
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label, String(detail).slice(0, 220)); }
}

async function mint(sub: string, tid: string, typ: string, roles: string[]) {
  return new SignJWT({ tid, sid: "00000000-7000-8000-0000-0000000000cc", typ, roles })
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

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shiftDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

/** The client-visible shape: board_card without the server-side count column. */
const CARD_KEYS = BOARD_CARD_COLUMNS.filter((c) => c !== "total").map(
  (c) => c.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase()));

/** Every key present, recursively, that must never leave the publisher's tenant. */
function forbiddenIn(payload: unknown, found: string[] = []): string[] {
  if (payload && typeof payload === "object") {
    for (const [k, v] of Object.entries(payload)) {
      if (BOARD_FORBIDDEN_KEYS.includes(k)) found.push(k);
      forbiddenIn(v, found);
    }
  }
  return found;
}

function parseFrames(text: string) {
  return text.split("\n\n").map((b) => {
    const ev = /^event: (.+)$/m.exec(b)?.[1];
    const data = /^data: (.+)$/m.exec(b)?.[1];
    return ev && data ? { event: ev, data: JSON.parse(data) } : null;
  }).filter(Boolean) as { event: string; data: any }[];
}

/**
 * SSE over fetch, not EventSource: the access token must stay in a header.
 * Returns a next() that waits for the next frame, plus a cancel handle.
 */
async function openStream(token: string | null) {
  const headers: any = { Accept: "text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + "/board/stream", { headers });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    return { status: res.status, body, next: async () => null, close: async () => { } };
  }
  const dec = new TextDecoder();
  let buf = "";
  const queue: { event: string; data: any }[] = [];
  const reader = res.body.getReader();
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const f of parseFrames(raw)) queue.push(f);
      }
    }
  })().catch(() => { });

  const next = async (ms = 6000) => {
    const start = Date.now();
    while (!queue.length && Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 80));
    }
    return queue.shift() ?? null;
  };
  return { status: res.status, body: "", next, close: async () => {
    try { await reader.cancel(); } catch { }
  } };
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

  const NAMES = ["Boardprobe Alpha Ltd", "Boardprobe Beta Ltd", "Boardprobe Freight Ltd"];
  const WIPE = ["transport_requests", "job_handovers", "job_documents", "job_activity",
    "cargo_tasks", "job_stages", "jobs", "cargo_shipments", "documents", "routes",
    "company_profiles", "sessions", "otp_codes", "password_resets"];
  const wipeAll = async (ids: string[]) => {
    if (!ids.length) return;
    for (const t of WIPE) await owner.query(`delete from ${t} where tenant_id = any($1::uuid[])`, [ids]);
    await owner.query(`delete from user_roles where user_id in
      (select id from users where tenant_id = any($1::uuid[]))`, [ids]);
    await owner.query(`delete from users where tenant_id = any($1::uuid[])`, [ids]);
    await owner.query(`delete from tenants where id = any($1::uuid[])`, [ids]);
  };
  // Idempotent start: an earlier crashed run must not skew the counts.
  const stale = (await owner.query(
    `select id from tenants where name = any($1::text[])`, [NAMES])).rows.map(r => r.id);
  await wipeAll(stale);
  if (stale.length) console.log("pre-clean removed", stale.length, "stale probe tenants");

  const TA = randomUUID(), TB = randomUUID(), TV = randomUUID();
  const uA = randomUUID(), uB = randomUUID(), uV = randomUUID(), uBlocked = randomUUID();
  const ROUTE_A = randomUUID(), ROUTE_B = randomUUID();
  const ids = [TA, TB, TV, uA, uB, uV, uBlocked];

  const roleOf = async (k: string) => (await owner.query(
    `select id from roles where key = $1 and tenant_id is null`, [k])).rows[0]?.id;
  const directorRole = await roleOf("director");
  const traineeRole = await roleOf("trainee");

  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter',$2)`, [TA, NAMES[0]]);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter',$2)`, [TB, NAMES[1]]);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter',$2)`, [TV, NAMES[2]]);
  for (const [t, n, code, fleet, year] of [
    [TA, NAMES[0], "BPA", 18, 2014], [TB, NAMES[1], "BPB", 6, 2021], [TV, NAMES[2], "BPF", 30, 2009]
  ] as [string, string, string, number, number][]) {
    await oi(`insert into company_profiles (id, tenant_id, company_name, company_code,
               description, services_offered, corridors_served, website,
               fleet_size_declared, year_established)
             values ($1,$2,$3,$4,'Clearing and haulage since ' || $7::text,
               'Clearing, transport, bonding','Dar - Arusha - Nakonde',$3 || '.boardprobe.example',$5,$6)`,
      [randomUUID(), t, n, code, fleet, year, String(year)]);
  }
  for (const [u, t, name, email] of [
    [uA, TA, "Alpha Director", "alpha.director@boardprobe.example"],
    [uB, TB, "Beta Director", "beta.director@boardprobe.example"],
    [uV, TV, "Freight Director", "freight.director@boardprobe.example"],
    [uBlocked, TV, "Freight Trainee", "freight.trainee@boardprobe.example"]
  ] as [string, string, string, string][]) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
              values ($1,$2,'staff',$3,'active',$4)`, [u, t, name, email]);
  }
  for (const u of [uA, uB, uV]) await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [u, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uBlocked, traineeRole]);

  // Three regions with coordinates, so a card can draw a map.
  const regions = (await owner.query(
    `select id, name_en, lat, lng from geo_regions
      where country = 'TZ' and is_active and lat is not null and lng is not null
      order by id limit 3`)).rows;
  if (regions.length < 2) { console.error("geo_regions seed missing"); process.exit(1); }

  // Each publisher owns a route: the board must show its copied distance, and
  // never the rate card behind it.
  for (const [r, t, name, km, who] of [
    [ROUTE_A, TA, "Alpha corridor", 610, uA],
    [ROUTE_B, TB, "Beta corridor", 820, uB]
  ] as [string, string, string, number, string][]) {
    await oi(`insert into routes (id, tenant_id, name, origin_region_id, dest_region_id,
               distance_km, expected_duration_hours, rate_per_km, created_by, updated_by)
              values ($1,$2,$3,$4,$5,$6,14,915.25,$7,$7)`,
      [r, t, name, regions[0].id, regions[1].id, km, who]);
  }

  const tokA = await mint(uA, TA, "director", ["director"]);
  const tokB = await mint(uB, TB, "director", ["director"]);
  const tokV = await mint(uV, TV, "director", ["director"]);
  const tokBlocked = await mint(uBlocked, TV, "staff", ["trainee"]);

  async function newFile(tok: string, consignee: string) {
    const c = await call("/cargo", tok, post({
      shipmentType: "import", containerType: "40ft", containerCount: 2,
      containerNumbers: ["BPUU7654321", "BPUU1122334"], cargoDescription: "Galvanised steel coils",
      hsCode: "7214.20.00", declarationMode: "PSSL", tansadNumber: "TSAD-4455661",
      rcnNumber: "RCN-4455662", billNumber: "BL-BP-0001", shippingLine: "Ocean Line Agency",
      cabinetPosition: "YARD-B1", termsDelivery: "CIF", consigneeName: consignee,
      consignorName: consignee.replace("Trading", "Supplier"), weightTonnes: 24, cbm: 30,
      eta: shiftDays(2), dischargeDate: shiftDays(4), carryInDate: shiftDays(5),
      nominatedIcd: "TPIC Dar", borderPoint: "Namanga", processingCost: 4450000,
      paymentAmount: 1200000, paymentStatus: "partial",
      notes: "Client wants a call before delivery"
    }));
    const s = c.body?.id;
    const j = s ? (await call("/jobs", tok)).body?.find?.((x: any) => x.shipment_id === s) : null;
    return { shipment: s, job: j?.id, created: c.status, why: JSON.stringify(c.body).slice(0, 180) };
  }

  function body(o: any) {
    return {
      cargoLabel: "Galvanised steel coils, 2 x 40ft", containerType: "40ft", containerCount: 2,
      weightTonnes: 24, cbm: 30, vehicleTypes: ["truck_head", "trailer"], routeId: ROUTE_A,
      pickupText: "TPIC Dar es Salaam", pickupRegionId: regions[0].id,
      destText: "Arusha", destRegionId: regions[1].id, viaLabel: "Namanga border",
      requiredDate: shiftDays(6), contactName: "Alpha Director",
      contactChannel: "desk@alpha.boardprobe.example",
      publicNote: "Tarpaulin provided, weekly departures", ...o
    };
  }

  // ---- three open requests from two different companies ----
  const f1 = await newFile(tokA, "Boardprobe Steel Trading");
  const f2 = await newFile(tokA, "Boardprobe Copper Trading");
  const f3 = await newFile(tokB, "Boardprobe Grain Trading");
  check("probe cargo files opened with their job pipelines",
    !!f1.job && !!f2.job && !!f3.job,
    JSON.stringify([f1.created, f2.created, f3.created]) + " " + [f1.why, f2.why, f3.why].join(" | "));

  for (const [tok, job] of [[tokA, f1.job], [tokA, f2.job], [tokB, f3.job]] as [string, string][]) {
    const d = await call(`/jobs/${job}/decision`, tok,
      json({ recordKind: "live", transportNeeded: true, consent: "granted" }));
    if (d.status !== 200) check(`consent recorded for ${job}`, false, `[${d.status}]`);
  }

  const p1 = await call(`/jobs/${f1.job}/transport-request`, tokA, post(body({})));
  const p2 = await call(`/jobs/${f2.job}/transport-request`, tokA, post(body({
    cargoLabel: "Copper cathodes, loose", containerType: null, containerCount: null,
    vehicleTypes: ["flatbed", "box_truck"], destText: "Mwanza", destRegionId: regions[2]?.id ?? regions[1].id,
    requiredDate: shiftDays(12), contactName: "Alpha Director", publicNote: null,
    weightTonnes: 18, cbm: 44
  })));
  const p3 = await call(`/jobs/${f3.job}/transport-request`, tokB, post(body({
    cargoLabel: "Wheat in 40ft bags", containerType: "loose_cargo", vehicleTypes: ["reefer", "tipper"],
    routeId: ROUTE_B, pickupText: "TPIC Dar warehouse 4", destText: "Iringa",
    destRegionId: regions[1].id,
    requiredDate: shiftDays(3), contactName: "Beta Director",
    contactChannel: "ops@beta.boardprobe.example", publicNote: "Reefer required, 12 tonnes"
  })));
  check("three requests published by two companies",
    p1.status === 201 && p2.status === 201 && p3.status === 201,
    JSON.stringify([p1.status, p2.status, p3.status]));
  const id1 = p1.body?.id, id2 = p2.body?.id, id3 = p3.body?.id;

  const boardFile = (await call(`/cargo/${f1.shipment}`, tokA)).body?.file_number ?? "";
  const PRIVATE = ["Boardprobe Steel Trading", "Boardprobe Copper Trading", "Boardprobe Grain Trading",
    "Boardprobe Steel Supplier", "BPUU7654321", "BPUU1122334",
    "7214.20.00", "TSAD-4455661", "RCN-4455662", "BL-BP-0001", "Ocean Line", "YARD-B1",
    "4450000", "1200000", "915.25", boardFile, "Client wants a call"].filter(Boolean);
  const leaks = (hay: string) => PRIVATE.filter((p) => p && hay.includes(p));

  // ---------- 1. who may read the board ----------
  const anon = await call("/board", null);
  check("board requires a signed-in company", anon.status === 401, `[${anon.status}]`);
  const streamAnon = await openStream(null);
  check("the live stream refuses an anonymous caller", streamAnon.status === 401,
    `[${streamAnon.status}]`);
  const blockedList = await call("/board", tokBlocked);
  check("a role without board.view cannot list the board", blockedList.status === 403,
    `[${blockedList.status}]`);
  const blockedStream = await openStream(tokBlocked);
  check("a role without board.view cannot open the stream", blockedStream.status === 403,
    `[${blockedStream.status}]`);

  // ---------- 2. cross-tenant visibility, which is the whole point ----------
  const all = await call("/board", tokV);
  const rows = all.body?.rows ?? [];
  check("transporter sees every company's open request",
    all.status === 200 && rows.length === 3 && all.body?.total === 3,
    `[${all.status}] n=${rows.length} total=${all.body?.total}`);
  check("cards come from two different publishers",
    new Set(rows.map((r: any) => r.companyName)).size === 2,
    JSON.stringify([...new Set(rows.map((r: any) => r.companyName))]));
  check("the publishing CFA sees its own cards too",
    ((await call("/board", tokA)).body?.rows ?? []).length === 3);
  check("cards ordered by the date the load is needed",
    rows.map((r: any) => r.requiredDate).join(",") === [...rows]
      .sort((a: any, b: any) => a.requiredDate.localeCompare(b.requiredDate))
        .map((r: any) => r.requiredDate).join(","),
    JSON.stringify(rows.map((r: any) => r.requiredDate)));
  check("total counts the whole board, not the page",
    (await call("/board?limit=1", tokV)).body?.total === 3 &&
      ((await call("/board?limit=1", tokV)).body?.rows ?? []).length === 1);
  check("offset pages without repeating or skipping",
    (await call("/board?limit=2&offset=0", tokV)).body?.rows?.[0]?.id !==
      (await call("/board?limit=2&offset=2", tokV)).body?.rows?.[0]?.id);
  check("board/count agrees with the list",
    (await call("/board/count", tokV)).body?.open === 3,
    JSON.stringify((await call("/board/count", tokV)).body));

  // ---------- 3. the card is exactly the reviewed allowlist ----------
  const keys = Object.keys(rows[0] ?? {}).sort();
  check("card keys are exactly board_card minus the count",
    keys.join(",") === [...CARD_KEYS].sort().join(","),
    `got ${keys.length}: ${keys.filter(k => !CARD_KEYS.includes(k)).join(",") || "-"} ` +
    `missing ${CARD_KEYS.filter(k => !keys.includes(k)).join(",") || "-"}`);
  check("RULE 0: no internal key appears anywhere in a board payload",
    forbiddenIn(all.body).length === 0, forbiddenIn(all.body).join(","));
  check("RULE 0: no private value appears anywhere in a board payload",
    leaks(JSON.stringify(all.body)).length === 0, leaks(JSON.stringify(all.body)).join(","));
  check("the CFA's own list still keeps its private file number (not the board's)",
    ((await call("/transport-requests", tokA)).body ?? []).every((r: any) => !!r.file_number));
  const card1 = rows.find((r: any) => r.id === id1) ?? {};
  check("card carries the route label and the distance the server copied",
    card1.routeLabel === "Alpha corridor" && card1.distanceKm === 610 &&
      card1.expectedDurationHours === 14,
    JSON.stringify({ rl: card1.routeLabel, d: card1.distanceKm, h: card1.expectedDurationHours }));
  check("map geometry present so the card can draw a route",
    typeof card1.pickupLat === "number" && typeof card1.destLng === "number" &&
      !!card1.pickupRegionName && !!card1.destRegionName,
    JSON.stringify({ p: card1.pickupLat, d: card1.destLng, pr: card1.pickupRegionName }));
  check("required date and disclosure stamp are plain strings (no timezone drift)",
    /^\d{4}-\d{2}-\d{2}$/.test(card1.requiredDate ?? "") &&
      typeof card1.disclosedAt === "string" && card1.disclosedAt.includes("T"),
    JSON.stringify({ rd: card1.requiredDate, da: card1.disclosedAt }));
  check("the named contact is the only staff member disclosed",
    card1.contactName === "Alpha Director" && card1.contactChannel === "desk@alpha.boardprobe.example");
  check("company card is the publisher's, copied at publish time",
    card1.companyName === NAMES[0] && card1.fleetSizeDeclared === 18 &&
      card1.yearEstablished === 2014 && card1.companyWebsite === `${NAMES[0]}.boardprobe.example`,
    JSON.stringify({ c: card1.companyName, f: card1.fleetSizeDeclared, w: card1.companyWebsite }));

  // ---------- 4. the copy is inert ----------
  const edit = await call(`/cargo/${f1.shipment}`, tokA,
    { method: "PUT", ...json({ consigneeName: "Renamed Client Industries Ltd",
      processingCost: 9999999, notes: "changed after publish",
      containerCount: 2, containerNumbers: ["BPUU7654321", "BPUU1122334"] }) });
  check("the cargo file was edited after publishing (so the copy has to hold)",
    edit.status === 200, `[${edit.status}] ${JSON.stringify(edit.body).slice(0, 120)}`);
  await oi(`update company_profiles set company_name = 'Renamed Alpha Holdings',
              fleet_size_declared = 999 where tenant_id = $1`, [TA]);
  await oi(`update routes set distance_km = 5000, rate_per_km = 1.00 where id = $1`, [ROUTE_A]);
  const afterEdit = await call("/board", tokV);
  const still1 = (afterEdit.body?.rows ?? []).find((r: any) => r.id === id1) ?? {};
  check("editing the cargo file after publishing changes nothing on the board",
    still1.companyName === NAMES[0] && !JSON.stringify(still1).includes("Renamed Client"),
    JSON.stringify({ cn: still1.companyName }));
  check("editing the route after publishing changes the copied distance not at all",
    still1.distanceKm === 610 && still1.routeLabel === "Alpha corridor",
    JSON.stringify({ d: still1.distanceKm, rl: still1.routeLabel }));
  check("editing the company profile after publishing changes nothing on the board",
    still1.companyName === NAMES[0] && still1.fleetSizeDeclared === 18,
    JSON.stringify({ cn: still1.companyName, f: still1.fleetSizeDeclared }));
  await oi(`update company_profiles set company_name = $2, fleet_size_declared = $3
              where tenant_id = $1`, [TA, NAMES[0], 18]);

  // ---------- 5. filters are server-side and bounded ----------
  const reefer = await call("/board?vehicle=reefer", tokV);
  check("truck-type filter narrows to matching loads",
    (reefer.body?.rows ?? []).length === 1 && reefer.body.rows[0].id === id3 &&
      reefer.body.total === 1, JSON.stringify(reefer.body?.rows?.map((r: any) => r.id)));
  const badVehicle = await call("/board?vehicle=steam_boat", tokV);
  check("an unknown truck type is rejected, not ignored", badVehicle.status === 400,
    `[${badVehicle.status}]`);
  const byRegion = await call(`/board?regionId=${regions[2]?.id ?? regions[1].id}`, tokV);
  check("region filter matches pickup or destination",
    (byRegion.body?.rows ?? []).length >= 1 &&
      (byRegion.body.rows ?? []).every((r: any) =>
        r.pickupRegionId === (regions[2]?.id ?? regions[1].id) ||
        r.destRegionId === (regions[2]?.id ?? regions[1].id)),
    JSON.stringify((byRegion.body?.rows ?? []).map((r: any) => [r.pickupRegionId, r.destRegionId])));
  const window = await call(`/board?from=${shiftDays(5)}&to=${shiftDays(8)}`, tokV);
  check("date window keeps only loads needed inside it",
    (window.body?.rows ?? []).length === 1 && window.body.rows[0].id === id1,
    JSON.stringify((window.body?.rows ?? []).map((r: any) => r.requiredDate)));
  const reversed = await call(`/board?from=${shiftDays(9)}&to=${shiftDays(1)}`, tokV);
  check("a reversed date range is refused", reversed.status === 400, `[${reversed.status}]`);
  const byWord = await call("/board?search=wheat", tokV);
  check("search matches the published text only",
    (byWord.body?.rows ?? []).length === 1 && byWord.body.rows[0].id === id3);
  const byCompany = await call("/board?search=Boardprobe Beta", tokV);
  check("search can find a company by its disclosed name",
    (byCompany.body?.rows ?? []).every((r: any) => r.companyName === NAMES[1]) &&
      (byCompany.body?.rows ?? []).length === 1);
  const noLeakSearch = await call("/board?search=TSAD-4455661", tokV);
  check("searching a private reference finds nothing",
    (noLeakSearch.body?.rows ?? []).length === 0 && noLeakSearch.body?.total === 0);
  const injected = await call("/board?search=" +
    encodeURIComponent("'; drop table transport_requests; select 1--"), tokV);
  check("a SQL-shaped search is data, not code",
    injected.status === 200 && (injected.body?.rows ?? []).length === 0);
  const stillThere = await owner.query(
    `select count(*)::int n from transport_requests where id = any($1::uuid[])`, [[id1, id2, id3]]);
  check("and the requests survived it", stillThere.rows[0].n === 3, stillThere.rows[0].n);
  const tooMany = await call("/board?limit=1000", tokV);
  check("paging is bounded server-side", tooMany.status === 400, `[${tooMany.status}]`);
  const smuggle = await call("/board?status=cancelled", tokV);
  check("an unknown board filter is rejected, not silently accepted", smuggle.status === 400,
    `[${smuggle.status}]`);

  // ---------- 6. one card, and gone when withdrawn ----------
  const one = await call(`/board/${id3}`, tokV);
  check("detail returns the card to any company", one.status === 200 && one.body?.id === id3,
    `[${one.status}]`);
  check("detail carries the same key set and no internal field",
    Object.keys(one.body ?? {}).sort().join(",") === [...CARD_KEYS].sort().join(","));
  const cancel3 = await call(`/transport-requests/${id3}/cancel`, tokB, post({}));
  check("the publishing company can withdraw its request", cancel3.status === 200, `[${cancel3.status}]`);
  const gone = await call(`/board/${id3}`, tokV);
  check("a withdrawn request is no longer on the board", gone.status === 404, `[${gone.status}]`);
  check("and it leaves the list", ((await call("/board", tokV)).body?.rows ?? []).length === 2);
  const ghost = await call(`/board/${randomUUID()}`, tokV);
  check("an unknown board id is 404", ghost.status === 404, `[${ghost.status}]`);

  // ---------- 7. the board is the only cross-tenant door ----------
  const crossList = await call(`/transport-requests/${id1}`, tokV);
  check("a transporter cannot open another company's request record",
    crossList.status === 404, `[${crossList.status}]`);
  const crossCancel = await call(`/transport-requests/${id1}/cancel`, tokV, post({}));
  check("a transporter cannot withdraw another company's request",
    crossCancel.status === 404, `[${crossCancel.status}]`);
  const crossPublish = await call(`/jobs/${f1.job}/transport-request`, tokV, post(body({})));
  check("a transporter cannot publish onto another company's job",
    crossPublish.status === 404 || crossPublish.status === 409, `[${crossPublish.status}]`);
  const ownOnly = await call("/transport-requests", tokV);
  check("a transporter's own request list stays empty (board is separate)",
    (ownOnly.body ?? []).length === 0, JSON.stringify(ownOnly.body)?.slice(0, 120));

  // ---------- 8. realtime ----------
  const stream = await openStream(tokV);
  check("the live board opens for a permitted company", stream.status === 200,
    `[${stream.status}]`);
  const ready = await stream.next();
  check("the stream greets with the current board size",
    ready?.event === "ready" && ready?.data?.open === 2, JSON.stringify(ready));

  const f4 = await newFile(tokA, "Boardprobe Timber Trading");
  await call(`/jobs/${f4.job}/decision`, tokA,
    json({ recordKind: "live", transportNeeded: true, consent: "granted" }));
  const p4 = await call(`/jobs/${f4.job}/transport-request`, tokA, post(body({
    cargoLabel: "Softwood boards, loose", containerType: "loose_cargo",
    vehicleTypes: ["flatbed"], destText: "Dodoma", destRegionId: regions[2]?.id ?? regions[0].id,
    requiredDate: shiftDays(4), publicNote: "Load by 07:00"
  })));
  const pub = await stream.next(9000);
  check("a new load is pushed without a refresh",
    pub?.event === "request.published" && pub?.data?.card?.id === p4.body?.id,
    JSON.stringify(pub)?.slice(0, 160));
  check("the pushed card is the same allowlisted shape",
    Object.keys(pub?.data?.card ?? {}).sort().join(",") === [...CARD_KEYS].sort().join(","));
  check("RULE 0: the pushed frame carries no internal key",
    forbiddenIn(pub).length === 0, forbiddenIn(pub).join(","));
  check("RULE 0: the pushed frame carries no private value",
    leaks(JSON.stringify(pub)).length === 0, leaks(JSON.stringify(pub)).join(","));
  check("the new load is on the board for another company",
    ((await call("/board", tokV)).body?.rows ?? []).some((r: any) => r.id === p4.body?.id));

  const cancel4 = await call(`/transport-requests/${p4.body?.id}/cancel`, tokA, post({}));
  const wd = await stream.next(9000);
  check("a withdrawal is pushed too",
    cancel4.status === 200 && wd?.event === "request.withdrawn" && wd?.data?.id === p4.body?.id,
    JSON.stringify(wd)?.slice(0, 160));
  check("the withdrawal frame carries only the id and a stamp",
    Object.keys(wd?.data ?? {}).sort().join(",") === "at,id,type",
    JSON.stringify(Object.keys(wd?.data ?? {})));
  await stream.close();

  // ---------- 9. sockets are bounded ----------
  const many: { close: () => Promise<void> }[] = [];
  let opened = 0;
  let refused: number | null = null;
  for (let i = 0; i < 12; i++) {
    const s = await openStream(tokA);
    if (s.status === 200) { opened++; many.push(s); } else { refused = s.status; break; }
  }
  check("one company's sockets are capped, then refused clearly",
    opened === 8 && refused === 503, `opened=${opened} refused=${refused}`);
  for (const s of many) await s.close();
  const otherTenantStillFine = await openStream(tokV);
  check("one company's full quota does not block another's",
    otherTenantStillFine.status === 200, `[${otherTenantStillFine.status}]`);
  await otherTenantStillFine.close();

  // ---------- 10. residue checks straight from the database ----------
  const db = await owner.query(
    `select count(*) filter (where status = 'open')::int as open,
            count(*) filter (where status = 'cancelled')::int as cancelled,
            count(*)::int as all
       from transport_requests where tenant_id = any($1::uuid[])`, [[TA, TB, TV]]);
  check("board rows and database rows agree",
    db.rows[0].open === 2 && db.rows[0].cancelled === 2 && db.rows[0].all === 4,
    JSON.stringify(db.rows[0]));
  const joined = await owner.query(
    `select count(*)::int n from transport_requests t
       join cargo_shipments s on s.id = t.shipment_id
      where t.tenant_id = any($1::uuid[]) and s.consignee_name = 'Renamed Client Industries Ltd'`,
    [[TA, TB, TV]]);
  check("the renamed client sits only in the tenant's own cargo file",
    joined.rows[0].n === 1);

  // ---------- cleanup ----------
  await wipeAll(ids.filter((x) => [TA, TB, TV].includes(x)));
  const left = await owner.query(
    `select count(*)::int n from tenants where name = any($1::text[])`, [NAMES]);
  check("cleanup: no probe tenants left", left.rows[0].n === 0);
  const leftRows = await owner.query(
    `select count(*)::int n from transport_requests where tenant_id = any($1::uuid[])`, [[TA, TB, TV]]);
  check("cleanup: no transport requests left", leftRows.rows[0].n === 0);
  const goneCompany = await call("/board", tokV);
  check("a deleted company's token no longer reads the board",
    goneCompany.status === 403 || goneCompany.status === 401, `[${goneCompany.status}]`);
  const orphan = await owner.query(
    `select count(*)::int n from transport_requests where tenant_id = any($1::uuid[])`,
    [[TA, TB, TV]]);
  check("cleanup: no board rows survive their company", orphan.rows[0].n === 0);

  await owner.end();
  console.log(failures ? `\nboard smoke: ${failures} FAILED` : "\nboard smoke: ALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
