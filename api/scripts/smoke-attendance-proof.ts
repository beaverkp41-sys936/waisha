/**
 * The staff's own confirmation over HTTP — smoke for #182 (migration 107,
 * api/src/routes/attendance.routes.ts, api/src/util/geo-proof.ts).
 *
 * verify-attendance-proof.ts proves the schema keeps its promises. Only the wire can show the
 * promises that live between the route and the register:
 *
 *  1. a confirmation is the caller's own day. The body is allowed to name another employee —
 *     the route has to ignore it, because "I was at work" is not a statement anybody can make
 *     for someone else, and a register that took one would be a timesheet any desk could fill;
 *  2. the position that lands is coarse. The device sends six decimals and the column keeps
 *     three, and the person has to see the same number the office will store;
 *  3. the coordinates leave the API in exactly two places — the reply to the person who sent
 *     them and GET /attendance/:id/proof — and in neither the day register nor the today board,
 *     because a register that printed where everybody was would turn a defence against a missed
 *     timesheet into a tracking system;
 *  4. the photograph is filed as a document of this company and this person, behind the size,
 *     emptiness and magic-byte gates, with the metadata read *before* the file part;
 *  5. the office's own finding about a day (absent, on leave, a holiday) outranks a picture,
 *     and it says so instead of silently overwriting;
 *  6. opening a proof is written down, and a foreign company's day id answers 404.
 *
 * Everything here is this run's own fixture: two companies, seven seats, six staff records, all
 * swept by tenant id at the end. No real company's register is touched, and `audit_logs` is
 * never deleted — the rows this run writes stay inside the fixture tenants on purpose.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-attendance-proof.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const MARK = `ap${STAMP}`;
const TENANT_SWEEP = "Proof Smoke %";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }
const code = (j: any) => j?.error?.code ?? j?.code;
const field = (j: any) => (j?.error?.details ?? []).map((d: any) => d.field);

async function call(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}
const post = (t: string | null, body: any) =>
  call("/attendance/confirm", t, { method: "POST", body: JSON.stringify(body) });
const multipart = (t: string | null, fd: FormData) =>
  call("/attendance/confirm", t, { method: "POST", body: fd });

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
/** Real PDF bytes wearing a .png name — the magic bytes are what decide. */
const FAKE_PNG = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 7)]);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = iso(new Date());

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const roles = (await oi(
    `select id, key from roles where tenant_id is null
      and key = any($1)`, [["hr_officer", "dispatcher", "general_manager", "shipper", "director"]]
  )).rows;
  const rid = (k: string) => roles.find((r: any) => r.key === k)?.id;
  for (const k of ["hr_officer", "dispatcher", "general_manager", "shipper"])
    if (!rid(k)) throw new Error(`the seeded role ${k} is missing`);

  // ---------------- fixtures ----------------
  const FA = randomUUID();   // the company the staff sign in to
  const FB = randomUUID();   // a second company, to prove a foreign day id is nobody's business
  const S = {
    hr: randomUUID(),        // hr_officer + staff record: the desk that also states a day
    self: randomUUID(),      // hr_officer? no — dispatcher, own staff record E1
    peer: randomUUID(),      // dispatcher, E2 — opens proofs, confirms with a photograph
    unlinked: randomUUID(),  // general_manager with no staff record behind it
    shipper: randomUUID(),   // a seat that holds neither key
    left: randomUUID(),      // dispatcher whose staff record has left the company
    away: randomUUID(),      // general_manager whose day the office stated as absent
    other: randomUUID(),     // FB's director, with a staff record of FB's own
    late: randomUUID()       // dispatcher whose form puts the metadata after the picture
  };
  const E = {
    one: randomUUID(), two: randomUUID(), left: randomUUID(),
    away: randomUUID(), other: randomUUID(), late: randomUUID()
  };

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const all = [...new Set(tids)];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
    }
    // The register itself is soft-deleted by the routes, but a smoke leaves no rows behind.
    await oi(`delete from employee_attendance where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from leave_requests where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from office_settings where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from documents where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from employees where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await oi(`delete from rate_limits where bucket like 'attendance-confirm%'`);

  await oi(`insert into tenants (id, type, name, status) values
      ($1,'transporter',$2,'active'), ($3,'transporter',$4,'active')`,
    [FA, `Proof Smoke Cargo ${STAMP}`, FB, `Proof Smoke Haulage ${STAMP}`]);
  const seat = (id: string, tenant: string, type: string, name: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled)
        values ($1,$2,$3,$4,$5,'active',false)`,
      [id, tenant, type, name, `smoke.proof.${name.toLowerCase()}.${STAMP}@waisha.test`]);
  // user_type is the account's kind, not its duties — those come from user_roles below. The
  // column carries a CHECK, so a seat cannot be minted as "hr" or "manager".
  await seat(S.hr, FA, "staff", "Hesham Officer");
  await seat(S.self, FA, "staff", "Zawadi Clerk");
  await seat(S.peer, FA, "staff", "Baraka Dispatcher");
  await seat(S.unlinked, FA, "staff", "Neema Empty");
  await seat(S.shipper, FA, "shipper", "Siti Shipper");
  await seat(S.left, FA, "staff", "Amani Departed");
  await seat(S.away, FA, "staff", "Juma Absent");
  await seat(S.other, FB, "director", "Rashid Otherco");
  await seat(S.late, FA, "staff", "Halima Order");

  await oi("insert into user_roles (user_id, role_id) values ($1,$2)", [S.hr, rid("hr_officer")]);
  await oi("insert into user_roles (user_id, role_id) values ($1,$2)", [S.self, rid("dispatcher")]);
  await oi("insert into user_roles (user_id, role_id) values ($1,$2)", [S.peer, rid("dispatcher")]);
  await oi("insert into user_roles (user_id, role_id) values ($1,$2)",
    [S.unlinked, rid("general_manager")]);
  await oi("insert into user_roles (user_id, role_id) values ($1,$2)", [S.shipper, rid("shipper")]);
  await oi("insert into user_roles (user_id, role_id) values ($1,$2)", [S.left, rid("dispatcher")]);
  await oi("insert into user_roles (user_id, role_id) values ($1,$2)",
    [S.away, rid("general_manager")]);
  await oi("insert into user_roles (user_id, role_id) values ($1,$2)", [S.other, rid("director")]);
  await oi("insert into user_roles (user_id, role_id) values ($1,$2)", [S.late, rid("dispatcher")]);

  const staff = (id: string, tenant: string, name: string, userId: string | null,
    status = "active") =>
    oi(`insert into employees (id, tenant_id, full_name, job_title, status, user_id,
          employment_type, created_by, updated_by)
        values ($1,$2,$3,'Clerk',$4,$5,'permanent',$6,$6)`,
      [id, tenant, name, status, userId, S.hr]);
  await staff(E.one, FA, "Zawadi Clerk", S.self);
  await staff(E.two, FA, "Baraka Dispatcher", S.peer);
  await staff(E.left, FA, "Amani Departed", S.left, "left");
  await staff(E.away, FA, "Juma Absent", S.away);
  await staff(E.other, FB, "Rashid Otherco", S.other);
  await staff(E.late, FA, "Halima Order", S.late);

  const mint = async (sub: string, tid: string, typ: string, keys: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ, roles: keys })
      .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
      .setIssuedAt().setExpirationTime("15m").sign(key);
  const T = {
    hr: await mint(S.hr, FA, "hr", ["hr_officer"]),
    self: await mint(S.self, FA, "staff", ["dispatcher"]),
    peer: await mint(S.peer, FA, "staff", ["dispatcher"]),
    unlinked: await mint(S.unlinked, FA, "manager", ["general_manager"]),
    shipper: await mint(S.shipper, FA, "shipper", ["shipper"]),
    left: await mint(S.left, FA, "staff", ["dispatcher"]),
    away: await mint(S.away, FA, "manager", ["general_manager"]),
    other: await mint(S.other, FB, "director", ["director"]),
    late: await mint(S.late, FA, "staff", ["dispatcher"])
  };

  const dayRow = (employee: string, date = today) => oi(
    `select id, work_date::text as work_date, day_status, clock_in, note, confirmed_at,
            confirmed_by, proof_kind, proof_lat, proof_lng, proof_accuracy_m,
            proof_document_id, tenant_id
       from employee_attendance
      where tenant_id = $1 and employee_id = $2 and work_date = $3::date
        and deleted_at is null`, [FA, employee, date]);
  const FINE = { lat: -6.7923815, lng: 39.2833334 };

  try {
    // ---------------- the door ----------------
    phase("the door: the duty key, and whose day it is");
    check("no token, no confirmation", (await post(null, { proof: "location" })).status === 401);
    const gated = await post(T.shipper, { proof: "location", ...FINE, accuracyM: 30 });
    check("a seat without attendance.clock is refused before the proof is even read",
      gated.status === 403, { status: gated.status, code: code(gated.json) });
    const unsigned = await mint(randomUUID(), FA, "staff", ["dispatcher"]);
    check("a token for a seat that does not exist holds no duty",
      (await post(unsigned, { proof: "location", ...FINE })).status === 403);
    const noLink = await post(T.unlinked, { proof: "location", ...FINE, accuracyM: 30 });
    check("a sign-in with no staff record behind it is told what the office has to do",
      noLink.status === 400 && /linked to a staff record/.test(noLink.json?.error?.message ?? ""),
      { status: noLink.status, message: noLink.json?.error?.message });
    const staffGone = await post(T.left, { proof: "location", ...FINE, accuracyM: 30 });
    check("…and a person who has left the company cannot confirm a day either",
      staffGone.status === 409 && /not an active member/.test(staffGone.json?.error?.message ?? ""),
      { status: staffGone.status, message: staffGone.json?.error?.message });

    // ---------------- the location path ----------------
    phase("confirming with the device's position");
    const named = await post(T.self, {
      proof: "location", lat: FINE.lat, lng: FINE.lng, accuracyM: 35, employeeId: E.two
    });
    check("the day is confirmed, and the reply carries the coarse pair back to its own author",
      named.status === 201 && String(named.json?.proof_lat) === "-6.792"
      && String(named.json?.proof_lng) === "39.283"
      && named.json?.coarse_by === "about 100 m" && named.json?.proof_kind === "location",
      { status: named.status, lat: named.json?.proof_lat, lng: named.json?.proof_lng });
    const own = await dayRow(E.one);
    const peerRow = await dayRow(E.two);
    check("…and the body's employeeId is ignored: the day that was written is the caller's own",
      own.rowCount === 1 && String(own.rows[0].confirmed_by) === S.self
      && peerRow.rowCount === 0, { mine: own.rows[0]?.confirmed_by, theirs: peerRow.rowCount });
    check("…stored at three decimals, not the seven the phone sent",
      n(own.rows[0].proof_lat) === -6.792 && n(own.rows[0].proof_lng) === 39.283,
      { lat: String(own.rows[0].proof_lat), lng: String(own.rows[0].proof_lng) });
    check("…with the clock the server set and the note the self-clock-in path uses",
      !!own.rows[0].clock_in && own.rows[0].note === "Self clock-in"
      && ["present", "late"].includes(own.rows[0].day_status), own.rows[0]);
    const again = await post(T.self, { proof: "location", ...FINE });
    check("a second confirmation of the same day is refused, not overwritten",
      again.status === 409 && /already confirmed/.test(again.json?.error?.message ?? ""),
      { status: again.status, message: again.json?.error?.message });

    const audit = (await oi(
      `select action, "after" from audit_logs
        where tenant_id = $1 and entity = 'employee_attendance' and action = 'attendance.confirmed'
        order by ts desc limit 1`, [FA])).rows[0];
    check("the audit line records the confirmation and its kind",
      !!audit && audit.action === "attendance.confirmed"
      && audit.after?.employeeId === E.one && audit.after?.proof === "location", audit?.after);
    check("…and carries no coordinates: the trail says a position was given, not where",
      audit && !("proof_lat" in (audit.after ?? {})) && !("lat" in (audit.after ?? {}))
      && !("lng" in (audit.after ?? {})), audit?.after);

    // ---------------- the register never prints a position ----------------
    phase("the reads: who sees the coordinates");
    const board = await call("/attendance/today", T.hr);
    check("the today board shows the desk that the day was confirmed, and nothing about where",
      board.status === 200 && JSON.stringify(board.json).includes('"proof_kind"')
      && !JSON.stringify(board.json).includes("proof_lat"),
      { hasKind: JSON.stringify(board.json).includes("proof_kind") });
    const lines = await call(`/attendance?from=${today}&to=${today}`, T.hr);
    check("…nor does the register itself",
      lines.status === 200 && !JSON.stringify(lines.json).includes("proof_lat")
      && !JSON.stringify(lines.json).includes("6.792"),
      JSON.stringify(lines.json).slice(0, 300));
    const me = await call("/attendance/me", T.self);
    check("the person who sent it does read their own position back",
      me.status === 200 && JSON.stringify(me.json).includes("-6.792"),
      { keys: Object.keys(me.json?.days?.[0] ?? me.json?.lines?.[0] ?? {}) });

    const id = own.rows[0].id as string;
    const proof = await call(`/attendance/${id}/proof`, T.peer);
    check("a desk seat with attendance.view opens the proof, coarse and captioned",
      proof.status === 200 && proof.json?.proofKind === "location"
      && String(proof.json?.lat) === "-6.792" && proof.json?.keptTo === "about 100 m"
      && proof.json?.employee?.fullName === "Zawadi Clerk", proof.json);
    check("…and it names the seat that confirmed, so the register can be questioned",
      proof.json?.confirmedBy === S.self && !!proof.json?.confirmedAt, proof.json);
    const viewed = (await oi(
      `select actor_user_id, "after" from audit_logs
        where tenant_id = $1 and entity = 'employee_attendance'
          and action = 'attendance.proof_viewed' order by ts desc limit 1`, [FA])).rows[0];
    check("opening a proof is written in the company's book, with who looked",
      !!viewed && String(viewed.actor_user_id) === S.peer
      && viewed.after?.employeeId === E.one && !("lat" in (viewed.after ?? {})), viewed?.after);
    const foreign = await call(`/attendance/${id}/proof`, T.other);
    check("a foreign company holding the same duty gets 404, not the other firm's evidence",
      foreign.status === 404, { status: foreign.status, code: code(foreign.json) });
    const noDuty = await call(`/attendance/${id}/proof`, T.shipper);
    check("…and a seat without attendance.view never reaches it", noDuty.status === 403,
      { status: noDuty.status });

    // ---------------- the refusals a device can produce ----------------
    phase("the proof itself has to be usable");
    const shapes: [string, any, string, number][] = [
      ["no kind at all", { lat: FINE.lat, lng: FINE.lng }, "proof", 400],
      ["a kind nobody recognised", { proof: "gps", lat: FINE.lat, lng: FINE.lng }, "proof", 400],
      ["an empty kind", { proof: "", lat: FINE.lat }, "proof", 400],
      ["a position with no latitude", { proof: "location", lng: FINE.lng }, "lat", 400],
      ["a latitude off the planet", { proof: "location", lat: 91, lng: FINE.lng }, "lat", 400],
      ["a device that found nothing", { proof: "location", lat: 0, lng: 0 }, "location-has-no-position", 400],
      ["words where a coordinate should be", { proof: "location", lat: "not a number", lng: FINE.lng }, "lat", 400],
      ["an accuracy wider than the atmosphere", { proof: "location", ...FINE, accuracyM: 20001 }, "accuracyM", 400],
      ["a photograph with a position beside it", { proof: "photo", lat: FINE.lat, lng: FINE.lng }, "photo-has-coordinates", 400],
      ["a photograph with no picture", { proof: "photo" }, "file", 400]
    ];
    for (const [what, body, expectField, status] of shapes) {
      const r = await post(T.peer, body);
      check(`a confirmation of ${what} is refused with the field named`,
        r.status === status && field(r.json).includes(expectField),
        { status: r.status, fields: field(r.json), message: r.json?.error?.message });
    }

    // ---------------- the photograph ----------------
    phase("confirming with a photograph, through the vault");
    // Each refusal below is answered before the day is looked at, so they have to run first.
    // Once a photograph lands the day is closed, and the next attempt is refused for being a
    // second attempt rather than for the thing the check was testing.
    const wrongName = await multipart(T.peer, (() => {
      const fd = new FormData();
      fd.append("proof", "photo");
      fd.append("file", new Blob([FAKE_PNG], { type: "image/png" }), "invoice.png");
      return fd;
    })());
    check("a PDF wearing a .png name is refused by its bytes, not its extension",
      wrongName.status === 400 && /not the image its name claims/
        .test(wrongName.json?.error?.message ?? ""),
      { status: wrongName.status, message: wrongName.json?.error?.message });
    const notAnImage = await multipart(T.peer, (() => {
      const fd = new FormData();
      fd.append("proof", "photo");
      fd.append("file", new Blob(["GIF89a"], { type: "image/gif" }), "clip.gif");
      return fd;
    })());
    check("a format the confirmation does not accept is refused before it is stored",
      notAnImage.status === 400 && /JPEG, PNG or WebP/.test(notAnImage.json?.error?.message ?? ""),
      { status: notAnImage.status, message: notAnImage.json?.error?.message });
    const empty = await multipart(T.peer, (() => {
      const fd = new FormData();
      fd.append("proof", "photo");
      fd.append("file", new Blob([], { type: "image/png" }), "empty.png");
      return fd;
    })());
    check("an empty file is refused rather than filed as somebody's evidence",
      empty.status === 400 && /empty/.test(empty.json?.error?.message ?? ""),
      { status: empty.status, message: empty.json?.error?.message });
    const tooBig = await multipart(T.peer, (() => {
      const fd = new FormData();
      fd.append("proof", "photo");
      fd.append("file", new Blob([new Uint8Array(9 * 1024 * 1024)], { type: "image/png" }), "big.png");
      return fd;
    })());
    check("nine megabytes is refused with a size in the sentence",
      tooBig.status === 400 && /8 MB/.test(tooBig.json?.error?.message ?? "")
      && field(tooBig.json).includes("file"),
      { status: tooBig.status, message: tooBig.json?.error?.message });
    const fileWithPosition = await multipart(T.peer, (() => {
      const fd = new FormData();
      fd.append("proof", "location");
      fd.append("lat", String(FINE.lat));
      fd.append("lng", String(FINE.lng));
      fd.append("file", new Blob([PNG_1PX], { type: "image/png" }), "extra.png");
      return fd;
    })());
    check("a picture sent beside a location is refused rather than stored as a second story",
      fileWithPosition.status === 400 && /carries no file/
        .test(fileWithPosition.json?.error?.message ?? ""),
      { status: fileWithPosition.status, message: fileWithPosition.json?.error?.message });

    // The column may hold the kind (107) but the vault's own allowlist must not, or a desk could
    // file an "attendance proof" that was never attached to anybody's day. This is sent by the
    // only seat on either company that holds documents.create — from one that does not, the door
    // answers 403 and the allowlist is never reached, so nothing would have been proved.
    const throughTheVault = await call("/documents", T.other, {
      method: "POST",
      body: (() => {
        const fd = new FormData();
        fd.append("entityType", "employee");
        fd.append("entityId", E.other);
        fd.append("kind", "attendance_proof");
        fd.append("file", new Blob([PNG_1PX], { type: "image/png" }), "alibi.png");
        return fd;
      })()
    });
    check("the ordinary vault refuses to file a kind only a confirmation may write",
      throughTheVault.status === 400 && field(throughTheVault.json).includes("kind"),
      { status: throughTheVault.status, fields: field(throughTheVault.json),
        message: throughTheVault.json?.error?.message });
    const alibi = (await oi(
      `select count(*)::int as n from documents where kind = 'attendance_proof' and tenant_id = $1
         and file_name = 'alibi.png'`, [FB])).rows[0];
    check("…and nothing was filed on the way out", n(alibi.n) === 0, alibi);

    const photo = await multipart(T.peer, (() => {
      const fd = new FormData();
      fd.append("proof", "photo");
      fd.append("file", new Blob([PNG_1PX], { type: "image/png" }), "mzuiki.png");
      return fd;
    })());
    if (photo.status === 503)
      console.log("note  this API has no file store configured, so the photograph half below has",
        "nothing to read back — the refusals above still ran.");
    check("a photograph confirms the day, and no coordinate is invented beside it",
      photo.status === 201 && photo.json?.proof_kind === "photo"
      && photo.json?.proof_lat === null && photo.json?.proof_lng === null
      && !!photo.json?.proof_document_id,
      { status: photo.status, message: photo.json?.error?.message ?? photo.json?.code });
    const prow = (await dayRow(E.two)).rows[0] ?? {};
    const doc = (await oi(
      `select id, tenant_id, entity_type, entity_id, kind, file_name, mime_type, size_bytes,
              storage_path
         from documents where id = $1`, [prow.proof_document_id ?? randomUUID()])).rows[0];
    check("…the picture is filed as this company's document of this person's record",
      prow.proof_kind === "photo" && !!doc && doc.tenant_id === FA
      && doc.entity_type === "employee" && doc.entity_id === E.two
      && doc.kind === "attendance_proof" && Number(doc.size_bytes) === PNG_1PX.length, doc);
    check("…under a path inside the tenant's own prefix, and its numbers left null",
      String(doc?.storage_path ?? "").startsWith(`${FA}/employee/${E.two}/`)
      && prow.proof_lat === null && prow.proof_accuracy_m === null,
      { path: doc?.storage_path, lat: prow.proof_lat });
    const photoProof = await call(`/attendance/${prow.id}/proof`, T.hr);
    check("…and opening it hands back a signed link, not the bytes or a public path",
      photoProof.status === 200 && photoProof.json?.proofKind === "photo"
      && /^https?:\/\//.test(photoProof.json?.document?.url ?? "")
      && photoProof.json?.lat === null && photoProof.json?.document?.mimeType === "image/png",
      { status: photoProof.status, url: photoProof.json?.document?.url?.slice(0, 80) });
    const fetched = photoProof.json?.document?.url
      ? await fetch(photoProof.json.document.url) : { status: 0 };
    check("…the link opens for the desk that asked, while it stands",
      fetched.status === 200, { status: fetched.status });

    // The page appends its metadata before the picture, but that order is the client's choice,
    // not the register's. The body is drained before it is read, so a form that named its proof
    // after the file is understood as the story it told — not answered by whichever chunk of it
    // happened to arrive first.
    const lateOrder = await multipart(T.late, (() => {
      const fd = new FormData();
      fd.append("file", new Blob([PNG_1PX], { type: "image/png" }), "late.png");
      fd.append("proof", "photo");
      return fd;
    })());
    check("a form that named its proof after the picture is still read as a photograph",
      lateOrder.status === 201 && lateOrder.json?.proof_kind === "photo"
      && lateOrder.json?.proof_lat === null,
      { status: lateOrder.status, message: lateOrder.json?.error?.message });
    const lateRow = (await dayRow(E.late)).rows[0] ?? {};
    const latePath = (await oi(`select storage_path from documents where id = $1`,
      [lateRow.proof_document_id ?? randomUUID()])).rows[0]?.storage_path ?? "";
    check("…landed on this person's own day, filed under this person's own prefix",
      lateRow.proof_kind === "photo" && String(lateRow.confirmed_by) === S.late
      && String(lateRow.proof_document_id) === String(lateOrder.json?.proof_document_id)
      && String(latePath).startsWith(`${FA}/employee/${E.late}/`)
      && lateRow.proof_lat === null,
      { day: lateRow.id, by: lateRow.confirmed_by, path: latePath });

    // ---------------- the office's finding outranks a picture ----------------
    phase("the office has already stated the day");
    const statedDay = await call("/attendance/day", T.hr, {
      method: "POST",
      body: JSON.stringify({ employeeId: E.away, workDate: today, dayStatus: "absent",
        note: "Sick, reported by the supervisor" })
    });
    check("the desk states an absence for a person with no clock at all",
      statedDay.status === 200 || statedDay.status === 201,
      { status: statedDay.status, message: statedDay.json?.error?.message });
    const fight = await post(T.away, { proof: "location", ...FINE, accuracyM: 20 });
    check("…and the person's own confirmation of that day is refused, with the finding named",
      fight.status === 409 && /already stated this day as absent/.test(fight.json?.error?.message ?? ""),
      { status: fight.status, message: fight.json?.error?.message });
    const still = await dayRow(E.away);
    check("…the stated day is left exactly as the office wrote it",
      still.rowCount === 1 && still.rows[0].day_status === "absent"
      && still.rows[0].confirmed_at === null && still.rows[0].proof_kind === null, still.rows[0]);
    const noProofYet = await call(`/attendance/${still.rows[0].id}/proof`, T.hr);
    check("opening the proof of a day that was recorded without one is a refusal, not an empty panel",
      noProofYet.status === 409 && /without a confirmation/
        .test(noProofYet.json?.error?.message ?? ""),
      { status: noProofYet.status, message: noProofYet.json?.error?.message });

    // A seat has now pressed the button sixteen times. Its hour is not up, and the next
    // phases still have work for it, so the counter is reset rather than left to run out.
    await oi(`delete from rate_limits where bucket like 'attendance-confirm%'`);

    // ---------------- the other company's own loop ----------------
    phase("the same desk in another company");
    const overThere = await post(T.other, { proof: "location", ...FINE, accuracyM: 40 });
    check("a second company confirms its own day and the position lands in its own rows",
      overThere.status === 201, { status: overThere.status, message: overThere.json?.error?.message });
    const bound = (await oi(
      `select tenant_id, employee_id, proof_lat from employee_attendance
        where tenant_id = $1 and employee_id = $2 and work_date = $3::date and deleted_at is null`,
      [FB, E.other, today])).rows[0];
    check("…written for its own tenant and its own staff record, at three decimals",
      bound?.tenant_id === FB && bound?.employee_id === E.other
      && n(bound?.proof_lat) === -6.792, bound);
    const hereToo = (await oi(
      `select count(*)::int as n from employee_attendance
        where tenant_id = $1 and confirmed_at is not null`, [FA])).rows[0];
    check("…and the first company's register still holds exactly its own three confirmations",
      n(hereToo.n) === 3, hereToo);
    const otherBoard = await call("/attendance/today", T.other);
    check("…which is where the second company's own board stops",
      otherBoard.status === 200 && !JSON.stringify(otherBoard.json).includes("proof_lat"),
      JSON.stringify(otherBoard.json).slice(0, 200));

    // ---------------- the limiter ----------------
    phase("the limiter that stops a day being farmed");
    let last = 0;
    for (let i = 0; i < 24; i++) {
      const r = await post(T.unlinked, { proof: "location", ...FINE });
      last = r.status;
      if (r.status === 429) break;
    }
    check("a seat that keeps pressing the button is eventually told to wait",
      last === 429, { last });
    await oi(`delete from rate_limits where bucket like 'attendance-confirm%'`);
  } finally {
    // ---------------- teardown ----------------
    await oi(`delete from rate_limits where bucket like 'attendance-confirm%'`);
    await sweep();
    const left = (await oi(
      `select (select count(*) from tenants where name like $1) as tenants,
              (select count(*) from users u where u.tenant_id in
                 (select id from tenants where name like $1)) as seats,
              (select count(*) from employee_attendance a where a.tenant_id in
                 (select id from tenants where name like $1)) as days,
              (select count(*) from documents d where d.tenant_id in
                 (select id from tenants where name like $1)) as files,
              (select count(*) from employees e where e.tenant_id in
                 (select id from tenants where name like $1)) as staff`,
      [TENANT_SWEEP])).rows[0];
    console.log("\nteardown:", left);
    check("every fixture row this smoke wrote is gone",
      Object.values(left).every((v) => Number(v) === 0), left);
    await owner.end().catch(() => { });
  }

  console.log(`\n${failures ? "FAILED" : "PASS"} — ${failures} failures`);
  if (failures) process.exitCode = 1;
}

function n(v: any) { return v === null || v === undefined ? NaN : Number(v); }

main().catch((e) => {
  console.error("smoke crashed:", String(e?.message ?? e).slice(0, 600));
  process.exitCode = 1;
});
