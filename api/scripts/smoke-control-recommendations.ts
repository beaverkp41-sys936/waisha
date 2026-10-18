/**
 * The recommendation inbox over HTTP — smoke for #118 (routes on 070).
 *
 * The verify script proves the SQL. A request proves different things: that the three
 * author doors (transporter staff, shipper portal, seeker shell) all land in ONE register
 * rather than three silos, that the duty gate is the seeded matrix and not the role key in
 * the token, that a portal-only token is turned away from the staff door before it reaches
 * a handler, that the control desk answers with the row it wrote (a definer that returns
 * an empty set saves the decision and shows the desk nothing), and that a business-rule
 * refusal arrives as a 409 carrying a sentence a person can act on — not a 500.
 *
 * Seats are built to differ by exactly one thing each: a director and a driver who both
 * hold the pen, an auditor who can read but not write, a seat with no duty at all, a
 * shipper and a seeker who may only use their own door, and on the desk side an analyst
 * who reads it, a service agent who answers, and a Super Admin.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-control-recommendations.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);
const STAMP = Date.now().toString().slice(-8);
const TENANT_SWEEP = "RecSmoke %";
const EMAIL_SWEEP = "smoke.rec.%@waisha.test";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const bodies: string[] = [];
async function call(path: string, opts: { token?: string | null; cookie?: string } = {},
  init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { Cookie: `waisha_control=${opts.cookie}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  bodies.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const note = (title: string, body: string, area = "transport") =>
  JSON.stringify({ area, title, body });

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const roleRows = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "customer_service_agent", "platform_analyst", "director", "driver",
      "auditor", "seeker", "shipper_portal"]]
  )).rows;
  const rid = (k: string) => roleRows.find(r => r.key === k)?.id;
  for (const k of ["super_admin", "customer_service_agent", "platform_analyst", "director",
    "driver", "auditor", "seeker", "shipper_portal"])
    if (!rid(k)) throw new Error(`global role ${k} is missing — 070 not applied?`);

  const TC = randomUUID(), CO = randomUUID(), SK = randomUUID();
  const ids = {
    dir: randomUUID(), drv: randomUUID(), aud: randomUUID(), none: randomUUID(),
    thr: randomUUID(), ship: randomUUID(), seek: randomUUID(),
    sa: randomUUID(), csa: randomUUID(), an: randomUUID(), dirCtl: randomUUID()
  };
  const tok = (who: string) => `rec-smoke-${who}-${STAMP}`;

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map(r => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map(r => r.tenant_id).filter(Boolean);
    const all = [...new Set([...tids, ...byEmail])];
    if (all.length) {
      const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
        .rows.map(r => r.id);
      if (uids.length) {
        await oi(`delete from recommendations where author_user_id = any($1::uuid[])`, [uids])
          .catch(() => { });
        await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
        await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      }
      await oi(`delete from recommendations where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
    }
    await oi(`delete from rate_limits where bucket like 'recommendations:uid:%'`);
  };
  await sweep();

  // ---------------- fixtures ----------------
  await oi(`insert into tenants (id, type, name, status) values ($1,'platform',$2,'active')`,
    [TC, `RecSmoke Platform ${STAMP}`]);
  await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')`,
    [CO, `RecSmoke Mwanza Freight ${STAMP}`]);
  await oi(`insert into tenants (id, type, name, status) values ($1,'seeker',$2,'active')`,
    [SK, `RecSmoke Seeker ${STAMP}`]);

  const seat = (id: string, tid: string, type: string, name: string, who: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, job_title, status)
        values ($1,$2,$3,$4,$5,$6,'active')`,
      [id, tid, type, name, `smoke.rec.${who}.${STAMP}@waisha.test`,
        who === "dir" ? "Operations Director" : who === "drv" ? "Long-haul driver" : null]);
  await seat(ids.dir, CO, "staff", "Josephine Mwangi", "dir");
  await seat(ids.drv, CO, "staff", "Daudi Salum", "drv");
  await seat(ids.aud, CO, "staff", "Amina Yusuf", "aud");
  await seat(ids.none, CO, "staff", "Nobody At All", "none");
  await seat(ids.thr, CO, "staff", "Third Seat", "thr");
  await seat(ids.ship, CO, "shipper", "Beatris Kaganda", "ship");
  await seat(ids.seek, SK, "seeker", "Baraka Ngowi", "seek");
  await seat(ids.sa, TC, "platform", "Root Seat", "sa");
  await seat(ids.csa, TC, "platform", "Callistow Service", "csa");
  await seat(ids.an, TC, "platform", "Annie Analyst", "an");
  await seat(ids.dirCtl, TC, "platform", "Daudi Director", "dirc");

  await oi(`insert into user_roles (user_id, role_id) values
      ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10),($11,$12),($13,$14),($15,$16),($17,$18)`,
    [ids.dir, rid("director"), ids.drv, rid("driver"), ids.aud, rid("auditor"),
      ids.ship, rid("shipper_portal"), ids.seek, rid("seeker"),
      ids.sa, rid("super_admin"), ids.csa, rid("customer_service_agent"),
      ids.an, rid("platform_analyst"), ids.dirCtl, rid("director")]);
  // A second director, so "the colleague in the same company cannot see my note" is a
  // statement about the author column and not about tenants.
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [ids.thr, rid("director")]);

  const openSession = (uid: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-rec',$6,
          now() + interval '2 hours')`,
      [randomUUID(), uid, TC, randomUUID(), sha256(tok(who)), "127.0.0.1"]);
  for (const [uid, who] of [[ids.sa, "sa"], [ids.csa, "csa"], [ids.an, "an"],
    [ids.dirCtl, "dirc"]] as [string, string][]) await openSession(uid, who);

  const mint = (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
      .setIssuedAt().setExpirationTime("15m").sign(key);

  const tDir = await mint(ids.dir, CO, ["director"]);
  const tDrv = await mint(ids.drv, CO, ["driver"]);
  const tAud = await mint(ids.aud, CO, ["auditor"]);
  const tNone = await mint(ids.none, CO, []);
  const tThr = await mint(ids.thr, CO, ["director"]);
  const tShip = await mint(ids.ship, CO, ["shipper_portal"]);
  const tSeek = await mint(ids.seek, SK, ["seeker"]);
  const ck = (who: string) => ({ cookie: tok(who) });

  const DIR_TITLE = "The trip form makes me retype the plate on every leg";
  const DIR_BODY = "Plate, driver and route are already on the trip. On a three-leg day I type the same plate four times.";
  const DRV_TITLE = "A rest-stop map for the Dar — Mwanza run";
  const DRV_BODY = "Weight bridges and the safe places to sleep are on the office map, not the driver's.";
  const SHIP_TITLE = "Let me see when my cargo actually left the yard";
  const SHIP_BODY = "I get a quote and an invoice but nothing in between, so I phone the office twice a week.";
  const SEEK_TITLE = "Search by the ward the cargo is going to";
  const SEEK_BODY = "Every job I am offered is destination-led and the search only takes the origin ward.";

  try {
    // ---------------- the three doors ----------------
    phase("three doors, one register");
    const anon = await call("/recommendations", {});
    check("an anonymous request to the author surface is turned away",
      anon.status === 401, { s: anon.status });

    const posted = {
      dir: await call("/recommendations", { token: tDir }, { method: "POST", body: note(DIR_TITLE, DIR_BODY) }),
      drv: await call("/recommendations", { token: tDrv }, { method: "POST", body: note(DRV_TITLE, DRV_BODY, "transport") }),
      ship: await call("/portal/recommendations", { token: tShip }, { method: "POST", body: note(SHIP_TITLE, SHIP_BODY, "support") }),
      seek: await call("/seeker/recommendations", { token: tSeek }, { method: "POST", body: note(SEEK_TITLE, SEEK_BODY, "marketplace") })
    };
    for (const [who, r] of Object.entries(posted))
      check(`${who} sent one and the register took it with a status and a moment`,
        r.status === 201 && r.json?.status === "new" && !!r.json?.id && !!r.json?.created_at,
        { s: r.status, e: r.json?.error?.code ?? r.json?.message });

    const asSA = await call("/control/recommendations", ck("sa"));
    const reg: any[] = asSA.json ?? [];
    const mine = new Set(Object.values(posted).map(r => r.json?.id));
    check("the desk sees all four in one list — that is the whole point of the register",
      asSA.status === 200 && [...mine].every(id => reg.some(r => r.id === id)),
      { s: asSA.status, on: reg.length });
    check("…and each arrives with the company it came from, so the desk knows who to call",
      ["RecSmoke Mwanza Freight", "RecSmoke Seeker"].every(n =>
        reg.some(r => String(r.company_name ?? "").startsWith(n))),
      reg.map(r => [r.company_name, r.author_name]));
    check("a seeker's own account type travels with its note",
      reg.find(r => r.id === posted.seek.json?.id)?.company_type === "seeker",
      reg.find(r => r.id === posted.seek.json?.id)?.company_type);
    check("the author's duty arrives too, because a driver and a director are different reads",
      reg.find(r => r.id === posted.drv.json?.id)?.author_job_title === "Long-haul driver",
      reg.find(r => r.id === posted.drv.json?.id)?.author_job_title);
    check("the header counts are on every row of the page it returned",
      reg.length > 0 && reg.every(r => typeof r.matched === "number" && r.matched >= 4),
      reg.slice(0, 1).map(r => [r.matched, r.matched_new]));

    // ---------------- whose door is whose ----------------
    phase("the duty gate, not the role name");
    const audRead = await call("/recommendations", { token: tAud });
    check("an auditor reads its own outbox — 070 gives every seat the read",
      audRead.status === 200 && Array.isArray(audRead.json), { s: audRead.status });
    const audWrite = await call("/recommendations", { token: tAud },
      { method: "POST", body: note("An auditor tries to send one", "This seat holds the read key and deliberately not the pen.") });
    check("…and is refused the pen with a 403, not a silent drop",
      audWrite.status === 403 && audWrite.json?.error?.code === "FORBIDDEN",
      { s: audWrite.status, e: audWrite.json?.error?.code });
    const noneRead = await call("/recommendations", { token: tNone });
    const noneWrite = await call("/recommendations", { token: tNone },
      { method: "POST", body: note("A seat with no duty at all", "Nothing is seeded behind this token.") });
    check("a staff account with no duty holds neither key",
      noneRead.status === 403 && noneWrite.status === 403,
      { r: noneRead.status, w: noneWrite.status });

    phase("the audience gate");
    const seekOnStaff = await call("/recommendations", { token: tSeek });
    check("a seeker token is turned away from the staff door before the handler runs",
      seekOnStaff.status === 403 && /portal accounts/.test(seekOnStaff.json?.error?.message ?? ""),
      { s: seekOnStaff.status, m: seekOnStaff.json?.error?.message });
    const shipOnSeeker = await call("/seeker/recommendations", { token: tShip });
    check("a portal token may use either open door, and what scopes the read is the author id, not the path",
      shipOnSeeker.status === 200 && (shipOnSeeker.json ?? []).length === 1
      && shipOnSeeker.json[0].id === posted.ship.json?.id,
      { s: shipOnSeeker.status, n: (shipOnSeeker.json ?? []).length });
    const staffOnDesk = await call("/control/recommendations", { token: tDir });
    check("a company bearer token does not open the platform register — the cookie does",
      staffOnDesk.status === 401, { s: staffOnDesk.status });
    const forged = await call("/control/recommendations", { cookie: tok("nobody") });
    check("a control cookie with no session row behind it reads nothing",
      forged.status === 401, { s: forged.status });

    // ---------------- what the author can see ----------------
    phase("an author sees their own, never a colleague's");
    const dirList = await call("/recommendations", { token: tDir });
    const thrList = await call("/recommendations", { token: tThr });
    check("the director's own list carries the note they sent",
      dirList.status === 200 && dirList.json.some((r: any) => r.id === posted.dir.json.id),
      dirList.json?.length);
    check("…and nothing the driver sent in the same company",
      !dirList.json.some((r: any) => r.id === posted.drv.json.id),
      dirList.json?.map((r: any) => r.title));
    check("a second director in the same company reads an empty outbox, not the first one's",
      thrList.status === 200 && thrList.json.length === 0, thrList.json?.length);

    // ---------------- validation over the wire ----------------
    phase("the same bounds the table enforces");
    // Three characters: the route's floor and the table's CHECK both sit at four, so this
    // is the shortest title that proves the door works without testing the same bound twice.
    const shortTitle = await call("/recommendations", { token: tDir },
      { method: "POST", body: note("Too", DIR_BODY) });
    check("a title shorter than the table's own floor is a 400 with the field named",
      shortTitle.status === 400 && shortTitle.json?.error?.code === "VALIDATION_FAILED"
      && String(JSON.stringify(shortTitle.json?.error?.details)).includes("title"),
      { s: shortTitle.status, d: shortTitle.json?.error?.details });
    const shortBody = await call("/recommendations", { token: tDir },
      { method: "POST", body: note("A title long enough", "too short") });
    check("…and so is a body nobody could act on",
      shortBody.status === 400, { s: shortBody.status });
    const badArea = await call("/recommendations", { token: tDir },
      { method: "POST", body: JSON.stringify({ area: "logistics", title: "A title that is fine", body: "And a body that is perfectly long enough." }) });
    check("an area outside the vocabulary is refused at the door, not stored and refused later",
      badArea.status === 400, { s: badArea.status });
    const extraField = await call("/recommendations", { token: tDir },
      { method: "POST", body: JSON.stringify({ title: "A title that is fine", body: "And a body that is perfectly long enough.", tenant_id: CO }) });
    check("a request cannot name the tenant it writes into — the token does that",
      extraField.status === 400, { s: extraField.status });
    const badLimit = await call("/control/recommendations?limit=0", ck("sa"));
    check("the desk's page size is bounded at the route, so 0 and 99999 never reach the register",
      badLimit.status === 400, { s: badLimit.status });
    const badFilter = await call("/control/recommendations?status=shipped", ck("sa"));
    check("…and a status outside the vocabulary is refused rather than ignored",
      badFilter.status === 400, { s: badFilter.status });

    // ---------------- the throttle ----------------
    phase("one seat cannot fill the inbox");
    const burst: number[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await call("/recommendations", { token: tThr }, {
        method: "POST",
        body: note(`Flood probe ${i} of nine on a single seat`,
          "Sent to prove the per-account window, then withdrawn with the fixture.")
      });
      burst.push(r.status);
    }
    check("eight notes an hour for one person, and the ninth is a 429",
      burst.slice(0, 8).every(s => s === 201) && burst[8] === 429, burst);
    const floodSeen = await call("/control/recommendations?limit=500", ck("sa"));
    check("…which is a limit on the sender, not a blind spot: the register took the eight",
      (floodSeen.json ?? []).filter((r: any) =>
        String(r.title ?? "").startsWith("Flood probe")).length === 8,
      (floodSeen.json ?? []).filter((r: any) => String(r.title ?? "").startsWith("Flood probe")).length);

    // ---------------- the desk's own gate ----------------
    phase("who may answer");
    const anRead = await call("/control/recommendations?status=new&limit=500", ck("an"));
    check("the analyst reads the queue — measuring what people asked for is a duty",
      anRead.status === 200 && (anRead.json ?? []).every((r: any) => r.status === "new"),
      { s: anRead.status, n: (anRead.json ?? []).length });
    check("…and its header counts follow the filter it asked for",
      anRead.json?.[0] && anRead.json[0].matched === anRead.json.length,
      anRead.json?.[0] && [anRead.json[0].matched, anRead.json.length]);
    const anDecide = await call(`/control/recommendations/${posted.dir.json.id}/decision`,
      ck("an"), { method: "POST", body: JSON.stringify({ status: "planned" }) });
    check("…but an analyst may not close a card, which is the second key 070 splits out",
      anDecide.status === 403 && anDecide.json?.error?.code === "FORBIDDEN",
      { s: anDecide.status, e: anDecide.json?.error?.code });
    const dirc = await call("/control/recommendations", ck("dirc"));
    check("a director seated in the platform tenant holds no control key for this desk",
      dirc.status === 403, { s: dirc.status });

    const triage = await call(`/control/recommendations/${posted.dir.json.id}/decision`,
      ck("csa"), { method: "POST", body: JSON.stringify({ status: "reviewing", priority: "high" }) });
    check("the service agent triages it and gets the row it wrote back, not an empty set",
      triage.status === 200 && triage.json?.id === posted.dir.json.id
      && triage.json?.status === "reviewing" && triage.json?.priority === "high",
      { s: triage.status, b: triage.json });
    const answer = await call(`/control/recommendations/${posted.dir.json.id}/decision`,
      ck("sa"), {
        method: "POST",
        body: JSON.stringify({ status: "built", reply: "Shipped in the September release — the plate now carries across every leg." })
      });
    check("the Super Admin answers it, and an omitted priority keeps the agent's judgement",
      answer.status === 200 && answer.json?.status === "built"
      && answer.json?.priority === "high" && String(answer.json?.reply).startsWith("Shipped in"),
      answer.json);
    const seenByAuthor = await call("/recommendations", { token: tDir });
    const mineRow = (seenByAuthor.json ?? []).find((r: any) => r.id === posted.dir.json.id);
    check("the author reads the answer back on their own surface, with a name and a date on it",
      !!mineRow && mineRow.reply === answer.json.reply && mineRow.status === "built"
      && !!mineRow.replied_at && !!mineRow.decided_at, mineRow);

    const ghost = await call(`/control/recommendations/${randomUUID()}/decision`,
      ck("csa"), { method: "POST", body: JSON.stringify({ status: "reviewing" }) });
    check("a card that is not on the register is refused in a sentence, as a 409 — not a 500",
      ghost.status === 409 && ghost.json?.error?.code === "CONFLICT"
      && /not on the register/.test(ghost.json?.error?.message ?? ""),
      { s: ghost.status, m: ghost.json?.error?.message });
    const tooShortReply = await call(`/control/recommendations/${posted.drv.json.id}/decision`,
      ck("csa"), { method: "POST", body: JSON.stringify({ status: "new", reply: "ok" }) });
    check("an answer too short to be an answer is stopped at the route, before the register is called",
      tooShortReply.status === 400
      && String(JSON.stringify(tooShortReply.json?.error?.details)).includes("reply"),
      { s: tooShortReply.status, d: tooShortReply.json?.error?.details });
    const retract = await call(`/control/recommendations/${posted.dir.json.id}/decision`,
      ck("sa"), { method: "POST", body: JSON.stringify({ status: "built", reply: null }) });
    check("an answer can be taken back, and the desk is told the sentence is gone",
      retract.status === 200 && retract.json?.reply === null, retract.json);

    // ---------------- withdrawal ----------------
    phase("withdrawal, not deletion");
    const pullRead = await call("/recommendations", { token: tDrv });
    check("the driver's own note is still there to pull",
      pullRead.status === 200 && pullRead.json.some((r: any) => r.id === posted.drv.json.id),
      pullRead.json?.length);
    const pullStranger = await call(`/recommendations/${posted.drv.json.id}/withdraw`,
      { token: tDir }, { method: "POST" });
    check("a colleague in the same company cannot withdraw a note they did not write",
      pullStranger.status === 409, { s: pullStranger.status });
    const pullAnswered = await call(`/recommendations/${posted.dir.json.id}/withdraw`,
      { token: tDir }, { method: "POST" });
    check("and the author cannot pull one the desk has already read",
      pullAnswered.status === 409 && /nobody has read yet/.test(pullAnswered.json?.error?.message ?? ""),
      { s: pullAnswered.status, m: pullAnswered.json?.error?.message });
    const pullMine = await call(`/recommendations/${posted.drv.json.id}/withdraw`,
      { token: tDrv }, { method: "POST" });
    check("an unread note goes when its author asks",
      pullMine.status === 200 && pullMine.json?.withdrawn === true, pullMine.json);
    const afterPull = await call("/recommendations", { token: tDrv });
    check("…and leaves the author's outbox",
      !afterPull.json.some((r: any) => r.id === posted.drv.json.id), afterPull.json?.length);
    const regAfter = await call("/control/recommendations?limit=500", ck("sa"));
    check("…and off the register, while the row itself stays on the table",
      !(regAfter.json ?? []).some((r: any) => r.id === posted.drv.json.id)
      && (await oi(`select count(*)::int as n from recommendations where id = $1`,
        [posted.drv.json.id])).rows[0].n === 1,
      (await oi(`select deleted_at is not null as gone, status from recommendations where id = $1`,
        [posted.drv.json.id])).rows[0]);

    // ---------------- nothing extra reached a client ----------------
    phase("leak scan");
    const LEAKS = ["syntax error at or near", "duplicate key value violates", "insert into",
      "node_modules", "refresh_token_hash", "password_hash", "encrypted_phone",
      "encrypted_nida", "search_hash", "totp_secret", "$2b$"];
    const hit = LEAKS.filter(m => bodies.some(b => b.toLowerCase().includes(m.toLowerCase())));
    check("no engine string, hash column or credential word ever reached a client",
      hit.length === 0, hit);
    const blob = bodies.join("\n");
    check("the inbox never carries a phone number, an identity number or a credential",
      !/national_id|"nida"/i.test(blob) && !/phone_hash/i.test(blob));

    // ---------------- the record ----------------
    phase("what was written down");
    const acts = (await oi(
      `select action, count(*)::int as n from audit_logs
        where entity = 'recommendations' and ts > now() - interval '10 minutes'
        group by action`)).rows;
    const byAct = (a: string) => acts.find(r => r.action === a)?.n ?? 0;
    check("every send is on the record with the author's name on it",
      byAct("recommendation.submitted") >= 12, acts);
    check("…every withdrawal, so a note that came back can be told apart from one never sent",
      byAct("recommendation.withdrawn") >= 1, acts);
    check("…and every decision the desk made, with the seat that made it",
      byAct("control.recommendation.decided") >= 3, acts);
  } finally {
    phase("teardown");
    const tids = [TC, CO, SK];
    const uids = Object.values(ids);
    await oi(`delete from recommendations where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from rate_limits where bucket like 'recommendations:uid:%'`);
    await oi(`delete from users where id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from tenants where id = any($1::uuid[])`, [tids]).catch(() => { });
    // The audit rows stay: 001's `audit_no_mutation` trigger refuses a DELETE on purpose,
    // and the record of what the desk decided is exactly the thing it exists to keep.
    const residue = (await oi(
      `select (select count(*)::int from recommendations where tenant_id = any($1::uuid[])) as notes,
              (select count(*)::int from users where email like $2) as seats,
              (select count(*)::int from tenants where name like $3) as tenants,
              (select count(*)::int from rate_limits where bucket like 'recommendations:uid:%') as buckets`,
      [tids, EMAIL_SWEEP, TENANT_SWEEP])).rows[0];
    check("nothing this run made is left on the live database",
      Object.values(residue).every(v => Number(v) === 0), residue);
    await owner.end();
  }

  console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
