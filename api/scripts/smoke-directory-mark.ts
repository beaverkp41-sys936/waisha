/**
 * The mark and the hold — smoke for migration 131 (`api/src/routes/directory.routes.ts`,
 * `api/src/routes/control-directory.routes.ts`).
 *
 * Two things are proved here that no static check can reach.
 *
 * The first is the mark's spine: who is being marked is never sent by the caller. A booking-basis
 * mark has its target read out of the job by 131's trigger, and an engagement-basis mark has it read
 * out of the seeker's own paid search row. So the walk asks the trigger's own failure modes: a seat
 * that was not on the job, a second mark on a job already marked, a second mark by the same person
 * on the same card *through a different search* (the bug that made the conflict lookup name the
 * wrong slot), a seeker aiming a mark at a card their search never opened, and the company's answer
 * arriving from a tenant that does not own the card.
 *
 * The second is the hold's signature, walked on the real two-seat order: raise → ask for a
 * signature → a DIFFERENT seat approves on /control/approvals → the definer suspends the card. Then
 * that the card cannot be reinstated by the moderation desk while the paper runs, and comes back up
 * when the hold is lifted. 121's rule that a proposer cannot sign their own paper is exercised as
 * its own step, because on this register it is the only thing standing between one compliance
 * officer and a company's whole board presence.
 *
 * One trap is specifically hunted: `directory_ratings_for` calls 061's `directory_claim_ok`, a
 * security-invoker function that filters on `current_setting('app.tenant_id')`. Called outside a
 * tenant-bound client the setting is empty, the predicate is NULL and every seeker is told their
 * search expired. The read therefore has to answer with marks — and an out-of-tenant claim still
 * has to answer 410.
 *
 * Run: npx tsx scripts/smoke-directory-mark.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const CARRIER = `Mark Smoke Carrier Ltd ${STAMP}`;
const TRADER = `Mark Smoke Trader Ltd ${STAMP}`;
const BYSTANDER = `Mark Smoke Bystander Ltd ${STAMP}`;
const SEEKER_CO = `Mark Smoke Seeker ${STAMP}`;
const EMAIL_SWEEP = `mark.${STAMP}@waisha.test`;
const NAME_SWEEP = "Mark Smoke %";
const COMMENT = "Two boxes handed over at the depot with the seals intact.";
const REPLY = "We train every clerk on seal checks before a box leaves the yard.";
const HIDE = "The writer names a route this company has never run.";
const REASON = "Cargo left at the inland depot without a consignee being told.";
const NOTE = "Two open incidences in the same week, both unattended for days.";
const LIFT = "The company settled both incidences and paid the storage.";
const SIGN = "A second seat signs this hold on the papers read here.";
const REFUSE_NOTE = "The two incidents are the same box, and the depot has already paid.";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const one = async (sql: string, params: any[] = []) => (await oi(sql, params)).rows[0] ?? null;

  const roleOf = async (k: string) => (await oi(
    `select id from roles where key = $1 and tenant_id is null`, [k])).rows[0]?.id;
  const directorRole = await roleOf("director");
  const seekerRole = await roleOf("seeker");
  const complianceRole = await roleOf("compliance_officer");
  const superAdminRole = await roleOf("super_admin");
  const agentRole = await roleOf("customer_service_agent");
  if (!directorRole || !seekerRole || !complianceRole || !superAdminRole || !agentRole) {
    throw new Error("global director/seeker/compliance_officer/super_admin/customer_service_agent roles missing");
  }
  if (await one(`select 1 from information_schema.tables where table_name = 'directory_ratings'`) === null) {
    throw new Error("migration 131 is not applied — run pnpm migrate first");
  }

  // A crashed earlier run's fixtures would sit on the same cards and answer this run's reads, so
  // the sweep matches the family by name prefix rather than by this run's exact ids.
  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [NAME_SWEEP]))
      .rows.map((r: any) => r.id as string);
    if (!tids.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [tids]))
      .rows.map((r: any) => r.id as string);
    const listingIds = (await oi(`select id from directory_listings where tenant_id = any($1::uuid[])`, [tids]))
      .rows.map((r: any) => r.id as string);
    const exclIds = (await oi(`select id, approval_id from directory_exclusions
                                where tenant_id = any($1::uuid[]) or subject_tenant_id = any($1::uuid[])`, [tids]))
      .rows.map((r: any) => r.approval_id).filter(Boolean);
    // 131's mark has no plain `tenant_id` — it carries `listed_tenant_id` and `rater_tenant_id` — so
    // the delete that frees the seeker's search row has to name both, or the whole chain below it
    // (searches → passes → users) is held by a row the sweep never touched.
    await oi(`delete from directory_ratings
               where listed_tenant_id = any($1::uuid[]) or rater_tenant_id = any($1::uuid[])
                  or listing_id = any($2::uuid[]) or rater_user_id = any($3::uuid[])`,
      [tids, listingIds, uids]).catch(() => {});
    await oi(`delete from directory_exclusions
               where tenant_id = any($1::uuid[]) or subject_tenant_id = any($1::uuid[])`,
      [tids]).catch(() => {});
    for (const t of ["seeker_searches", "seeker_search_passes", "directory_listing_regions",
      "directory_listings"]) {
      await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [tids]).catch(() => {});
    }
    if (listingIds.length) {
      await oi(`delete from directory_listings where id = any($1::uuid[])`, [listingIds]).catch(() => {});
    }
    if (exclIds.length) {
      await oi(`delete from platform_approvals where id = any($1::uuid[])`, [exclIds]).catch(() => {});
    }
    for (const t of ["transport_bookings", "transport_requests", "jobs", "cargo_shipments",
      "company_profiles", "seekers", "sessions", "otp_codes"]) {
      await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [tids]).catch(() => {});
    }
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => {});
      await oi(`delete from seekers where user_id = any($1::uuid[])`, [uids]).catch(() => {});
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => {});
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [tids]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [tids]);
  };
  await sweep();
  await oi(`delete from rate_limits where bucket like '%directory%' or bucket like 'control:%'`);

  // ---------------- fixtures ----------------
  const TA = randomUUID(), TB = randomUUID(), TE = randomUUID(),
        TS = randomUUID(), TC = randomUUID();
  const uA = randomUUID(), uB = randomUUID(), uE = randomUUID(), uS = randomUUID();
  const uC1 = randomUUID(), uC2 = randomUUID(), uC3 = randomUUID(), uC4 = randomUUID();
  const ship = randomUUID(), job = randomUUID(), req = randomUUID(), booking = randomUUID();
  const LA = randomUUID(), LB = randomUUID();
  const pass = randomUUID();
  const S1 = randomUUID(), S2 = randomUUID();
  const tokC1 = `mark-c1-${STAMP}`, tokC2 = `mark-c2-${STAMP}`, tokC3 = `mark-c3-${STAMP}`,
    tokC4 = `mark-c4-${STAMP}`;

  for (const [id, type, name, status] of [
    [TA, "transporter", CARRIER, "active"], [TB, "transporter", TRADER, "active"],
    [TE, "transporter", BYSTANDER, "active"], [TS, "seeker", SEEKER_CO, "active"],
    [TC, "platform", `Mark Smoke Platform ${STAMP}`, "active"]
  ] as const) {
    await oi(`insert into tenants (id, type, name, status) values ($1,$2,$3,$4)`, [id, type, name, status]);
  }
  await oi(`insert into cargo_shipments (id, tenant_id, file_number, seq, file_year, shipment_type,
             container_type, consignee_name, consignor_name)
           values ($1,$2,$3,1,2026,'import','20ft','Consignee','Consignor')`,
    [ship, TB, `MK${STAMP}`]);
  await oi(`insert into jobs (id, tenant_id, shipment_id, status) values ($1,$2,$3,'open')`,
    [job, TB, ship]);
  await oi(`insert into transport_requests (id, tenant_id, job_id, shipment_id, cargo_label,
             pickup_text, dest_text, required_date, contact_name, contact_channel, company_name,
             status, disclosed_at)
           values ($1,$2,$3,$4,'2 x 20ft','Dar es Salaam','Arusha', current_date + 3,
             'Trader Desk','+255 700 000 001',$5,'confirmed', now())`,
    [req, TB, job, ship, TRADER]);
  await oi(`insert into transport_bookings (id, request_id, tenant_id, status, contact_name,
             contact_channel, cargo_label, pickup_text, dest_text, required_date, company_name,
             confirmed_at)
           values ($1,$2,$3,'confirmed','Carrier Desk','+255 700 000 002','2 x 20ft',
             'Dar es Salaam','Arusha', current_date + 3, $4, now())`,
    [booking, req, TA, CARRIER]);

  for (const [uid, tid, name, email, type] of [
    [uA, TA, "Carrier Director", `mark.a.${STAMP}@waisha.test`, "director"],
    [uB, TB, "Trader Director", `mark.b.${STAMP}@waisha.test`, "director"],
    [uE, TE, "Bystander Director", `mark.e.${STAMP}@waisha.test`, "director"],
    [uS, TS, "Nadia Searcher", `mark.s.${STAMP}@waisha.test`, "seeker"]
  ] as const) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
              values ($1,$2,$3,$4,'active',$5)`, [uid, tid, type, name, email]);
  }
  await oi(`insert into seekers (id, tenant_id, user_id, first_name, last_name, email_verified_at)
            values ($1,$2,$3,'Nadia','Searcher', now())`, [randomUUID(), TS, uS]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2),($3,$4),($5,$6)`,
    [uA, directorRole, uB, directorRole, uE, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uS, seekerRole]);

  // 061 closes `serves` to the two words the seekers look for, so the carrier is listed as a
  // transporter and the company that hires it as a cfa — both halves of the vocabulary in play.
  for (const [tid, name, listing, serve] of [
    [TA, CARRIER, LA, "transporter"],
    [TB, TRADER, LB, "cfa"]
  ] as const) {
    await oi(`insert into directory_listings (id, tenant_id, serves, company_name, headline,
               contact_name, contact_channel, status, published_at, is_verified)
             values ($1,$2,array[$5],$3,$4,'Desk','+255 700 000 009','live', now(), true)`,
      [listing, tid, name, `Haulage out of ${name.slice(0, 10)}`, serve]);
  }

  for (const [uid, name, email, role, token] of [
    [uC1, "Mark Compliance", `mark.c1.${STAMP}@waisha.test`, complianceRole, tokC1],
    [uC2, "Mark Super", `mark.c2.${STAMP}@waisha.test`, superAdminRole, tokC2],
    [uC3, "Mark Agent", `mark.c3.${STAMP}@waisha.test`, agentRole, tokC3],
    [uC4, "Mark Compliance Two", `mark.c4.${STAMP}@waisha.test`, complianceRole, tokC4]
  ] as const) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status, email, totp_enabled)
              values ($1,$2,'platform',$3,'active',$4,true)`, [uid, TC, name, email]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uid, role]);
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
               refresh_token_hash, user_agent, ip, expires_at)
             values ($1,$2,$3,$4, now() + interval '2 hours', $5, 'smoke-directory-mark',
               '127.0.0.1', now() + interval '2 hours')`,
      [randomUUID(), uid, TC, randomUUID(), sha256(token)]);
  }

  // The seeker's own paid searches. `listing_id` is the card the search opened, which is the whole
  // proof an engagement-basis mark stands on, so both rows are opened on LA. 061 closes the product
  // catalog to `free`/`weekly` and the pass `kind` to the same two words, so the pass rides on the
  // seeded weekly product instead of a synthetic one.
  const weekly = (await oi(`select id, window_hours, searches_allowed from seeker_pass_products
                             where key = 'weekly'`)).rows[0];
  if (!weekly) throw new Error("061's weekly pass product is missing — run pnpm seed");
  await oi(`insert into seeker_search_passes (id, tenant_id, user_id, product_id, kind, status,
             searches_allowed, searches_used, starts_at, expires_at)
           values ($1,$2,$3,$4,'weekly','live',$5,2, now(), now() + interval '168 hours')`,
    [pass, TS, uS, weekly.id, weekly.searches_allowed]);
  for (const sid of [S1, S2]) {
    await oi(`insert into seeker_searches (id, tenant_id, user_id, pass_id, listing_id, query,
               credits_left)
             values ($1,$2,$3,$4,$5,$6,$7)`,
      [sid, TS, uS, pass, LA, `mark smoke ${sid}`, weekly.searches_allowed - 2]);
  }

  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);
  const tokA = await mint(uA, TA, ["director"]);
  const tokB = await mint(uB, TB, ["director"]);
  const tokE = await mint(uE, TE, ["director"]);
  const tokS = await mint(uS, TS, ["seeker"]);

  const bodies: string[] = [];
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
    bodies.push(text);
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  }
  const control = (token: string) => ({ Cookie: `waisha_control=${token}` });
  const post = (path: string, token: string | null, body: unknown, headers = {}) =>
    call(path, token, { method: "POST", body: JSON.stringify(body), headers });
  const msg = (r: any) => String(r.json?.error?.message ?? r.text ?? "").slice(0, 160);

  // ============================================================
  phase("1. the mark on a card a seeker opened");
  const mkS = await post("/directory/ratings", tokS, { stars: 5, comment: COMMENT, searchId: S1 });
  check("a seeker marks the card their search opened", mkS.status === 200 || mkS.status === 201, msg(mkS));
  const ratingS = mkS.json?.ratingId;
  check("the card is read off the search, not sent by the caller",
    mkS.json?.listingId === LA, mkS.json);

  const rowS = await one(`select basis, rater_kind, listing_id, listed_tenant_id, listed_name,
       rater_user_id, rater_name, stars, comment, booking_id, search_id
       from directory_ratings where id = $1`, [ratingS]);
  check("the register holds an engagement mark by a seeker against LA",
    rowS?.basis === "engagement" && rowS?.rater_kind === "seeker" && rowS?.listing_id === LA
    && rowS?.listed_tenant_id === TA && rowS?.booking_id === null, rowS);
  check("a seeker is never named on the board", rowS?.rater_name === "a seeker on WAISHA",
    rowS?.rater_name);

  const again = await post("/directory/ratings", tokS, { stars: 1, comment: REASON, searchId: S2 });
  check("one mark per person per card, even through a second search",
    again.status === 409 && (again.json?.error?.details ?? []).some((d: any) =>
      d.reason === "already_marked"), again.json?.error);
  check("the refusal names the mark already standing",
    !!again.json?.error?.details?.find?.((d: any) => d.ratingId === ratingS), again.json?.error?.details);

  const offBoard = await post("/directory/ratings", tokS, { stars: 2, comment: REASON, searchId: booking });
  check("a search the caller does not own cannot carry a mark", offBoard.status === 409, offBoard.status);

  // ============================================================
  phase("2. the mark on a job that was actually booked");
  const mkA = await post("/directory/ratings", tokA, { stars: 4, comment: COMMENT, bookingId: booking });
  check("the carrier marks the counterparty of its confirmed job",
    mkA.status === 200 || mkA.status === 201, msg(mkA));
  check("the target is the trader's card, worked out of the job", mkA.json?.listingId === LB, mkA.json);
  const rowA = await one(`select basis, rater_kind, listing_id, listed_tenant_id, rater_name, rater_tenant_id
       from directory_ratings where id = $1`, [mkA.json?.ratingId]);
  check("a booking mark is filed as a company speaking for its tenant",
    rowA?.basis === "booking" && rowA?.rater_kind === "company" && rowA?.listing_id === LB
    && rowA?.listed_tenant_id === TB && rowA?.rater_tenant_id === TA && rowA?.rater_name === CARRIER, rowA);

  const mkE = await post("/directory/ratings", tokE, { stars: 1, comment: REASON, bookingId: booking });
  check("a seat that was not on the job cannot mark it", mkE.status === 409, mkE.status);
  check("the refusal is the database's sentence, not a 500",
    /only the two companies/i.test(msg(mkE)), msg(mkE));

  const mkB = await post("/directory/ratings", tokB, { stars: 5, comment: COMMENT, bookingId: booking });
  check("a job is marked once, whichever seat answers for the company", mkB.status === 409, mkB.status);

  const noProof = await post("/directory/ratings", tokA, { stars: 3, comment: COMMENT });
  check("a mark without a proof is refused before the definer is reached",
    noProof.status === 400, noProof.status);
  const bothProof = await post("/directory/ratings", tokA,
    { stars: 3, comment: COMMENT, bookingId: booking, searchId: S1 });
  check("a mark with two proofs is refused too", bothProof.status === 400, bothProof.status);

  // ============================================================
  phase("3. reading the marks back");
  const read = await call(`/directory/companies/${LA}/ratings?searchId=${S1}`, tokS);
  check("the card's marks read inside the tenant transaction, so a live claim is not 'expired'",
    read.status === 200, msg(read));
  check("the seeker's own mark is on the list",
    (read.json?.marks ?? []).some((m: any) => m.id === ratingS), read.json?.marks?.length);
  check("the summary counts the card",
    Number(read.json?.summary?.marks ?? 0) >= 1 && Number(read.json?.summary?.five ?? 0) === 1
    && read.json?.summary?.listing_id === LA, read.json?.summary);
  check("the summary counts who wrote them, because a board of seekers is not a board of traders",
    Number(read.json?.summary?.from_seekers ?? 0) >= 1 && "mean" in (read.json?.summary ?? {}),
    read.json?.summary);

  const forged = await call(`/directory/companies/${LA}/ratings?searchId=${randomUUID()}`, tokS);
  check("a claim the caller does not hold answers 410, not somebody else's marks",
    forged.status === 410 && forged.json?.error?.code === "SEARCH_EXPIRED", forged.json?.error);
  // 061's claim is a five-minute window on the register, not a lock on one card — `directory_claim_ok`
  // filters by tenant and age and never by listing. So the honest hazard is not "a claim reads a
  // second card", it is "a read of a second card answers with the first card's marks".
  const foreign = await call(`/directory/companies/${LB}/ratings?searchId=${S1}`, tokS);
  check("a live claim reads the card that was asked for, not the card the search opened",
    foreign.status === 200 && foreign.json?.listingId === LB
    && foreign.json?.summary?.listing_id === LB
    && !(foreign.json?.marks ?? []).some((m: any) => m.id === ratingS), foreign.json);

  const mine = await call("/directory/ratings/mine", tokS);
  check("the seeker reads their own words without a duty", mine.status === 200, msg(mine));
  check("the seeker's history holds this run's mark",
    (mine.json?.marks ?? mine.json?.rows ?? []).some((m: any) => m.id === ratingS),
    mine.json && Object.keys(mine.json));

  const received = await call("/directory/ratings/received", tokB);
  check("the company reads what was written about it", received.status === 200, msg(received));
  check("the marks under the card are the ones filed against the trader",
    (received.json?.marks ?? []).some((m: any) => m.id === mkA.json?.ratingId),
    received.json?.marks?.length);
  check("a director is told they may answer", received.json?.canAnswer === true, received.json?.canAnswer);

  const receivedOps = await call("/directory/ratings/received", tokA);
  check("the carrier reads its own inbox too", receivedOps.status === 200, msg(receivedOps));

  // ============================================================
  phase("4. editing, answering and withdrawing");
  const edit = await post(`/directory/ratings/${ratingS}/edit`, tokS,
    { stars: 4, comment: "Two boxes handed over with the seals intact and on time." });
  check("the author may retype their own mark before it is answered", edit.status === 200, msg(edit));

  const wrongHand = await post(`/directory/ratings/${ratingS}/edit`, tokA, { stars: 1 });
  check("nobody else can retype it", wrongHand.status === 403, wrongHand.status);

  const replyForeign = await post(`/directory/ratings/${ratingS}/reply`, tokB, { reply: REPLY });
  check("only the company the card belongs to can answer a mark on it",
    replyForeign.status === 403, replyForeign.status);

  const replyOwn = await post(`/directory/ratings/${ratingS}/reply`, tokA, { reply: REPLY });
  check("the company answers the mark under its own card", replyOwn.status === 200, msg(replyOwn));
  const afterReply = await post(`/directory/ratings/${ratingS}/edit`, tokS, { stars: 5 });
  check("an answered mark cannot be retyped out from under the answer",
    afterReply.status === 409, afterReply.status);
  const replyTwice = await post(`/directory/ratings/${ratingS}/reply`, tokA, { reply: REPLY });
  check("a mark carries one answer", replyTwice.status === 409, replyTwice.status);

  const shortReply = await post(`/directory/ratings/${ratingS}/reply`, tokA, { reply: "noted" });
  check("a two-word answer never reaches the definer", shortReply.status === 400, shortReply.status);

  const withdrawOther = await post(`/directory/ratings/${ratingS}/withdraw`, tokB, {});
  check("only the author can withdraw a mark", withdrawOther.status === 403, withdrawOther.status);
  const withdrawOwn = await post(`/directory/ratings/${ratingS}/withdraw`, tokS, {});
  check("the author takes their own mark off the board", withdrawOwn.status === 200, msg(withdrawOwn));
  const rowW = await one(`select withdrawn_at, withdrawn_by, reply, stars from directory_ratings
       where id = $1`, [ratingS]);
  check("a withdrawn mark keeps its row, its stars and the company's answer",
    !!rowW?.withdrawn_at && rowW?.withdrawn_by === uS && !!rowW?.reply, rowW);
  const refill = await post("/directory/ratings", tokS, { stars: 1, comment: REASON, searchId: S1 });
  check("withdrawing does not free the slot for a second bite", refill.status === 409, refill.status);

  // ============================================================
  phase("5. the office's hand on the board");
  const board = await call("/control/directory/ratings?state=all", null, { headers: control(tokC1) });
  check("the marks register reads for a compliance seat", board.status === 200, msg(board));
  check("the register carries the marks this run wrote",
    (board.json?.rows ?? []).some((r: any) => r.id === mkA.json?.ratingId), board.json?.rows?.length);
  check("the counts answer with the words the filter accepts",
    board.json?.counts && ["live", "hidden", "withdrawn", "awaiting_answer", "replied"]
      .every(k => k in board.json.counts), Object.keys(board.json?.counts ?? {}));

  const hide = await post(`/control/directory/ratings/${mkA.json?.ratingId}/moderate`, null,
    { action: "hide", reason: HIDE }, control(tokC1));
  check("the office takes a mark off the board", hide.status === 200, msg(hide));
  const rowH = await one(`select hidden_at, hidden_by, hidden_reason, stars, comment
       from directory_ratings where id = $1`, [mkA.json?.ratingId]);
  check("a hidden mark is not deleted — its stars and words stay readable to a register",
    !!rowH?.hidden_at && rowH?.hidden_by === uC1 && rowH?.hidden_reason === HIDE
    && rowH?.stars === 4 && rowH?.comment === COMMENT, rowH);

  const hideShort = await post(`/control/directory/ratings/${mkA.json?.ratingId}/moderate`, null,
    { action: "hide", reason: "no" }, control(tokC1));
  check("a hide without a reason is refused", hideShort.status === 400, hideShort.status);
  const agentHide = await post(`/control/directory/ratings/${mkA.json?.ratingId}/moderate`, null,
    { action: "unhide", reason: HIDE }, control(tokC3));
  check("a seat that can read the register cannot moderate it", agentHide.status === 403, agentHide.status);

  const unhide = await post(`/control/directory/ratings/${mkA.json?.ratingId}/moderate`, null,
    { action: "unhide", reason: "The route is on the company's own published corridor list." },
    control(tokC1));
  check("the office can put a mark back on the board", unhide.status === 200, msg(unhide));
  const rowU = await one(`select hidden_at, hidden_reason from directory_ratings where id = $1`,
    [mkA.json?.ratingId]);
  check("un-hiding clears the hand and the reason together",
    rowU?.hidden_at === null && rowU?.hidden_reason === null, rowU);

  const noCookie = await call("/control/directory/ratings", null);
  check("the register is closed to an anonymous caller", noCookie.status === 401, noCookie.status);

  // ============================================================
  phase("6. the hold, signed by two seats");
  const raise = await post("/control/directory/exclusions", null, {
    subjectKind: "company", subjectId: LA, reasonCode: "complaint",
    reason: REASON, note: NOTE, days: 30
  }, control(tokC1));
  check("a compliance seat raises a dated hold on a company", raise.status === 201, msg(raise));
  const holdId = raise.json?.exclusion_id ?? raise.json?.id;
  check("the paper is numbered and starts as a draft",
    /^BL-\d{4}-\d{5,}$/.test(String(raise.json?.ref)) && raise.json?.state === "raised", raise.json);
  const holdRow = await one(`select ref, subject_kind, subject_name, subject_label, company_name,
       subject_tenant_id, listing_id, status, days, raised_by, starts_at, approval_id
       from directory_exclusions where id = $1`, [holdId]);
  check("everything about the subject is read out of the register, not typed by the desk",
    holdRow?.subject_kind === "company" && holdRow?.subject_name === CARRIER
    && holdRow?.company_name === CARRIER && holdRow?.subject_tenant_id === TA
    && holdRow?.listing_id === LA && holdRow?.status === "raised" && holdRow?.days === 30
    && holdRow?.raised_by === uC1 && holdRow?.starts_at === null && holdRow?.approval_id === null,
    holdRow);

  // Two drafts on one company are allowed — 131's one-live index is partial on `status = 'active'`,
  // because a desk keeps notes on a company while an older paper runs against it. It is the second
  // RUNNING hold the register refuses, not the second raised one.
  const raiseAgain = await post("/control/directory/exclusions", null, {
    subjectKind: "company", subjectId: LA, reasonCode: "complaint",
    reason: REASON, note: NOTE, days: 30
  }, control(tokC1));
  check("a second draft on one company is allowed, because only one hold can ever run on it",
    raiseAgain.status === 201, msg(raiseAgain));
  const thirdHold = raiseAgain.json?.exclusion_id ?? raiseAgain.json?.id;

  const raiseB = await post("/control/directory/exclusions", null, {
    subjectKind: "company", subjectId: LB, reasonCode: "abuse",
    reason: REASON, note: NOTE, days: 5
  }, control(tokC1));
  check("a paper can be raised on the second company too", raiseB.status === 201, msg(raiseB));
  const secondHold = raiseB.json?.exclusion_id ?? raiseB.json?.id;

  const agentRaise = await post("/control/directory/exclusions", null, {
    subjectKind: "company", subjectId: LB, reasonCode: "abuse",
    reason: REASON, note: NOTE, days: 5
  }, control(tokC3));
  check("reading the register is not enough to put a company off it",
    agentRaise.status === 403, agentRaise.status);

  const badSubject = await post("/control/directory/exclusions", null, {
    subjectKind: "company", subjectId: randomUUID(), reasonCode: "abuse",
    reason: REASON, note: NOTE, days: 5
  }, control(tokC1));
  check("a card that does not exist is refused with the register's own sentence",
    badSubject.status === 409 || badSubject.status === 400, badSubject.status);

  const sign = await post(`/control/directory/exclusions/${holdId}/signature`, null,
    { reason: SIGN }, control(tokC1));
  check("the raising seat asks for a second signature", sign.status === 201, msg(sign));
  const approvalId = sign.json?.approval_id ?? sign.json?.id;
  const holdRow2 = await one(`select status, approval_id from directory_exclusions where id = $1`,
    [holdId]);
  check("the paper now stands on an open signature",
    holdRow2?.status === "pending_signature" && holdRow2?.approval_id === approvalId, holdRow2);
  const signed = await one(`select action, status, proposed_by, payload_sha256,
       (payload->>'days')::int as days, target_id
       from platform_approvals where id = $1`, [approvalId]);
  check("the window is inside the payload the second seat signs",
    signed?.action === "directory.exclusion" && signed?.status === "pending"
    && signed?.proposed_by === uC1 && /^[0-9a-f]{64}$/.test(String(signed?.payload_sha256))
    && signed?.days === 30 && signed?.target_id === holdId, signed);
  const resign = await post(`/control/directory/exclusions/${holdId}/signature`, null,
    { reason: SIGN }, control(tokC1));
  check("one paper holds one open signature", resign.status === 409, resign.status);

  const selfSign = await post(`/control/approvals/${approvalId}/approve`, null,
    { note: SIGN }, control(tokC1));
  check("the seat that raised a hold cannot be the seat that signs it",
    selfSign.status >= 400, selfSign.status);
  const stillDown = await one(`select status, held_by_exclusion from directory_listings where id = $1`,
    [LA]);
  check("an unsigned paper takes nothing off the board",
    stillDown?.status === "live" && stillDown?.held_by_exclusion === false, stillDown);

  const approved = await post(`/control/approvals/${approvalId}/approve`, null,
    { note: SIGN }, control(tokC2));
  check("a second seat signs the hold and it is spent", approved.status === 200, msg(approved));
  const holdRow3 = await one(`select status, starts_at, ends_at, activated_by,
       (extract(day from (ends_at - starts_at)))::int as span
       from directory_exclusions where id = $1`, [holdId]);
  check("the hold runs for the window that was signed",
    holdRow3?.status === "active" && !!holdRow3?.starts_at && holdRow3?.activated_by === uC2
    && Math.abs(Number(holdRow3?.span ?? 0) - 30) <= 1, holdRow3);
  const listingRow = await one(`select status, held_by_exclusion, suspension_reason
       from directory_listings where id = $1`, [LA]);
  check("the signed hold is what put the card down, and the card carries the paper's own sentence",
    listingRow?.status === "suspended" && listingRow?.held_by_exclusion === true
    && listingRow?.suspension_reason === NOTE, listingRow);
  const approvalRow = await one(`select status, decided_by from platform_approvals where id = $1`,
    [approvalId]);
  check("the signature is recorded as spent by the second seat",
    approvalRow?.status === "applied" && approvalRow?.decided_by === uC2, approvalRow);

  // ============================================================
  phase("7. a held card cannot be brought back by the moderation desk");
  const reinstate = await post(`/control/directory/listings/${LA}/moderate`, null,
    { action: "reinstate", note: "The company says it fixed it." }, control(tokC1));
  check("reinstate is refused while the paper runs", reinstate.status === 409, reinstate.status);
  check("the refusal names the exclusion and the date it ends",
    reinstate.json?.error?.code === "LISTING_HELD"
    && reinstate.json?.error?.details?.[0]?.ref === holdRow?.ref, reinstate.json?.error);
  const verifyHeld = await post(`/control/directory/listings/${LA}/moderate`, null,
    { action: "verify", note: "Looks fine now." }, control(tokC1));
  check("a held card cannot be verified either", verifyHeld.status === 409, verifyHeld.status);

  const held = await call(`/control/directory/held?kind=company&id=${LA}`, null,
    { headers: control(tokC1) });
  check("the desk can ask whether a subject is held", held.status === 200, msg(held));
  check("the answer is the register's own verdict",
    held.json?.held?.ref === holdRow?.ref && !!held.json?.held?.ends_at
    && held.json?.held?.subject_name === CARRIER, held.json?.held);

  const notHeld = await call(`/control/directory/held?kind=company&id=${LB}`, null,
    { headers: control(tokC1) });
  check("a card no paper runs against answers null, not an empty object",
    notHeld.status === 200 && notHeld.json?.held === null, notHeld.json);

  const detail = await call(`/control/directory/exclusions/${holdId}`, null, { headers: control(tokC1) });
  check("one paper reads whole, with its signature and its window", detail.status === 200, msg(detail));
  check("the detail carries the signed state and the days left",
    detail.json?.exclusion?.status === "active" || detail.json?.status === "active",
    Object.keys(detail.json ?? {}));

  // 131's board answers `live` for "running and not yet ended"; `active` is the row's state word,
  // not the filter's, and the route's enum refuses it before the definer is reached.
  const queue = await call("/control/directory/exclusions?state=live&kind=company", null,
    { headers: control(tokC1) });
  check("the register filters to the running company holds", queue.status === 200, msg(queue));
  check("this run's hold is in the queue",
    (queue.json?.rows ?? []).some((r: any) => r.id === holdId), queue.json?.rows?.length);
  check("the queue counts the states a desk triages by",
    Number(queue.json?.counts?.running ?? 0) >= 1
    && Number(queue.json?.counts?.companies ?? 0) >= 2, queue.json?.counts);

  // ============================================================
  phase("8. lifting the hold");
  const lift = await post(`/control/directory/exclusions/${holdId}/lift`, null,
    { note: LIFT }, control(tokC1));
  check("the office lifts the hold with a sentence", lift.status === 200, msg(lift));
  check("the answer states the card it put back up", lift.json?.card_restored === true, lift.json);
  const listingRow2 = await one(`select status, held_by_exclusion, suspension_reason
       from directory_listings where id = $1`, [LA]);
  check("the card is live again and no longer held",
    listingRow2?.status === "live" && listingRow2?.held_by_exclusion === false
    && listingRow2?.suspension_reason === null, listingRow2);
  const holdRow4 = await one(`select status, lifted_at::text as lifted_at, lifted_note, lifted_by
       from directory_exclusions where id = $1`, [holdId]);
  check("the lifted paper stays on the register with the reason it was lifted",
    holdRow4?.status === "lifted" && !!holdRow4?.lifted_at && holdRow4?.lifted_note === LIFT
    && holdRow4?.lifted_by === uC1, holdRow4);

  // Pressing lift twice is how a desk loses the first lift's date. 131's definer answers the second
  // call as `already` rather than as a conflict, and rewrites nothing — so the assertion is that the
  // hand, the hour and the sentence on the paper are still the first ones.
  const liftTwice = await post(`/control/directory/exclusions/${holdId}/lift`, null,
    { note: "A second seat presses the button again." }, control(tokC1));
  check("a paper already lifted answers as already done",
    liftTwice.status === 200 && liftTwice.json?.already === true, msg(liftTwice));
  const holdRow4b = await one(`select lifted_at::text as lifted_at, lifted_note, lifted_by
       from directory_exclusions where id = $1`, [holdId]);
  check("the second lift leaves the first lift's hand, hour and sentence on the paper",
    holdRow4b?.lifted_at === holdRow4?.lifted_at && holdRow4b?.lifted_note === LIFT
    && holdRow4b?.lifted_by === uC1, holdRow4b);
  const liftAudit = await one(`select count(*)::int as n from audit_logs
       where entity = 'directory_exclusions' and entity_id = $1
         and action = 'directory.exclusion_lifted'`, [holdId]);
  check("the second press wrote no new sentence in the audit trail",
    Number(liftAudit?.n ?? 0) === 1, liftAudit?.n);

  // ============================================================
  phase("9. a paper refused, and the export");
  const sign2 = await post(`/control/directory/exclusions/${secondHold}/signature`, null,
    { reason: SIGN }, control(tokC1));
  check("the second raised paper can be put up for signature", sign2.status === 201, msg(sign2));
  const approval2 = sign2.json?.approval_id;

  // Putting a paper down is the raising desk's own door and costs the exclusion duty; the seat that
  // holds the signature says no on /control/approvals instead. The two doors are not the same key.
  const refuseBySigner = await post(`/control/directory/exclusions/${secondHold}/refuse`, null,
    { note: "The office has looked and will not hold this company." }, control(tokC2));
  check("putting a paper down costs the exclusion duty, not the signature duty",
    refuseBySigner.status === 403, refuseBySigner.status);

  const refuse = await post(`/control/directory/exclusions/${secondHold}/refuse`, null,
    { note: REFUSE_NOTE }, control(tokC1));
  check("the seat that raised a paper can put it down instead of pushing it",
    refuse.status === 200, msg(refuse));
  const holdRow5 = await one(`select status, approval_id, refused_by, refused_note,
       (select status from platform_approvals where id = directory_exclusions.approval_id) as a_status,
       (select decided_by from platform_approvals where id = directory_exclusions.approval_id) as a_decided
       from directory_exclusions where id = $1`, [secondHold]);
  check("a refused paper is finished", holdRow5?.status === "refused", holdRow5);
  check("the refusal is on the paper with the hand and the sentence that wrote it",
    holdRow5?.refused_by === uC1 && holdRow5?.refused_note === REFUSE_NOTE, holdRow5);
  // 121's two-seat rule is a CHECK on the signature row, not only a route check: `decided_by` may
  // never equal `proposed_by`. The seat entitled to put a paper down is the seat that proposed it, so
  // the same-hand refusal has to close the signature undecided — `lapsed`, the only status 121 lets
  // carry no decider — instead of writing a rejection it is not allowed to sign.
  const appr2 = await one(`select status, decided_by, decided_at
       from platform_approvals where id = $1`, [approval2]);
  check("the same hand that asked for the signature closes it undecided, not as its own rejection",
    appr2?.status === "lapsed" && appr2?.decided_by === null && appr2?.decided_at === null, appr2);
  const freeAgain = await one(`select status, held_by_exclusion from directory_listings where id = $1`,
    [LB]);
  check("the refused company's card never went down",
    freeAgain?.status === "live" && freeAgain?.held_by_exclusion === false, freeAgain);

  const liftRefused = await post(`/control/directory/exclusions/${secondHold}/lift`, null,
    { note: LIFT }, control(tokC1));
  check("a finished paper cannot be lifted", liftRefused.status === 409, liftRefused.status);

  // The other half of that branch. A refusal by a seat that did not propose the paper is a real
  // second opinion, so the signature is recorded as rejected by that hand — which is only legal
  // because the two seats differ.
  const sign3 = await post(`/control/directory/exclusions/${thirdHold}/signature`, null,
    { reason: SIGN }, control(tokC1));
  check("a draft that outlived another paper's whole run can still be put up for signature",
    sign3.status === 201, msg(sign3));
  const approval3 = sign3.json?.approval_id;
  const refuseByOther = await post(`/control/directory/exclusions/${thirdHold}/refuse`, null,
    { note: REFUSE_NOTE }, control(tokC4));
  check("a second compliance seat may put a paper another seat raised down",
    refuseByOther.status === 200, msg(refuseByOther));
  const holdRow6 = await one(`select status, refused_by, refused_note from directory_exclusions
       where id = $1`, [thirdHold]);
  check("the paper records the seat that refused it, not the seat that raised it",
    holdRow6?.status === "refused" && holdRow6?.refused_by === uC4
    && holdRow6?.refused_note === REFUSE_NOTE, holdRow6);
  const appr3 = await one(`select status, proposed_by, decided_by, decided_at, decided_note
       from platform_approvals where id = $1`, [approval3]);
  check("a refusal by a different hand is recorded on the signature as its rejection",
    appr3?.status === "rejected" && appr3?.proposed_by === uC1 && appr3?.decided_by === uC4
    && !!appr3?.decided_at && appr3?.decided_note === REFUSE_NOTE, appr3);
  const laCard = await one(`select status, held_by_exclusion from directory_listings where id = $1`,
    [LA]);
  check("the third paper's refusal left the restored card up",
    laCard?.status === "live" && laCard?.held_by_exclusion === false, laCard);

  const csvMarks = await call("/control/directory/export?register=ratings", null,
    { headers: control(tokC1) });
  check("the marks register exports", csvMarks.status === 200, csvMarks.status);
  check("the export starts with its own header, not a formula",
    csvMarks.text.startsWith("listed_name,stars,comment,basis"), csvMarks.text.slice(0, 60));
  check("the export holds the mark this run wrote",
    csvMarks.text.includes(COMMA_ESC(COMMENT)), csvMarks.text.slice(0, 200));

  const csvHolds = await call("/control/directory/export?register=exclusions&state=all", null,
    { headers: control(tokC1) });
  check("the holds register exports", csvHolds.status === 200, csvHolds.status);
  check("a hold exports its number, its window and its signature state",
    csvHolds.text.startsWith("ref,subject_kind,subject_name")
    && csvHolds.text.includes(holdRow?.ref ?? "BL-"), csvHolds.text.slice(0, 120));
  const agentCsv = await call("/control/directory/export?register=ratings", null,
    { headers: control(tokC2) });
  check("the export is a read, so the signing seat can pull it too",
    agentCsv.status === 200, agentCsv.status);

  // ============================================================
  phase("10. what the register proves about itself");
  const pii = await one(`select string_agg(column_name, ',') as cols from information_schema.columns
       where table_name = 'directory_ratings'`);
  check("no mark holds a NIDA number, a phone or a sealed credential",
    !/nida|phone|password|otp|secret/i.test(String(pii?.cols)), pii?.cols);
  const audit = await one(`select count(*)::int as n from audit_logs
       where entity in ('directory_ratings','directory_exclusions') and action like 'directory.%'`);
  check("every write to the mark and the hold left an audit row",
    Number(audit?.n ?? 0) >= 8, audit?.n);
  const actor = await one(`select count(*)::int as n from audit_logs
       where entity = 'directory_exclusions' and action = 'directory.exclusion_proposed'
         and actor_user_id = $1`, [uC1]);
  check("the proposal is audited against the seat that raised it", Number(actor?.n ?? 0) >= 1, actor?.n);
  const selfApplied = await one(`select count(*)::int as n from directory_exclusions e
       join platform_approvals a on a.id = e.approval_id
       where e.raised_by = a.decided_by`);
  check("no hold on the register was raised and signed by one seat",
    Number(selfApplied?.n ?? 1) === 0, selfApplied?.n);

  // audit_logs refuses DELETE through its own append-only trigger, so the sentences this run wrote
  // stay — which is the point of the register. Everything that could be mistaken for a real
  // company's marks or a live hold leaves.
  await sweep();
  const residue = await one(`select
       (select count(*) from tenants where name like $1) as tenants,
       (select count(*) from directory_listings where company_name like $1) as cards,
       (select count(*) from directory_exclusions where company_name like $1) as holds,
       (select count(*) from directory_ratings where listed_name like $1) as marks,
       (select count(*) from seeker_search_passes where tenant_id in
          (select id from tenants where name like $1)) as passes,
       (select count(*) from seeker_searches where tenant_id in
          (select id from tenants where name like $1)) as searches,
       (select count(*) from users where tenant_id in
          (select id from tenants where name like $1)) as seats`,
    [NAME_SWEEP]);
  check("no fixture company, card or hold is left behind",
    Object.values(residue ?? {}).every((n: any) => Number(n) === 0), residue);

  await owner.end();
  if (failures) {
    console.log(`\n${failures} FAILED`);
    const odd = bodies.filter(b => /"code":"INTERNAL"/.test(b));
    if (odd.length) console.log("500s seen:", odd.slice(0, 2));
    process.exit(1);
  }
  console.log("\ndirectory mark and exclusion smoke passed");
}

/** A CSV cell is quoted, so the probe has to match the words inside the quotes, not the raw string. */
function COMMA_ESC(s: string) { return s.split(",")[0].slice(0, 20); }

main().catch((e) => { console.error(e); process.exit(1); });
