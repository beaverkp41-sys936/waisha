/**
 * Step 4 — transport request smoke (spec Part 2 publish stage, Rule 0).
 * Expects the API on :4000. Builds two probe tenants and a job per tenant, then
 * proves: publishing is blocked until stage 9 consent is recorded; the consent
 * preview shows the exact publish surface and nothing private; the body is a
 * closed shape (unknown keys rejected); route distance and labels are copied
 * server-side, not from the browser; the stored row and the board projection
 * contain no consignee, cost, declaration or container data; text that names the
 * client is refused until acknowledged; one live request per job, withdraw then
 * re-publish; archive jobs are never published; a view-only role reads but
 * cannot write; and tenant B cannot reach, publish onto or smear A's board.
 * Everything is cleaned up.
 * Run: npx tsx scripts/smoke-transport.ts   (DNS_FALLBACK=1 if local DNS is broken)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET);
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label, detail.slice(0, 200)); }
}

async function mint(sub: string, tid: string, typ: string, roles: string[]) {
  return new SignJWT({ tid, sid: "00000000-7000-8000-0000-0000000000cc", typ, roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("1h").sign(key);
}

async function call(path: string, token: string, init: any = {}) {
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
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The board projection: every column a transporter is ever allowed to read. */
const BOARD_COLUMNS = ["cargo_label", "container_type", "container_count", "weight_tonnes",
  "cbm", "vehicle_types", "route_label", "distance_km", "expected_duration_hours",
  "pickup_text", "dest_text", "via_label", "required_date", "contact_name", "contact_channel",
  "public_note", "company_name", "company_description", "company_services", "company_corridors",
  "company_website", "fleet_size_declared", "year_established"];

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const health = await fetch(API + "/health").then(r => r.json()).catch(() => null);
  if (!health) { console.error("API not running on :4000 — boot it first"); process.exit(1); }

  const T1 = randomUUID(), T2 = randomUUID();
  const d1 = randomUUID(), d2 = randomUUID(), viewer = randomUUID();
  const ROUTE_A = randomUUID(), ROUTE_B = randomUUID();
  const ids = [T1, T2, d1, d2, viewer, ROUTE_A, ROUTE_B];

  const roleOf = async (k: string) => (await owner.query(
    `select id from roles where key = $1 and tenant_id is null`, [k])).rows[0]?.id;
  const directorRole = await roleOf("director");
  const traineeRole = await roleOf("trainee");

  const WIPE = ["transport_requests", "job_handovers", "job_documents", "job_activity",
    "cargo_tasks", "job_stages", "jobs", "cargo_shipments", "documents", "routes",
    "company_profiles", "sessions", "otp_codes", "password_resets"];
  const wipeRoles = `delete from user_roles where user_id in
    (select id from users where tenant_id = any($1::uuid[]))`;

  // Pre-clean residue from an earlier crashed run (fixtures are named Transprobe*).
  const oldT = (await owner.query(
    `select id from tenants where name in ('Transprobe Alpha Ltd','Transprobe Beta Ltd')`)).rows.map(r => r.id);
  if (oldT.length) {
    for (const t of WIPE) await owner.query(`delete from ${t} where tenant_id = any($1::uuid[])`, [oldT]);
    await owner.query(wipeRoles, [oldT]);
    await owner.query(`delete from users where tenant_id = any($1::uuid[])`, [oldT]);
    await owner.query(`delete from tenants where id = any($1::uuid[])`, [oldT]);
    console.log("pre-clean removed", oldT.length, "stale probe tenants");
  }

  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter','Transprobe Alpha Ltd')`, [T1]);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter','Transprobe Beta Ltd')`, [T2]);
  await oi(`insert into company_profiles (id, tenant_id, company_name, company_code, description,
             services_offered, corridors_served, website, fleet_size_declared, year_established)
           values ($1,$2,'Transprobe Alpha Ltd','TPA','Clearing and haulage since 2014',
             'Clearing, transport','Dar - Arusha - Nakonde','alpha.transprobe.example',18,2014)`,
    [randomUUID(), T1]);
  await oi(`insert into company_profiles (id, tenant_id, company_name, company_code)
           values ($1,$2,'Transprobe Beta Ltd','TPB')`, [randomUUID(), T2]);
  for (const [u, t, name] of [[d1, T1, "Alpha Director"], [d2, T2, "Beta Director"],
    [viewer, T1, "Alpha Viewer"]]) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
              values ($1,$2,'staff',$3,'active',$4)`,
      [u, t, name, `${name.toLowerCase().replace(/ /g, ".")}@transprobe.example`]);
  }
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [d1, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [d2, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [viewer, traineeRole]);

  // Own-company routes: distance is published, the rate card is not.
  const regionIds = (await owner.query(
    `select id from geo_regions where country = 'TZ' and is_active order by id limit 2`)).rows.map(r => r.id);
  const routeFixtures: [string, string, string, number, string][] =
    [[ROUTE_A, T1, "Alpha corridor", 610, d1], [ROUTE_B, T2, "Beta corridor", 90, d2]];
  for (const [r, t, name, km, who] of routeFixtures) {
    await oi(`insert into routes (id, tenant_id, name, origin_region_id, dest_region_id,
               distance_km, expected_duration_hours, rate_per_km, created_by, updated_by)
              values ($1,$2,$3,$4,$5,$6,14,850.75,$7,$7)`,
      [r, t, name, regionIds[0], regionIds[1] ?? regionIds[0], km, who]);
  }

  const tok1 = await mint(d1, T1, "director", ["director"]);
  const tok2 = await mint(d2, T2, "director", ["director"]);
  const tokView = await mint(viewer, T1, "staff", ["trainee"]);

  async function newFile(tok: string, body: any) {
    const c = await call("/cargo", tok, post(body));
    const s = c.body?.id;
    const j = s ? (await call("/jobs", tok)).body?.find?.((x: any) => x.shipment_id === s) : null;
    return { shipment: s, job: j, created: c };
  }
  const clientFile = (consignee: string, consignor: string) => ({
    shipmentType: "import", containerType: "40ft", containerCount: 2,
    containerNumbers: ["JTPU1234567", "JTPU7621122"], cargoDescription: "Galvanised steel coils",
    hsCode: "7214.20.00", declarationMode: "PSSL", tansadNumber: "TSAD-9911223",
    rcnNumber: "RCN-5566778", billNumber: "BL-XYZ-0001", shippingLine: "Ocean Line Agency",
    cabinetPosition: "YARD-A7-ROW3", termsDelivery: "CIF", consigneeName: consignee,
    consignorName: consignor, weightTonnes: 24, cbm: 30, eta: shiftDays(2),
    dischargeDate: shiftDays(4), carryInDate: shiftDays(5), nominatedIcd: "TPIC Dar",
    borderPoint: "Namanga", processingCost: 4450000, paymentAmount: 1200000,
    paymentStatus: "partial" as const, notes: "Client wants a call before delivery"
  });

  const clean = await newFile(tok1, clientFile("Transprobe Client Co", "Transprobe Supplier GmbH"));
  const warnJob = await newFile(tok1, clientFile("Transprobe Copper Trading", "Transprobe Metals House"));
  const archJob = await newFile(tok1, clientFile("Transprobe Archive Buyer", "Transprobe Archive Sender"));
  const bFile = await newFile(tok2, clientFile("Beta Client Co", "Beta Supplier GmbH"));
  check("cargo files opened with their checklists",
    !!clean.job && !!warnJob.job && !!archJob.job && !!bFile.job && clean.job.stages_total === 10,
    JSON.stringify({ c: !!clean.job, w: !!warnJob.job, a: !!archJob.job, b: !!bFile.job }));

  const cargo = await call(`/cargo/${clean.shipment}`, tok1);
  const fileNumber = cargo.body?.file_number ?? "";
  const PRIVATE = ["Transprobe Client Co", "Transprobe Supplier GmbH", "JTPU1234567",
    "JTPU7621122", "7214.20.00", "TSAD-9911223", "RCN-5566778", "BL-XYZ-0001",
    "Ocean Line", "YARD-A7", "4450000", "1200000", "850.75", fileNumber,
    "Client wants a call"].filter(Boolean);
  const leaks = (hay: string) => PRIVATE.filter((p) => p && hay.includes(p));

  // ---------- 1. The consent gate blocks the write, not the preview ----------
  const early = await call(`/jobs/${clean.job.id}/transport-request`, tok1, post(publishBody({})));
  check("publish refused until stage 9 consent is recorded",
    early.status === 409 && JSON.stringify(early.body).includes("stage 9"),
    `[${early.status}] ${JSON.stringify(early.body).slice(0, 120)}`);

  function publishBody(o: any) {
    return {
      cargoLabel: "Galvanised steel coils, 2 x 40ft", containerType: "40ft", containerCount: 2,
      weightTonnes: 24, cbm: 30, vehicleTypes: ["truck_head", "trailer"], routeId: ROUTE_A,
      pickupText: "TPIC Dar es Salaam", destText: "Arusha", viaLabel: "Namanga border",
      requiredDate: shiftDays(6), contactUserId: d1, contactName: "Alpha Director",
      contactChannel: "desk@alpha.transprobe.example",
      publicNote: "Tarpaulin provided, weekly departures", ...o
    };
  }

  const prev = await call(`/jobs/${clean.job.id}/transport-preview`, tok1, post({}));
  const pf = prev.body?.fields ?? {};
  check("preview readable before consent (it stores nothing)", prev.status === 200, `[${prev.status}]`);
  check("preview carries the CFA's own company card",
    prev.body?.company?.companyName === "Transprobe Alpha Ltd" &&
      prev.body?.company?.fleetSizeDeclared === 18, JSON.stringify(prev.body?.company));
  check("preview seeds pickup from the terminal and via from the border point",
    pf.pickupText === "TPIC Dar" && pf.viaLabel === "Namanga", `${pf.pickupText} / ${pf.viaLabel}`);
  check("preview required date is a plain date (no timezone drift)",
    DATE.test(pf.requiredDate ?? ""), String(pf.requiredDate));
  check("preview offers only the CFA's own active routes",
    (prev.body?.routes ?? []).length === 1 && prev.body.routes[0].distance_km === 610 &&
      prev.body.routes[0].label === "Alpha corridor", JSON.stringify(prev.body?.routes));
  check("preview states what stays private", (prev.body?.withheld ?? []).length === 10,
    `n=${(prev.body?.withheld ?? []).length}`);
  check("preview contact is the acting user, never a NIDA or phone number",
    pf.contactName === "Alpha Director" && !JSON.stringify(prev.body).includes("+255"),
    JSON.stringify({ cn: pf.contactName, ch: pf.contactChannel }));
  check("RULE 0: preview leaks no client, cost, declaration or route rate",
    leaks(JSON.stringify(prev.body)).length === 0,
    leaks(JSON.stringify(prev.body)).join(","));

  // ---------- 2. A closed request shape ----------
  const smuggle = await call(`/jobs/${clean.job.id}/transport-request`, tok1,
    post(publishBody({ consigneeName: "Whoever", processingCost: 1, distanceKm: 999 })));
  check("publish rejects unknown fields instead of storing them",
    smuggle.status === 400 && JSON.stringify(smuggle.body).includes("consigneeName"),
    `[${smuggle.status}] ${JSON.stringify(smuggle.body).slice(0, 140)}`);
  const badVehicle = await call(`/jobs/${clean.job.id}/transport-request`, tok1,
    post(publishBody({ vehicleTypes: ["steam_boat"] })));
  check("publish accepts only the known vehicle types", badVehicle.status === 400,
    `[${badVehicle.status}]`);

  // ---------- 3. Consent granted, then the clean publish ----------
  const consent = await call(`/jobs/${clean.job.id}/decision`, tok1,
    json({ recordKind: "live", transportNeeded: true, consent: "granted" }));
  check("stage 9 consent recorded on the clean job",
    consent.status === 200 && consent.body?.consent === "granted", `[${consent.status}]`);

  // The date floor is checked after the consent gate, so run it now that
  // consent is on file — otherwise the refusal would be the 409 above.
  const oldDate = await call(`/jobs/${clean.job.id}/transport-request`, tok1,
    post(publishBody({ requiredDate: shiftDays(-40) })));
  check("publish refuses a stale required date", oldDate.status === 400 &&
    JSON.stringify(oldDate.body).includes("requiredDate"), `[${oldDate.status}]`);

  const pub = await call(`/jobs/${clean.job.id}/transport-request`, tok1, post(publishBody({})));
  const reqId = pub.body?.id;
  check("publish accepted once consent is on file",
    pub.status === 201 && !!reqId && (pub.body?.warnings ?? []).length === 0,
    `[${pub.status}] ${JSON.stringify(pub.body).slice(0, 140)}`);

  const got = await call(`/transport-requests/${reqId}`, tok1);
  const g = got.body ?? {};
  check("request stored as open with who disclosed it",
    got.status === 200 && g.status === "open" && !!g.disclosed_at && !!g.disclosed_by,
    `[${got.status}] ${JSON.stringify({ s: g.status, d: g.disclosed_at })}`);
  check("route distance and label copied server-side from the CFA's own route",
    g.distance_km === 610 && g.route_label === "Alpha corridor" &&
      g.expected_duration_hours === 14 &&
      Number(g.dest_region_id) === Number(regionIds[1] ?? regionIds[0]),
    JSON.stringify({ km: g.distance_km, rl: g.route_label, dr: g.dest_region_id }));
  check("company card copied onto the request, not joined live",
    g.company_name === "Transprobe Alpha Ltd" && g.company_corridors === "Dar - Arusha - Nakonde" &&
      g.year_established === 2014, JSON.stringify({ cn: g.company_name, co: g.company_corridors }));
  check("published date stays a plain date", DATE.test(String(g.required_date)), String(g.required_date));
  check("vehicle list stored", (g.vehicle_types ?? []).join(",") === "truck_head,trailer",
    JSON.stringify(g.vehicle_types));

  // ---------- 4. Rule 0 on the stored row and the board projection ----------
  const rowJson = (await owner.query(
    `select coalesce(to_jsonb(t)::text,'') as j from transport_requests t where id = $1`,
    [reqId])).rows[0].j;
  check("RULE 0: the stored row holds no private value", leaks(rowJson).length === 0,
    leaks(rowJson).join(","));
  const boardJson = (await owner.query(
    `select coalesce(json_agg(x)::text,'') as j from (
       select ${BOARD_COLUMNS.join(", ")} from transport_requests where id = $1) x`,
    [reqId])).rows[0].j;
  check(`RULE 0: the ${BOARD_COLUMNS.length}-column board projection is clean`,
    leaks(boardJson).length === 0 && JSON.parse(boardJson).length === 1,
    leaks(boardJson).join(","));
  const rowCols = (await owner.query(
    `select string_agg(column_name, ',' order by column_name) as n from information_schema.columns
      where table_name = 'transport_requests'`)).rows[0].n;
  check("no private column exists on the publish table",
    !/(consignee|consignor|cost|payment|tin|nida|phone|hs_code|declaration|tansad|rcn|bill|file_number|cabinet|shipping|margin|processing)/
      .test(rowCols), rowCols);

  const list = await call("/transport-requests", tok1);
  check("CFA list shows its own request with the private file number for reference",
    list.status === 200 && JSON.stringify(list.body).includes(reqId) &&
      JSON.stringify(list.body).includes(fileNumber), `[${list.status}]`);
  check("list filter by status and job works",
    (await call("/transport-requests?status=open", tok1)).body?.length === 1 &&
      (await call("/transport-requests?status=confirmed", tok1)).body?.length === 0 &&
      (await call(`/transport-requests?jobId=${warnJob.job.id}`, tok1)).body?.length === 0);
  const found = await call("/transport-requests?search=Arusha", tok1);
  const notFound = await call("/transport-requests?search=zzzznothing", tok1);
  check("search matches the published text only",
    JSON.stringify(found.body).includes(reqId) && notFound.body?.length === 0,
    `[${found.status}/${notFound.status}]`);

  // ---------- 5. Disclosure scanner runs on the submitted text ----------
  await call(`/jobs/${warnJob.job.id}/decision`, tok1,
    json({ recordKind: "live", transportNeeded: true, consent: "granted" }));
  const namesClient = await call(`/jobs/${warnJob.job.id}/transport-request`, tok1,
    post(publishBody({ routeId: null, contactUserId: null, publicNote: "Deliver to Transprobe Copper Trading, gate 4" })));
  check("publish warns when the note names the consignee",
    namesClient.status === 409 && JSON.stringify(namesClient.body).includes("publicText"),
    `[${namesClient.status}] ${JSON.stringify(namesClient.body).slice(0, 160)}`);
  const withNumber = await call(`/jobs/${warnJob.job.id}/transport-request`, tok1,
    post(publishBody({ routeId: null, contactUserId: null, cargoLabel: "Container JTPU7654321 with coils" })));
  check("publish warns when the cargo line carries a container number",
    withNumber.status === 409 && JSON.stringify(withNumber.body).includes("container number"),
    `[${withNumber.status}] ${JSON.stringify(withNumber.body).slice(0, 160)}`);
  const acked = await call(`/jobs/${warnJob.job.id}/transport-request`, tok1,
    post(publishBody({ routeId: null, contactUserId: null, contactName: "Alpha Director",
      publicNote: "Deliver to Transprobe Copper Trading, gate 4", acknowledgeWarnings: true })));
  check("an acknowledged publish still stores the warning trail",
    acked.status === 201 && (acked.body?.warnings ?? []).length >= 1,
    `[${acked.status}] ${JSON.stringify(acked.body).slice(0, 160)}`);

  const tl = await call(`/jobs/${clean.job.id}/timeline`, tok1);
  check("activity timeline records the publication",
    JSON.stringify(tl.body ?? []).includes("transport.published"), `[${tl.status}]`);

  // ---------- 6. One live request per job, withdraw and re-publish ----------
  const dup = await call(`/jobs/${clean.job.id}/transport-request`, tok1, post(publishBody({})));
  check("a second live request on the same job is refused, clearly",
    dup.status === 409 && JSON.stringify(dup.body).includes("already on the notice board"),
    `[${dup.status}] ${JSON.stringify(dup.body).slice(0, 140)}`);

  const cancel = await call(`/transport-requests/${reqId}/cancel`, tok1, { method: "POST" });
  const afterCancel = await owner.query(
    `select status, cancelled_by, cancelled_at from transport_requests where id = $1`, [reqId]);
  check("open request withdrawn with who and when",
    cancel.status === 200 && afterCancel.rows[0]?.status === "cancelled" &&
      !!afterCancel.rows[0]?.cancelled_by && !!afterCancel.rows[0]?.cancelled_at,
    JSON.stringify(afterCancel.rows[0]));
  const republish = await call(`/jobs/${clean.job.id}/transport-request`, tok1, post(publishBody({})));
  const req2 = republish.body?.id;
  check("withdrawn job can be published again", republish.status === 201 && !!req2,
    `[${republish.status}]`);
  await call(`/transport-requests/${req2}/cancel`, tok1, { method: "POST" });
  const cancelTwice = await call(`/transport-requests/${req2}/cancel`, tok1, { method: "POST" });
  check("cancelling twice is idempotent", cancelTwice.status === 200 &&
    (await owner.query(`select cancelled_at from transport_requests where id = $1`, [req2]))
      .rowCount === 1, `[${cancelTwice.status}]`);
  const cancelAcked = await call(`/transport-requests/${acked.body.id}/cancel`, tok1, { method: "POST" });
  check("the acknowledged request can be withdrawn too", cancelAcked.status === 200,
    `[${cancelAcked.status}]`);

  // ---------- 7. Archive records are never published ----------
  await call(`/jobs/${archJob.job.id}/decision`, tok1,
    json({ recordKind: "archive", notes: "Historic file, saved for records" }));
  const archPublish = await call(`/jobs/${archJob.job.id}/transport-request`, tok1,
    post(publishBody({ contactUserId: null })));
  check("an archive job cannot go on the board",
    archPublish.status === 409 && JSON.stringify(archPublish.body).includes("record"),
    `[${archPublish.status}] ${JSON.stringify(archPublish.body).slice(0, 140)}`);

  // ---------- 8. Permission sweep: view-only staff ----------
  const viewPrev = await call(`/jobs/${warnJob.job.id}/transport-preview`, tokView, post({}));
  check("view-only staff can read the preview", viewPrev.status === 200, `[${viewPrev.status}]`);
  const viewPub = await call(`/jobs/${warnJob.job.id}/transport-request`, tokView, post(publishBody({})));
  check("view-only staff cannot publish", viewPub.status === 403, `[${viewPub.status}]`);
  const viewCancel = await call(`/transport-requests/${reqId}/cancel`, tokView, { method: "POST" });
  check("view-only staff cannot withdraw a request", viewCancel.status === 403, `[${viewCancel.status}]`);
  const viewList = await call("/transport-requests", tokView);
  check("view-only staff can list the CFA's own requests",
    viewList.status === 200 && JSON.stringify(viewList.body).includes(reqId), `[${viewList.status}]`);

  // ---------- 9. Cross-tenant probes as tenant B ----------
  const bList = await call("/transport-requests", tok2);
  const bHay = JSON.stringify(bList.body ?? "");
  const aIds = [clean.job.id, warnJob.job.id, reqId, acked.body?.id].filter(Boolean);
  check("B list clean of A's requests and jobs",
    bList.status === 200 && aIds.every((x) => !bHay.includes(x)) && !bHay.includes(fileNumber) &&
      leaks(bHay).length === 0, `[${bList.status}] ${bHay.slice(0, 120)}`);
  const probes: [string, string, any?][] = [
    [`/transport-requests/${reqId}`, "GET"],
    [`/transport-requests/${acked.body.id}/cancel`, "POST"],
    [`/jobs/${clean.job.id}/transport-preview`, "POST"],
    [`/jobs/${clean.job.id}/transport-request`, "POST", publishBody({})],
    [`/jobs/${warnJob.job.id}/transport-request`, "POST", publishBody({ acknowledgeWarnings: true })]
  ];
  for (const [p, method, body] of probes) {
    const r = await call(p, tok2, { method, ...(body ? json(body) : {}) });
    check(`B probe ${method} ${p} rejected`, r.status === 404 || r.status === 403,
      `[${r.status}] ${JSON.stringify(r.body ?? {}).slice(0, 90)}`);
  }
  await call(`/jobs/${bFile.job.id}/decision`, tok2,
    json({ recordKind: "live", transportNeeded: true, consent: "granted" }));
  const bOnARoute = await call(`/jobs/${bFile.job.id}/transport-request`, tok2,
    post(publishBody({ routeId: ROUTE_A, contactUserId: d2 })));
  check("B cannot publish A's route", bOnARoute.status === 400 &&
    JSON.stringify(bOnARoute.body).includes("route"), `[${bOnARoute.status}] ${JSON.stringify(bOnARoute.body).slice(0, 120)}`);
  const bOnAContact = await call(`/jobs/${bFile.job.id}/transport-request`, tok2,
    post(publishBody({ routeId: ROUTE_B, contactUserId: d1 })));
  check("B cannot name A's staff as its contact", bOnAContact.status === 400 &&
    JSON.stringify(bOnAContact.body).includes("contact"), `[${bOnAContact.status}]`);
  const bPublish = await call(`/jobs/${bFile.job.id}/transport-request`, tok2,
    post(publishBody({ routeId: ROUTE_B, contactUserId: d2, pickupText: "Beta warehouse",
      destText: "Mwanza", contactName: "Beta Director" })));
  const bReq = bPublish.body?.id;
  check("positive: B publishes its own request", bPublish.status === 201 && !!bReq,
    `[${bPublish.status}] ${JSON.stringify(bPublish.body).slice(0, 140)}`);
  const bRowJson = (await owner.query(
    `select coalesce(to_jsonb(t)::text,'') as j, t.company_name as cn, t.distance_km as km,
            t.route_label as rl
       from transport_requests t where id = $1`, [bReq])).rows[0];
  check("B's card and route are its own, not smeared from A",
    bRowJson?.cn === "Transprobe Beta Ltd" && bRowJson?.km === 90 &&
      bRowJson?.rl === "Beta corridor", JSON.stringify(bRowJson && { cn: bRowJson.cn, km: bRowJson.km, rl: bRowJson.rl }));
  check("RULE 0: B's row leaks no client, cost or rate either",
    !!bRowJson && !["Beta Client Co", "Beta Supplier GmbH", "850.75", "JTPU1234567"]
      .some((p) => bRowJson.j.includes(p)), (bRowJson?.j ?? "no row").slice(0, 160));
  const aList = await call("/transport-requests", tok1);
  check("A's list never shows B's request",
    !JSON.stringify(aList.body).includes(bReq ?? "none"), `[${aList.status}]`);

  // ---------- 10. SQL verification ----------
  const sql = (await owner.query(
    `select
       (select count(*) from transport_requests where tenant_id = $1)::int   as a_req,
       (select count(*) from transport_requests where tenant_id = $2)::int   as b_req,
       (select count(*) from transport_requests where status = 'cancelled')::int as cancelled,
       (select count(*) from transport_requests t join jobs j on j.id = t.job_id
         where t.tenant_id <> j.tenant_id)::int                              as x_job,
       (select count(*) from transport_requests t join cargo_shipments s on s.id = t.shipment_id
         where t.tenant_id <> s.tenant_id)::int                              as x_shipment,
       (select count(*) from transport_requests t join users u on u.id = t.contact_user_id
         where u.tenant_id <> t.tenant_id)::int                              as x_contact,
       (select count(*) from transport_requests t join routes r on r.id = t.route_id
         where r.tenant_id <> t.tenant_id)::int                              as x_route,
       (select count(*) from transport_requests where disclosed_by is null)::int as no_discloser,
       (select count(*) from transport_requests where status = 'cancelled'
         and (cancelled_at is null or cancelled_by is null))::int             as bad_cancel,
       (select count(*) from transport_requests where status = 'temp_booked'
         or status = 'confirmed')::int                                        as premature,
       (select count(*) from transport_requests t join jobs j on j.id = t.job_id
         where t.tenant_id = $1 and j.transport_consent <> 'granted')::int    as consent_gap
     `, [T1, T2])).rows[0];
  check("SQL: A holds its 3 requests (clean, re-published after withdrawal, acknowledged) and B its 1",
    sql.a_req === 3 && sql.b_req === 1, JSON.stringify(sql));
  check("SQL: A's three requests are all withdrawn, with who and when stamped",
    sql.cancelled === 3 && sql.bad_cancel === 0, JSON.stringify(sql));
  check("SQL: zero cross-tenant references (job/shipment/contact/route)",
    sql.x_job === 0 && sql.x_shipment === 0 && sql.x_contact === 0 && sql.x_route === 0,
    JSON.stringify(sql));
  check("SQL: every request records who disclosed it", sql.no_discloser === 0);
  check("SQL: no booking states exist before step 6 runs", sql.premature === 0);
  check("SQL: no published request sits on an unconsented job", sql.consent_gap === 0);

  // ---------- cleanup ----------
  for (const t of WIPE) await owner.query(`delete from ${t} where tenant_id = any($1::uuid[])`, [[T1, T2]]);
  await owner.query(wipeRoles, [[T1, T2]]);
  await owner.query(`delete from users where tenant_id = any($1::uuid[])`, [[T1, T2]]);
  await owner.query(`delete from tenants where id = any($1::uuid[])`, [[T1, T2]]);
  const residue = await owner.query(
    `select (select count(*) from transport_requests where tenant_id = any($1::uuid[]))::int as r,
            (select count(*) from jobs where tenant_id = any($1::uuid[]))::int as j,
            (select count(*) from routes where tenant_id = any($1::uuid[]))::int as ro,
            (select count(*) from tenants where id = any($1::uuid[]))::int as t`, [[T1, T2]]);
  check("cleanup: no probe rows left", residue.rows[0].r === 0 && residue.rows[0].j === 0 &&
    residue.rows[0].ro === 0 && residue.rows[0].t === 0, JSON.stringify(residue.rows[0]));
  console.log(`\ntransport smoke: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " FAILURES"} (ids ${ids.slice(0, 2).join(",").slice(0, 8)}…)`);
  await owner.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
