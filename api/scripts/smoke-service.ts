/**
 * The Service desk over HTTP — smoke for #341 (migration 126, api/src/routes/control-service.routes.ts,
 * api/src/control/approvals.ts).
 *
 * verify-service-sql.ts proves the registers: the numbering, the six check keys, the guard that
 * refuses a finding with nothing filed on it, the figure that has to be one sentence with its own
 * paper. This proves the parts only the wire can show — that a duty the seat does not hold answers
 * 403 rather than a quiet empty list, that a guard exception reaches the desk in the trigger's own
 * words as a 409, that a photograph filed on a dispute is readable back through the API and by
 * nobody else's tenant, that the money path stops at the desk that raised it and is finished only
 * by a second seat on the approvals board, and that none of the four CSV exports carries the
 * caller's phone.
 *
 * The fixtures are this run's own: two platform desks (the office under test and a foreign one, to
 * show the reads are bound), one company, the seats inside them, one department and three calls.
 * Everything is swept by tenant id at the end. `audit_logs` is never deleted — the guard refuses it
 * for the owner too — so this run's service lines stay in the fixture tenants on purpose, exactly
 * as every earlier smoke leaves its own. The uploaded papers are taken out of the bucket, because
 * unlike the audit they are ours to delete.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-service.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";
import { env } from "../src/env.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const MARK = `sv${STAMP}`;
const TENANT_SWEEP = "Service Smoke %";
const EMAIL_SWEEP = `smoke.service.%@waisha.test`;
const PHONE = `+2557${STAMP}11`;
// A real 1×1 PNG: the route sniffs the bytes, so a file that only claims to be an image is refused.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64");

let failures = 0;
let proved = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++; else proved++;
}
function note(line: string) { console.log(`note   ${line}`); }
function phase(name: string) { console.log(`\n--- ${name} ---`); }

async function call(path: string, opts: {
  ck?: string; method?: string; body?: any; form?: { body: Buffer; type: string }; headers?: Record<string, string>
} = {}) {
  const method = opts.method ?? (opts.body === undefined && !opts.form ? "GET" : "POST");
  const res = await fetch(`${API}${path}`, {
    method,
    ...(opts.form ? { body: opts.form.body as unknown as BodyInit }
      : opts.body === undefined ? {} : {
        body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)
      }),
    headers: {
      ...(opts.form ? { "Content-Type": opts.form.type }
        : opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(opts.ck ? { Cookie: opts.ck } : {}),
      ...(opts.headers ?? {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* csv, bytes, or an empty body */ }
  return { status: res.status, json, text, headers: res.headers };
}

/**
 * A multipart body written by hand. Node's fetch streams a FormData it built itself and the
 * keep-alive socket desyncs behind it — the next request arrives with a Content-Length the
 * server never saw the whole body for. Buffer.concat gives one exact length, and the fields are
 * put in front of the file part, which is the only order `req.file()` reads them in.
 */
function form(fields: Record<string, string>, file?: {
  field: string; name: string; type: string; bytes: Buffer; omit?: boolean
}) {
  const boundary = `qoderwaisha${MARK}`;
  const chunks = Object.entries(fields)
    .map(([k, v]) => Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, "utf8"));
  if (file && !file.omit) {
    chunks.push(Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; `
        + `filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`, "utf8"),
      file.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
    ]));
  } else if (file) {
    chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  }
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}
const code = (j: any) => j?.error?.code ?? j?.code;
/** The sentence a 126 guard threw through 409 — the route passes the trigger's own words. */
const msg = (j: any) => String(j?.error?.message ?? j?.message ?? "");

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const one = async (sql: string, params: any[] = []) => (await oi(sql, params)).rows[0];

  const roleIds = (await oi(
    `select id, key from roles where tenant_id is null
      and key = any($1)`,
    [["super_admin", "compliance_officer", "support_engineer", "customer_service_agent",
      "platform_analyst", "billing_admin", "director"]]
  )).rows;
  const rid = (k: string) => roleIds.find((r: any) => r.key === k)?.id;
  for (const k of ["super_admin", "compliance_officer", "support_engineer",
    "customer_service_agent", "platform_analyst", "billing_admin"]) {
    if (!rid(k)) throw new Error(`the global role ${k} this desk depends on is missing`);
  }

  // ---------------- fixtures ----------------
  const TC = randomUUID();      // the service office under test (a platform desk)
  const TB = randomUUID();      // a foreign platform desk: an empty register of its own
  const CO = randomUUID();      // the company the calls are about

  const uSA = randomUUID();     // super_admin: opens papers, asks for a signature, voids
  const uCO = randomUUID();     // compliance_officer: the second seat that signs
  const uSE = randomUUID();     // support_engineer: manages, holds no money duty, marks nothing
  const uCS = randomUUID();     // customer_service_agent: grades a colleague's call
  const uPA = randomUUID();     // platform_analyst: reads, changes nothing
  const uBA = randomUUID();     // billing_admin: holds none of this desk's duties
  const uFor = randomUUID();    // super_admin of the other desk
  const uDir = randomUUID();    // a company seat: 099 turns it away from a control desk

  const ck = (who: string) => `waisha_control=sv-smoke-${who}-${MARK}`;
  const uploaded: string[] = [];

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    if (uids.length) {
      await oi(`select coalesce(array_agg(storage_path), '{}') as p from documents
                 where tenant_id = any($1::uuid[]) and entity_type = 'service_dispute'`, [all])
        .then((r) => (r.rows[0]?.p ?? []).forEach((p: string) => uploaded.includes(p) || uploaded.push(p)));
      await oi(`delete from service_quality_reviews where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from service_satisfaction where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from service_dispute_events where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from documents
                 where tenant_id = any($1::uuid[]) and entity_type = 'service_dispute'`, [all]);
      // Read the signature ids before the papers go: `service_refund_requests.approval_id` points
      // at `platform_approvals`, so the approvals cannot be dropped while the paper still names
      // them — and once the paper is gone the join that found the approval is gone with it.
      const apIds = (await oi(
        `select a.id from platform_approvals a
           join service_refund_requests r on r.id::text = a.target_id
          where a.target_kind = 'refund_request' and r.tenant_id = any($1::uuid[])`, [all]))
        .rows.map((r: any) => r.id);
      // The paper goes before the dispute it stands on: `service_disputes.refund_request_id` is
      // `on delete set null`, but the paper's own `dispute_id` is a plain foreign key.
      await oi(`delete from service_refund_requests where tenant_id = any($1::uuid[])`, [all]);
      if (apIds.length) {
        await oi(`delete from platform_approvals where id = any($1::uuid[])`, [apIds]);
      }
      await oi(`delete from service_disputes where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from support_ticket_events where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from support_tickets where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from app_errors where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      // Handing a call to a desk writes the seat's move into 084's register, and that row names
      // the user, so it goes before the seats themselves.
      await oi(`delete from platform_duty_transitions where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where actor_user_id = any($1::uuid[])`, [uids]);
    }
    await oi(`delete from platform_departments where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await oi(`delete from rate_limits where bucket like 'service-%' or bucket like 'approvals-%'
              or bucket like 'tickets-write%' or bucket like 'dept-write%'`);

  await oi(`insert into tenants (id, type, name, status) values
      ($1,'platform',$2,'active'), ($3,'platform',$4,'active'), ($5,'transporter',$6,'active')`,
    [TC, `Service Smoke Office ${STAMP}`, TB, `Service Smoke Foreign ${STAMP}`,
      CO, "Service Smoke Cargo Ltd"]);

  const seat = async (id: string, tenant: string, name: string, roleKey: string) => {
    await oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
            last_login_at, created_at)
          values ($1,$2,'platform',$3,$4,'active',false, now() - interval '3 hours',
            now() - interval '300 days')`,
    [id, tenant, name, `smoke.service.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [id, rid(roleKey)]);
  };
  await seat(uSA, TC, "Amani Super", "super_admin");
  await seat(uCO, TC, "Biweta Second", "compliance_officer");
  await seat(uSE, TC, "Simba Engineer", "support_engineer");
  await seat(uCS, TC, "Callum Agent", "customer_service_agent");
  await seat(uPA, TC, "Nia Analyst", "platform_analyst");
  await seat(uBA, TC, "Bela Billing", "billing_admin");
  await seat(uFor, TB, "Faraji Otherdesk", "super_admin");
  // A company seat, and a control cookie for it: 099 is what turns this away.
  await oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,'director','Daudi Director',$3,'active',false,now(),now())`,
    [uDir, CO, `smoke.service.daudi.${STAMP}@waisha.test`]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uDir, rid("director")]);

  const tok = (who: string) => sha256(`sv-smoke-${who}-${MARK}`);
  for (const [who, user, tenant] of [
    ["sa", uSA, TC], ["co", uCO, TC], ["se", uSE, TC], ["cs", uCS, TC],
    ["pa", uPA, TC], ["ba", uBA, TC], ["for", uFor, TB], ["dir", uDir, CO]
  ] as [string, string, string][]) {
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
            refresh_token_hash, user_agent, ip, expires_at)
          values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-service','127.0.0.1',
            now() + interval '2 hours')`,
      [randomUUID(), user, tenant, randomUUID(), tok(who)]);
  }

  const mint = async (sub: string, tid: string, role: string) =>
    new SignJWT({ tid, sid: randomUUID(), typ: role, roles: [role] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);

  let DEPT = "";
  let call1 = "", call2 = "", call3 = "";
  let ref1 = "", ref2 = "", ref3 = "";
  let d1 = "", d2 = "", d1ref = "", d2ref = "";
  let paper2 = "", paper3 = "";
  let approval1 = "", approval3 = "";
  let mark1 = "", mark2 = "", mark3 = "";
  let csat1 = "", csat2 = "";
  let docA = "", docB = "", docC = "";

  try {
    // ============================================================
    phase("the door: a platform cookie, a duty, and nothing in between");
    check("an anonymous request never reaches the register",
      (await call("/control/service/board")).status === 401);
    const company = await call("/control/service/board", { ck: ck("dir") });
    check("a company seat is refused a control desk outright (099)", company.status === 401, company.text);
    const noDuty = await call("/control/service/board", { ck: ck("ba") });
    check("a platform seat holding none of this desk's duties is a 403, not an empty list",
      noDuty.status === 403 && code(noDuty.json) === "FORBIDDEN", noDuty.text);
    check("a platform seat's own bearer token does not open a control desk: only the cookie does",
      (await fetch(`${API}/control/service/board`, {
        headers: { Authorization: `Bearer ${await mint(uSA, TC, "super_admin")}` }
      })).status === 401);

    const probe = (await call("/control/auth/permissions", { ck: ck("sa") })).json;
    check("the permissions probe lists the three service duties for a super_admin",
      ["control.service.view", "control.service.manage", "control.service.review"]
        .every((k) => (probe?.permissions ?? []).includes(k)), probe?.permissions);
    const paProbe = (await call("/control/auth/permissions", { ck: ck("pa") })).json;
    check("an analyst is given the read and not the write or the mark",
      (paProbe?.permissions ?? []).includes("control.service.view") &&
        !(paProbe?.permissions ?? []).includes("control.service.manage") &&
        !(paProbe?.permissions ?? []).includes("control.service.review"), paProbe?.permissions);
    const coProbe = (await call("/control/auth/permissions", { ck: ck("co") })).json;
    check("the second seat reads, marks, and cannot open a paper",
      (coProbe?.permissions ?? []).includes("control.service.review") &&
        (coProbe?.permissions ?? []).includes("control.approvals.decide") &&
        !(coProbe?.permissions ?? []).includes("control.service.manage"), coProbe?.permissions);
    const seProbe = (await call("/control/auth/permissions", { ck: ck("se") })).json;
    check("the engineer manages papers but holds no money duty and marks nothing",
      (seProbe?.permissions ?? []).includes("control.service.manage") &&
        !(seProbe?.permissions ?? []).includes("control.payments.manage") &&
        !(seProbe?.permissions ?? []).includes("control.service.review"), seProbe?.permissions);

    // ============================================================
    phase("a call is logged, and the desk finds it without a phone number");
    const dept = await call("/control/departments", {
      ck: ck("sa"), body: { key: `svcsmoke${STAMP}`, name: `Service Smoke Desk ${STAMP}`,
        purpose: "The desk this smoke hands its calls to.", sort: 900 }
    });
    DEPT = String(dept.json?.id ?? "");
    check("a fixture desk exists to hold the calls", dept.status === 200 && !!DEPT, dept.text);

    const mkCall = async (subject: string, who = "sa") => {
      const r = await call("/control/tickets", {
        ck: ck(who),
        body: {
          reporterName: "Goya Mkono", reporterPhone: PHONE, channel: "phone_call",
          companyTenantId: CO, category: "complaint", subject,
          body: `A call written only to test the service registers. ${MARK}`,
          priority: "normal", language: "en", departmentId: DEPT,
          reason: "Logged so the service desk has something to stand a paper on."
        }
      });
      return r;
    };
    const c1 = await mkCall("A charge raised twice on one invoice");
    call1 = String(c1.json?.id ?? ""); ref1 = String(c1.json?.ref ?? "");
    const c2 = await mkCall("Nobody told me the desk closes at five");
    call2 = String(c2.json?.id ?? ""); ref2 = String(c2.json?.ref ?? "");
    const c3 = await mkCall("The waybill copy never arrived");
    call3 = String(c3.json?.id ?? ""); ref3 = String(c3.json?.ref ?? "");
    check("three calls are on the register with their own numbers",
      [c1, c2, c3].every((r) => r.status === 201) && /^CS-\d{4}-\d{5,}$/.test(ref1),
      { s: c1.status, ref1, t: c1.text.slice(0, 200) });

    const found = await call(`/control/service/calls?search=${ref1}`, { ck: ck("pa") });
    const row1 = (found.json?.rows ?? [])[0] ?? {};
    check("the picker finds the call by its incidence number",
      found.status === 200 && row1.id === call1, found.text.slice(0, 200));
    check("the company name came off the call, not off a keyboard",
      row1.company_name === "Service Smoke Cargo Ltd", row1.company_name);
    check("and it carries no phone: the service desk reads the incidence, never the number",
      !found.text.includes(PHONE.slice(5)) && !("reporter_phone" in row1), Object.keys(row1));
    const byId = await call(`/control/service/calls?ticket=${call2}`, { ck: ck("pa") });
    check("naming a call reads exactly that call",
      byId.status === 200 && byId.json?.rows?.length === 1 && byId.json.rows[0].id === call2,
      byId.text.slice(0, 160));
    const badCall = await call(`/control/service/calls?ticket=${randomUUID()}`, { ck: ck("pa") });
    check("a call that is not on the register is a 404 on the picker too",
      badCall.status === 404, badCall.text);

    const board0 = await call("/control/service/board", { ck: ck("pa") });
    check("the board answers with all four registers and the money one names its own waiting count",
      board0.status === 200 && "disputes" in (board0.json ?? {}) && "refunds" in (board0.json ?? {})
        && "awaiting_signature" in (board0.json?.refunds ?? {}), Object.keys(board0.json ?? {}));

    // ============================================================
    phase("a dispute opens, and its number is the one a caller can be quoted");
    const badAmount = await call("/control/service/disputes", {
      ck: ck("sa"),
      body: { ticketId: call1, ground: "fee_dispute", claim: "A figure typed with no currency on it.",
        amount: 400000, reason: "Opened to show the two halves of a figure travel together." }
    });
    check("a figure without a currency is refused before the register sees it",
      badAmount.status === 400 && code(badAmount.json) === "VALIDATION_FAILED", badAmount.text);
    check("…and the refusal names the field the desk has to fill",
      JSON.stringify(badAmount.json?.error?.details ?? badAmount.json?.details ?? "").includes("amount"),
      badAmount.text.slice(0, 240));
    const badGround = await call("/control/service/disputes", {
      ck: ck("sa"),
      body: { ticketId: call1, ground: "teleported", claim: "A claim long enough to read.",
        reason: "Opened to show the ground is one of eight words." }
    });
    check("the ground is one of the eight words the office keeps",
      badGround.status === 400, badGround.text);
    const shortClaim = await call("/control/service/disputes", {
      ck: ck("sa"),
      body: { ticketId: call1, ground: "other", claim: "Six chars", reason: "Too short a claim." }
    });
    check("a claim of six characters belongs in the ground, not in the register",
      shortClaim.status === 400, shortClaim.text);
    const noTicket = await call("/control/service/disputes", {
      ck: ck("sa"),
      body: { ticketId: randomUUID(), ground: "other",
        claim: "A claim about a call that does not exist.", reason: "Opened at nothing." }
    });
    check("a dispute cannot be opened about a call that is not on the register",
      noTicket.status === 404, noTicket.text);
    check("an analyst with the read but not the write cannot open one",
      (await call("/control/service/disputes", {
        ck: ck("pa"),
        body: { ticketId: call1, ground: "other", claim: "A claim typed by the wrong seat.",
          reason: "Opened by a seat that should not be able to." }
      })).status === 403);

    const D1 = await call("/control/service/disputes", {
      ck: ck("sa"),
      body: { ticketId: call2, ground: "missed_promise",
        claim: "The desk promised a call back before five and never rang, so the invoice was paid "
          + "twice while the truck sat.",
        reason: "The caller says the promise was missed and wants it on the file." }
    });
    d1 = String(D1.json?.id ?? ""); d1ref = String(D1.json?.ref ?? "");
    check("a dispute with no figure opens: a missed promise has no number on it",
      D1.status === 201 && /^DP-\d{4}-\d{5,}$/.test(d1ref) && D1.json?.amount === null,
      { s: D1.status, ref: d1ref, t: D1.text.slice(0, 220) });
    check("…the incidence number was copied out of the call",
      D1.json?.ticket_ref === ref2, { stored: D1.json?.ticket_ref, call: ref2 });
    check("…and so was the company, which is why a desk cannot type one",
      D1.json?.company_name === "Service Smoke Cargo Ltd" && D1.json?.company_tenant_id === CO,
      { name: D1.json?.company_name, tenant: D1.json?.company_tenant_id });

    const D2 = await call("/control/service/disputes", {
      ck: ck("sa"),
      body: { ticketId: call1, ground: "overcharge",
        claim: "One invoice, two charges: the clearing fee was raised again on the same consignment.",
        amount: 400000, currency: "TZS",
        reason: "The caller names the figure they were charged twice." }
    });
    d2 = String(D2.json?.id ?? ""); d2ref = String(D2.json?.ref ?? "");
    check("a dispute with a figure keeps it exactly, in cents",
      D2.status === 201 && Number(D2.json?.amount) === 400000 && D2.json?.currency === "TZS",
      D2.text.slice(0, 220));

    const list = await call("/control/service/disputes?status=open", { ck: ck("pa") });
    check("the board lists both, newest first, with the counts beside them",
      list.status === 200 && (list.json?.rows ?? []).length === 2 &&
        list.json.rows[0].ref === d2ref && list.json.counts.open === 2,
      { n: list.json?.rows?.length, counts: list.json?.counts });
    check("…and says which of them are still waiting for a paper",
      list.json?.counts?.awaiting_paper === 2 && list.json?.counts?.awaiting_refund === 1,
      list.json?.counts);
    const byGround = await call("/control/service/disputes?ground=overcharge", { ck: ck("pa") });
    check("the ground filter narrows the list to the one argument it names",
      (byGround.json?.rows ?? []).length === 1 && byGround.json.rows[0].ref === d2ref,
      byGround.json?.rows?.length);
    const bySearch = await call(`/control/service/disputes?search=${ref2.slice(3)}`, { ck: ck("pa") });
    check("one search box reads the dispute number, the call it stands on and the company",
      (bySearch.json?.rows ?? []).some((r: any) => r.ref === d1ref), bySearch.json?.rows?.length);

    const detail1 = await call(`/control/service/disputes/${d1}`, { ck: ck("pa") });
    check("the detail opens with the event line the desk wrote on the way in",
      detail1.status === 200 && detail1.json?.events?.length === 1 &&
        detail1.json.events[0].action === "opened" &&
        detail1.json.events[0].reason.includes("on the file"),
      detail1.json?.events);
    check("…named, with the seat who opened it beside it",
      detail1.json?.opened_name === "Amani Super" && detail1.json?.status === "open",
      { name: detail1.json?.opened_name, status: detail1.json?.status });

    // ============================================================
    phase("a finding cannot stand on nothing");
    const moved = await call(`/control/service/disputes/${d1}/status`, {
      ck: ck("sa"), body: { to: "investigating",
        reason: "The desk is asking the branch for the call log." }
    });
    check("a dispute moves to investigating without a finding attached",
      moved.status === 200 && moved.json?.status === "investigating", moved.text);
    const again = await call(`/control/service/disputes/${d1}/status`, {
      ck: ck("sa"), body: { to: "investigating", reason: "Asked twice in the same minute." }
    });
    check("…and moving it there twice is refused rather than rewritten",
      again.status === 409 && msg(again.json).includes("already investigating"), again.text);
    const noOutcome = await call(`/control/service/disputes/${d1}/status`, {
      ck: ck("sa"), body: { to: "upheld", reason: "The office agrees the promise was missed." }
    });
    check("a decided dispute needs the finding in writing before the register is touched",
      noOutcome.status === 400 && JSON.stringify(noOutcome.json).includes("finding in writing"),
      noOutcome.text);
    const noPaper = await call(`/control/service/disputes/${d1}/status`, {
      ck: ck("sa"),
      body: { to: "upheld", reason: "The office agrees and says so on the file.",
        outcome: "The branch did promise a call back before five and the log shows nobody rang." }
    });
    check("a finding with nothing filed on it is refused in the trigger's own words",
      noPaper.status === 409 && msg(noPaper.json).includes("file the paper"), noPaper.text);
    check("…and the words arrive without the table's name stapled to the front",
      !msg(noPaper.json).startsWith("service_disputes"), msg(noPaper.json));

    const note1 = await call(`/control/service/disputes/${d1}/note`, {
      ck: ck("sa"), body: { reason: "Asked the branch for its own copy of the call log." }
    });
    check("a note goes on the file and leaves the finding alone",
      note1.status === 201 && note1.json?.action === "note", note1.text);
    const afterNote = await call(`/control/service/disputes/${d1}`, { ck: ck("pa") });
    check("…and the history is the thing the desk reads back",
      (afterNote.json?.events ?? []).length === 3 &&
        afterNote.json.status === "investigating", afterNote.json?.events?.length);

    // ============================================================
    phase("the paper a finding stands on");
    const wrongBytes = await call(`/control/service/disputes/${d1}/papers`, {
      ck: ck("sa"),
      form: form({ reason: "A paper that is not a paper this desk accepts." },
        { field: "file", name: "notes.txt", type: "image/png",
          bytes: Buffer.from("not an image, not a pdf, only words") })
    });
    check("a file whose bytes are not the type it claims is refused",
      wrongBytes.status === 400 && msg(wrongBytes.json).includes("real JPEG"), wrongBytes.text);
    const missingReason = await call(`/control/service/disputes/${d1}/papers`, {
      ck: ck("sa"),
      form: form({}, { field: "file", name: "the-log.png", type: "image/png", bytes: PNG })
    });
    check("a photograph with no sentence on it is refused by field name",
      missingReason.status === 400 && JSON.stringify(missingReason.json).includes("reason"),
      missingReason.text);
    check("…and nothing was filed", (await oi(
      `select count(*)::int as n from documents where tenant_id = $1 and entity_type = 'service_dispute'`,
      [TC])).rows[0].n === 0);

    const UP = await call(`/control/service/disputes/${d1}/papers`, {
      ck: ck("sa"),
      form: form(
        { reason: "The branch's own copy of the call log, with the five o'clock promise on it." },
        { field: "file", name: "the-log.png", type: "image/png", bytes: PNG })
    });
    docA = String(UP.json?.id ?? "");
    check("a photograph on the dispute is the paper a finding stands on",
      UP.status === 201 && !!docA && UP.json?.mime_type === "image/png" &&
        UP.json?.size_bytes === PNG.length, UP.text.slice(0, 240));
    const docRow = await one(
      `select tenant_id, entity_type, entity_id, kind, storage_path, uploaded_by, deleted_at
         from documents where id = $1`, [docA]);
    check("the row is bound to this desk's tenant and to this dispute, and is not a public link",
      docRow?.tenant_id === TC && docRow?.entity_type === "service_dispute" &&
        docRow?.entity_id === d1 && String(docRow?.storage_path).startsWith(`${TC}/service_dispute/${d1}/`),
      { found: !!docRow, tenant: docRow?.tenant_id, entity: docRow?.entity_id, d1,
        path: String(docRow?.storage_path ?? "") });
    if (docRow?.storage_path) uploaded.push(String(docRow.storage_path));

    const got = await fetch(`${API}/control/service/disputes/${d1}/papers/${docA}/content`, {
      headers: { Cookie: ck("sa") }
    });
    const bytes = Buffer.from(await got.arrayBuffer());
    check("the paper comes back through the API, byte for byte, never as a bucket link",
      got.status === 200 && bytes.equals(PNG) &&
        got.headers.get("content-type") === "image/png", { s: got.status, n: bytes.length });
    check("…with nosniff, and inline because it is an image",
      got.headers.get("x-content-type-options") === "nosniff" &&
        /inline; filename="the-log.png"/.test(String(got.headers.get("content-disposition"))),
      got.headers.get("content-disposition"));
    const crossDoc = await call(`/control/service/disputes/${d2}/papers/${docA}/content`, { ck: ck("sa") });
    check("the same paper is not readable beside a different dispute",
      crossDoc.status === 404, crossDoc.text);
    const foreignDoc = await call(`/control/service/disputes/${d1}/papers/${docA}/content`,
      { ck: ck("for") });
    check("another platform desk cannot open this desk's paper", foreignDoc.status === 404,
      foreignDoc.text);
    check("the read duty does not let a seat file a paper",
      (await call(`/control/service/disputes/${d1}/papers`, {
        ck: ck("pa"),
        form: form({ reason: "An analyst should not be able to add evidence at all." },
          { field: "file", name: "no.png", type: "image/png", bytes: PNG })
      })).status === 403);

    const UP2 = await call(`/control/service/disputes/${d2}/papers`, {
      ck: ck("sa"),
      form: form({ reason: "The invoice page that shows the clearing fee twice." },
        { field: "file", name: "invoice.pdf", type: "application/pdf",
          bytes: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF", "latin1") })
    });
    docB = String(UP2.json?.id ?? "");
    check("a PDF is a paper too, and the sniffed type is what gets stored",
      UP2.status === 201 && UP2.json?.mime_type === "application/pdf", UP2.text.slice(0, 200));
    const pdfRow = await one(`select storage_path from documents where id = $1`, [docB]);
    if (pdfRow?.storage_path) uploaded.push(String(pdfRow.storage_path));

    // A paper taken back is a tombstone, and the floor under the finding goes with it.
    const RET = await call(`/control/service/disputes/${d1}/papers/${docA}/retire`, {
      ck: ck("sa"),
      body: { reason: "The branch sent the wrong week's log; it comes off the file until the "
        + "right one arrives." }
    });
    check("a paper is retired, not deleted, and names the file it took away",
      RET.status === 200 && RET.json?.file_name === "the-log.png", RET.text.slice(0, 200));
    const tombstone = await one(
      `select deleted_at, updated_by from documents where id = $1`, [docA]);
    check("…the row is still on the register with who took it off beside it",
      tombstone?.deleted_at !== null && tombstone?.updated_by === uSA, tombstone);
    const deadRead = await call(`/control/service/disputes/${d1}/papers/${docA}/content`,
      { ck: ck("sa") });
    check("a retired paper is not readable as though the desk still holds it",
      deadRead.status === 404, deadRead.text);
    const afterRetire = await call(`/control/service/disputes/${d1}/status`, {
      ck: ck("sa"),
      body: { to: "upheld", reason: "The office agrees the promise was missed.",
        outcome: "The branch promised a call back before five on the day in question and the log "
          + "shows nobody rang, so the charge on the file is returned to the caller." }
    });
    check("with its paper retired, the same finding has nothing left to stand on",
      afterRetire.status === 409 && msg(afterRetire.json).includes("file the paper"),
      afterRetire.text);
    const UP3 = await call(`/control/service/disputes/${d1}/papers`, {
      ck: ck("sa"),
      form: form({ reason: "The right week's log, this one signed by the branch manager." },
        { field: "file", name: "the-right-week.png", type: "image/png", bytes: PNG })
    });
    docC = String(UP3.json?.id ?? "");
    const up3Row = await one(`select storage_path from documents where id = $1`, [docC]);
    if (up3Row?.storage_path) uploaded.push(String(up3Row.storage_path));
    const UPHELD = await call(`/control/service/disputes/${d1}/status`, {
      ck: ck("sa"),
      body: { to: "upheld", reason: "The office agrees the promise was missed and says so here.",
        outcome: "The branch promised a call back before five on the day in question and the log "
          + "shows nobody rang, so the charge on the file is returned to the caller." }
    });
    check("the finding goes in once a live paper is back under it",
      UPHELD.status === 200 && UPHELD.json?.status === "upheld" && !!UPHELD.json?.decided_at &&
        UPHELD.json?.outcome?.includes("nobody rang"), UPHELD.text.slice(0, 240));
    const rewrite = await call(`/control/service/disputes/${d1}/status`, {
      ck: ck("sa"),
      body: { to: "withdrawn", reason: "A second thought about a signed finding.",
        outcome: "Taking the finding back a week after it was signed, which is not a move the "
          + "register makes." }
    });
    check("a finding once written is not rewritten: the second thought is a new dispute",
      rewrite.status === 409 && msg(rewrite.json).includes("not rewritten") &&
        msg(rewrite.json).includes("Open a second dispute"), rewrite.text);
    const detailUpheld = await call(`/control/service/disputes/${d1}`, { ck: ck("pa") });
    check("…and the file reads with the retired paper and the live one both on its history",
      (detailUpheld.json?.files ?? []).length === 1 &&
        (detailUpheld.json?.events ?? []).some((e: any) => e.action === "paper_retired"),
      { files: detailUpheld.json?.files?.length,
        events: (detailUpheld.json?.events ?? []).map((e: any) => e.action) });

    // ============================================================
    phase("a figure on a paper has to be one sentence with the claim");
    const wrongFigure = await call(`/control/service/disputes/${d2}/refund`, {
      ck: ck("sa"),
      body: { amount: 4000, currency: "TZS", payBack: "mpesa",
        reason: "Paying back a fortieth of what the caller says they were charged twice." }
    });
    check("a paper for a different figure than the claim is refused by name and by number",
      wrongFigure.status === 409 && msg(wrongFigure.json).includes("400000") &&
        msg(wrongFigure.json).includes("4000"), wrongFigure.text);
    const wrongCurrency = await call(`/control/service/disputes/${d2}/refund`, {
      ck: ck("sa"),
      body: { amount: 400000, currency: "USD", payBack: "bank",
        reason: "The claim is in shillings; this paper would be in dollars." }
    });
    check("…and so is the same figure in the other currency",
      wrongCurrency.status === 409 && msg(wrongCurrency.json).includes("TZS"), wrongCurrency.text);

    const R2 = await call(`/control/service/disputes/${d2}/refund`, {
      ck: ck("sa"),
      body: { amount: 400000, currency: "TZS", payBack: "mpesa",
        reason: "The office accepts the charge was raised twice and pays the second one back." }
    });
    paper2 = String(R2.json?.id ?? "");
    check("a paper at the caller's own figure is raised, with its own number",
      R2.status === 201 && /^RF-\d{4}-\d{5,}$/.test(String(R2.json?.ref)) &&
        R2.json?.status === "raised" && R2.json?.dispute_ref === d2ref, R2.text.slice(0, 240));
    const again2 = await call(`/control/service/disputes/${d2}/refund`, {
      ck: ck("sa"),
      body: { amount: 400000, currency: "TZS", payBack: "mpesa",
        reason: "A second paper on the same argument, which would be a second figure." }
    });
    check("a dispute takes one paper",
      again2.status === 409 && msg(again2.json).includes("one paper"), again2.text);
    const detail2 = await call(`/control/service/disputes/${d2}`, { ck: ck("pa") });
    check("the dispute now reads with its paper and its evidence beside it",
      detail2.json?.refund_ref === R2.json?.ref && (detail2.json?.papers ?? []).length === 1 &&
        (detail2.json?.files ?? []).length === 1,
      { refund: detail2.json?.refund_ref, papers: detail2.json?.papers?.length,
        files: detail2.json?.files?.length });
    check("…and the money it says is still the caller's figure",
      Number(detail2.json?.refund_amount) === 400000, detail2.json?.refund_amount);

    // A paper with no dispute under it: the office simply owes the caller something.
    const R3 = await call("/control/service/refunds", {
      ck: ck("sa"), headers: { "user-agent": "smoke-service/device-41" },
      body: { ticketId: call3, amount: 25000, currency: "TZS", payBack: "credit_note",
        reason: "The waybill copy was never sent, so the office credits the printing charge back." }
    });
    paper3 = String(R3.json?.id ?? "");
    check("a paper can stand on a call with no dispute under it",
      R3.status === 201 && R3.json?.dispute_id === null, R3.text.slice(0, 200));
    const R3audit = await one(
      `select action, actor_user_id, ip, user_agent, "after"->>'ref' as ref
         from audit_logs where entity = 'service_refund_requests' and entity_id = $1 and tenant_id = $2`,
      [paper3, TC]);
    check("…and the office's own book records it, with the device and the address",
      R3audit?.action === "control.service.refund_raised" && R3audit.actor_user_id === uSA &&
        R3audit.ip === "127.0.0.1" && R3audit.user_agent === "smoke-service/device-41" &&
        /^RF-\d{4}-\d{5,}$/.test(String(R3audit.ref)), R3audit);
    const wrongPair = await call("/control/service/refunds", {
      ck: ck("sa"),
      body: { ticketId: call3, disputeId: d2, amount: 25000, currency: "TZS", payBack: "mpesa",
        reason: "A paper pointed at a dispute that stands on a different call." }
    });
    check("a paper cannot be stood on a dispute that belongs to another call",
      wrongPair.status === 409 && msg(wrongPair.json).includes(ref1), wrongPair.text);

    const refunds = await call("/control/service/refunds?status=raised", { ck: ck("pa") });
    check("the refund board lists both papers and counts what is waiting",
      refunds.status === 200 && (refunds.json?.rows ?? []).length === 2 &&
        refunds.json?.counts?.raised === 2, { n: refunds.json?.rows?.length,
        counts: refunds.json?.counts });
    const onePaper = await call(`/control/service/refunds/${paper2}`, { ck: ck("pa") });
    check("one paper reads back with the signature it is waiting on — which is nobody yet",
      onePaper.status === 200 && onePaper.json?.status === "raised" &&
        onePaper.json?.dispute_ref === d2ref && onePaper.json?.approval_id === null &&
        onePaper.json?.signature?.request_status === "raised" &&
        onePaper.json?.signature?.approval_status === null &&
        onePaper.json?.signature?.signed_name === null,
      { s: onePaper.json?.status, sig: onePaper.json?.signature });

    // ============================================================
    phase("the money path: one seat asks, another signs, and the desk itself cannot pay");
    check("a seat that manages papers but holds no money duty cannot ask for a signature",
      (await call(`/control/service/refunds/${paper2}/propose`, {
        ck: ck("se"), body: { reason: "Asking a second seat to sign a refund." }
      })).status === 403);
    check("an analyst cannot ask either",
      (await call(`/control/service/refunds/${paper2}/propose`, {
        ck: ck("pa"), body: { reason: "Asking a second seat to sign a refund." }
      })).status === 403);
    const shortPropose = await call(`/control/service/refunds/${paper2}/propose`, {
      ck: ck("sa"), body: { reason: "pay it" }
    });
    check("the sentence a second seat is asked to sign has a floor",
      shortPropose.status === 400 && code(shortPropose.json) === "VALIDATION_FAILED",
      shortPropose.text);

    const P2 = await call(`/control/service/refunds/${paper2}/propose`, {
      ck: ck("sa"),
      body: { reason: "The charge was raised twice on one consignment; the office pays the second back." }
    });
    approval1 = String(P2.json?.approval_id ?? "");
    check("asking for a signature opens it, and says plainly that nothing was paid",
      P2.status === 200 && P2.json?.status === "ok" && !!approval1 &&
        P2.json?.request_status === "pending_signature", P2.text.slice(0, 260));
    check("…the payload is hashed, so the bytes the second seat sees are provably the paper",
      /^[0-9a-f]{64}$/.test(String(P2.json?.payload_sha256 ?? "")), P2.json?.payload_sha256);
    const propRow = await one(
      `select status, approval_id, released_at from service_refund_requests where id = $1`, [paper2]);
    check("the paper is now waiting, and is not spendable",
      propRow?.status === "pending_signature" && propRow?.approval_id === approval1 &&
        propRow?.released_at === null, propRow);
    const twice = await call(`/control/service/refunds/${paper2}/propose`, {
      ck: ck("sa"),
      body: { reason: "A second request for a signature on a paper already waiting for one." }
    });
    check("one paper holds one open signature at a time",
      twice.status === 409 && code(twice.json) === "APPROVAL_OPEN", twice.text);

    const apBoard = await call("/control/approvals?status=pending", { ck: ck("co") });
    const onBoard = (apBoard.json?.rows ?? []).find((r: any) => r.id === approval1) ?? {};
    check("the second seat sees it on the approvals board, by the act it is asked to sign",
      apBoard.status === 200 && onBoard.action === "service.refund" &&
        onBoard.target_kind === "refund_request", { s: apBoard.status, row: onBoard });
    const apDetail = await call(`/control/approvals/${approval1}`, { ck: ck("co") });
    check("…and reading it shows the figure the paper says, not one typed into a body",
      Number(apDetail.json?.payload?.amount) === 400000 &&
        apDetail.json?.payload?.currency === "TZS" &&
        apDetail.json?.payload?.ref === onePaper.json?.ref,
      { payload: apDetail.json?.payload, ref: onePaper.json?.ref });
    check("a seat with no duty on the approvals register cannot read it at all",
      (await call("/control/approvals", { ck: ck("cs") })).status === 403);

    const self = await call(`/control/approvals/${approval1}/approve`, {
      ck: ck("sa"), body: { note: "Signing the refund I asked for myself." }
    });
    check("the seat that raised the paper cannot be the one that signs it",
      self.status === 403 && code(self.json) === "SELF_APPROVAL", self.text);
    check("…and a refusal from a seat that cannot sign is a duty answer, not a decision",
      (await call(`/control/approvals/${approval1}/reject`, {
        ck: ck("cs"), body: { note: "A seat with no signature duty trying to refuse one." }
      })).status === 403);
    const noRelease = await call(`/control/service/refunds/${paper2}/release`, {
      ck: ck("sa"), body: {}
    });
    check("there is no release door on the service desk at all",
      noRelease.status === 404 && noRelease.text.includes("not found"), noRelease.text);

    const sign = await call(`/control/approvals/${approval1}/approve`, {
      ck: ck("co"),
      body: { note: "The invoice does show the clearing fee twice. Paid from the office's side." }
    });
    check("the second seat signs, and the effect happens in the same transaction",
      sign.status === 200, sign.text.slice(0, 300));
    const spentRow = await one(
      `select status, decided_by, proposed_by, applied_at, payload_sha256, result
         from platform_approvals where id = $1`, [approval1]);
    check("…the signature is spent, and the two seats are two people",
      spentRow?.status === "applied" && spentRow?.proposed_by === uSA &&
        spentRow?.decided_by === uCO && spentRow?.applied_at !== null, spentRow);
    const rel = await one(
      `select status, released_at, released_by, approval_id from service_refund_requests where id = $1`,
      [paper2]);
    check("…the paper is released, named to the seat that signed it",
      rel?.status === "released" && rel?.released_by === uCO && rel?.released_at !== null &&
        rel?.approval_id === approval1, rel);
    const afterSign = await call(`/control/service/refunds/${paper2}`, { ck: ck("pa") });
    check("the desk reads the same fact back: released, with the signature attached",
      afterSign.json?.status === "released" && afterSign.json?.released_name === "Biweta Second" &&
        afterSign.json?.signature?.approval_status === "applied" &&
        afterSign.json?.signature?.signed_name === "Biweta Second" &&
        afterSign.json?.approval_id === approval1,
      { s: afterSign.json?.status, by: afterSign.json?.released_name,
        sig: afterSign.json?.signature });

    // The dispute closes on a figure the released paper agrees with.
    const settle = await call(`/control/service/disputes/${d2}/status`, {
      ck: ck("sa"),
      body: { to: "settled", reason: "The office accepts the double charge and has paid it back.",
        outcome: "The second clearing charge was raised in error and the 400,000 TZS was released "
          + "to the caller's own wallet after a second seat signed the paper." }
    });
    check("a settled figure agrees with its paper, so the register lets the finding through",
      settle.status === 200 && settle.json?.status === "settled", settle.text.slice(0, 260));
    const reopen = await call(`/control/service/disputes/${d2}/status`, {
      ck: ck("sa"), body: { to: "open", reason: "Arguing the finding back open a week later." }
    });
    const stillSettled = await one(
      `select status, decided_at, outcome from service_disputes where id = $1`, [d2]);
    check("a settled line stays settled: the way back in is a new dispute",
      reopen.status === 409 && msg(reopen.json).includes("Open a second dispute") &&
        stillSettled?.status === "settled" && !!stillSettled?.decided_at &&
        !!stillSettled?.outcome, { m: msg(reopen.json), row: stillSettled });

    const voidOther = await call(`/control/service/refunds/${paper2}/void`, {
      ck: ck("co"),
      body: { note: "A seat that signed the release trying to take it back without the money duty." }
    });
    check("voiding a released paper costs the money duty, not the signature",
      voidOther.status === 403, voidOther.text);
    const VOID = await call(`/control/service/refunds/${paper2}/void`, {
      ck: ck("sa"),
      body: { note: "The transfer failed at the operator and the office has not paid this; the paper "
        + "is voided rather than left to read as money that went out." }
    });
    check("a released paper nobody actually paid is voided in writing",
      VOID.status === 200 && VOID.json?.status === "void" && !!VOID.json?.void_note, VOID.text);
    const declinedAfter = await call(`/control/service/refunds/${paper2}/decline`, {
      ck: ck("sa"), body: { note: "Trying to refuse a paper that has already been finished." }
    });
    check("a finished paper cannot be refused as well",
      declinedAfter.status === 409, declinedAfter.text);

    // The third paper carries the two refusals, which are not the same act: a signature refused on
    // the approvals desk leaves the paper standing and askable, while the desk's own refusal
    // finishes it. The order below is the order a real file happens in.
    const P3 = await call(`/control/service/refunds/${paper3}/propose`, {
      ck: ck("sa"),
      body: { reason: "The waybill copy never went out; the office credits the printing charge." }
    });
    approval3 = String(P3.json?.approval_id ?? "");
    check("the second paper asks for its own signature", P3.status === 200 && !!approval3, P3.text);

    const lapse = await call(`/control/approvals/${approval3}/reject`, {
      ck: ck("co"),
      body: { note: "The charge was never kept here, so this seat will not sign the credit." }
    });
    const afterLapse = await one(
      `select r.status as paper, a.status as approval, a.decided_by
         from service_refund_requests r
         left join platform_approvals a on a.id = r.approval_id where r.id = $1`, [paper3]);
    check("a signature refused on the approvals desk leaves the paper standing, not paid",
      lapse.status === 200 && afterLapse?.approval === "rejected" &&
        afterLapse?.decided_by === uCO && afterLapse?.paper === "pending_signature",
      { m: msg(lapse.json), s: lapse.status, row: afterLapse });
    const readLapsed = await call(`/control/service/refunds/${paper3}`, { ck: ck("pa") });
    check("…and the desk reads it as a paper waiting on a signature that is already dead",
      readLapsed.json?.signature?.approval_status === "rejected" &&
        readLapsed.json?.signature?.request_status === "pending_signature",
      { s: readLapsed.json?.status, sig: readLapsed.json?.signature?.approval_status });

    const rePropose = await call(`/control/service/refunds/${paper3}/propose`, {
      ck: ck("sa"),
      body: { reason: "The office looked again: the courier charge was in fact kept here, so the "
        + "paper is asked a second time." }
    });
    check("a dead signature does not freeze the paper forever: it can be asked again",
      rePropose.status === 200 && rePropose.json?.status === "ok" &&
        rePropose.json?.request_status === "pending_signature", rePropose.text.slice(0, 200));
    const reApproval = String(rePropose.json?.approval_id ?? "");
    check("…and the second ask is its own signature record, not the refused one rewritten",
      !!reApproval && reApproval !== approval3, { first: approval3, second: reApproval });
    const secondRow = await one(
      `select count(*)::int as open from platform_approvals
        where target_kind = 'refund_request' and target_id = $1 and status = 'pending'`, [paper3]);
    check("…and still only one signature is open on it", secondRow?.open === 1, secondRow);

    const selfDecline = await call(`/control/service/refunds/${paper3}/decline`, {
      ck: ck("sa"), body: { note: "Refusing the signature I asked for, which is not mine to refuse." }
    });
    check("a refusal is also a second seat's answer, not the proposer's",
      selfDecline.status === 403 && code(selfDecline.json) === "SELF_APPROVAL", selfDecline.text);
    const DECL = await call(`/control/service/refunds/${paper3}/decline`, {
      ck: ck("co"),
      body: { note: "The printing charge was a pass-through to the courier and the office cannot "
        + "refund a cost it never kept." }
    });
    check("the second seat may refuse the paper, and the sentence is kept on the row",
      DECL.status === 200 && DECL.json?.request_status === "declined" &&
        DECL.json?.declined_name === "Biweta Second", DECL.text.slice(0, 240));
    const declinedRow = await one(
      `select status, declined_note, declined_by, approval_id from service_refund_requests
        where id = $1`, [paper3]);
    const refusedApproval = await one(
      `select status from platform_approvals where id = $1`, [reApproval]);
    check("…with the name of who refused it beside the reason, and its open signature answered",
      declinedRow?.status === "declined" && !!declinedRow?.declined_note &&
        declinedRow?.declined_by === uCO && refusedApproval?.status === "rejected",
      { row: declinedRow, approval: refusedApproval });
    const afterDecline = await call(`/control/service/refunds/${paper3}/propose`, {
      ck: ck("sa"),
      body: { reason: "Asking a third time on a paper the desk has already said no to." }
    });
    check("a paper the desk has refused is finished: the way back is a new paper",
      afterDecline.status === 409 && msg(afterDecline.json).includes("finished"),
      afterDecline.text);

    // ============================================================
    phase("the satisfaction question, after the work is finished");
    const early = await call("/control/service/satisfaction", {
      ck: ck("sa"), body: { ticketId: call1, askedChannel: "phone_call" }
    });
    check("satisfaction is not asked about a call that is still open",
      early.status === 409 && msg(early.json).includes("still"), early.text);
    for (const [id, ref] of [[call1, ref1], [call2, ref2], [call3, ref3]] as [string, string][]) {
      const res = await call(`/control/tickets/${id}/resolve`, {
        ck: ck("sa"),
        body: { outcome: "resolved",
          resolution: `The desk answered ${ref} and wrote the answer down.`,
          reason: "Settling the call so the caller can be asked how it went." }
      });
      if (res.status !== 200) console.log(`  resolve ${ref} answered ${res.status}: ${res.text}`);
    }
    const A1 = await call("/control/service/satisfaction", {
      ck: ck("sa"), body: { ticketId: call2, askedChannel: "phone_call" }
    });
    csat1 = String(A1.json?.id ?? "");
    const asked = await one(
      `select score, answered_at, asked_by from service_satisfaction where id = $1`, [csat1]);
    check("after the call is settled, the question can be asked",
      A1.status === 201 && A1.json?.ticket_ref === ref2 && A1.json?.asked_at !== undefined &&
        asked?.score === null && asked?.answered_at === null && asked?.asked_by === uSA,
      { body: A1.json, asked });
    const A2 = await call("/control/service/satisfaction", {
      ck: ck("sa"), body: { ticketId: call3, askedChannel: "whatsapp" }
    });
    csat2 = String(A2.json?.id ?? "");
    check("a second call gets its own question", A2.status === 201, A2.text);
    const dup = await call("/control/service/satisfaction", {
      ck: ck("sa"), body: { ticketId: call2 }
    });
    check("one question per call: a caller who rings twice gets a line for the second call",
      dup.status === 409 && msg(dup.json).includes("already been asked"), dup.text);
    const unanswered = await call("/control/service/satisfaction?state=unanswered", { ck: ck("pa") });
    check("the unanswered half of the board is a filter, not a scroll",
      unanswered.status === 200 && (unanswered.json?.rows ?? []).length === 2 &&
        unanswered.json?.counts?.unanswered === 2, { n: unanswered.json?.rows?.length,
        counts: unanswered.json?.counts });
    const AN = await call(`/control/service/satisfaction/${csat1}/answer`, {
      ck: ck("sa"), body: { score: 5, word: "They rang back the same evening.", recommends: true }
    });
    check("the caller's answer is written once, with the word they used",
      AN.status === 200 && AN.json?.score === 5 && AN.json?.recommends === true &&
        !!AN.json?.answered_at, AN.text.slice(0, 220));
    const retype = await call(`/control/service/satisfaction/${csat1}/answer`, {
      ck: ck("sa"), body: { score: 2 }
    });
    check("an answer is kept, not retyped by whoever had the phone last",
      retype.status === 409 && msg(retype.json).includes("was already answered") &&
        msg(retype.json).includes("not retyped"), retype.text);
    const outOfRange = await call(`/control/service/satisfaction/${csat2}/answer`, {
      ck: ck("sa"), body: { score: 9 }
    });
    check("the scale is five, and a nine is refused before the register is touched",
      outOfRange.status === 400, outOfRange.text);
    const LOW = await call(`/control/service/satisfaction/${csat2}/answer`, {
      ck: ck("sa"),
      body: { score: 2, recommends: false,
        word: '=HYPERLINK("https://waisha.test") nobody explained the printing charge.' }
    });
    check("a low mark is recorded as the caller's own words",
      LOW.status === 200 && LOW.json?.score === 2, LOW.text);
    const sat = await call("/control/service/satisfaction?state=all", { ck: ck("pa") });
    check("the counts answer the question an office is actually asked: how did we do",
      sat.json?.counts?.asked === 2 && sat.json?.counts?.answered === 2 &&
        Number(sat.json?.counts?.mean) === 3.5 && sat.json?.counts?.unhappy === 1 &&
        sat.json?.counts?.would_recommend === 1, sat.json?.counts);
    const lowOnly = await call("/control/service/satisfaction?state=low", { ck: ck("pa") });
    check("…and the filter takes the desk straight to the two it has to read",
      (lowOnly.json?.rows ?? []).length === 1 && lowOnly.json.rows[0].score === 2,
      lowOnly.json?.rows?.length);

    // ============================================================
    phase("a mark on how the call was handled");
    const seats = await call("/control/service/seats", { ck: ck("cs") });
    const seatIds = (seats.json?.rows ?? []).map((r: any) => r.id);
    check("the seats a call can be graded against come from this desk's own book",
      seats.status === 200 && [uSA, uSE, uCS].every((id) => seatIds.includes(id)), seatIds.length);
    check("a seat that only manages papers cannot read the mark board's seat list",
      (await call("/control/service/seats", { ck: ck("se") })).status === 403);

    const own = await call("/control/service/quality", {
      ck: ck("cs"),
      body: { ticketId: call3, reviewedSeat: uCS,
        checks: { answered_the_caller: true, identity_confirmed: true, right_desk: true,
          action_offered: true, words_suitable: true, settled_with_answer: true },
        result: "met" }
    });
    check("a seat does not grade its own call",
      own.status === 409 && msg(own.json).includes("own call"), own.text);
    check("a seat without the mark duty is turned away before the form opens",
      (await call("/control/service/quality", {
        ck: ck("se"),
        body: { ticketId: call3, reviewedSeat: uSA,
          checks: { answered_the_caller: true, identity_confirmed: true, right_desk: true,
            action_offered: true, words_suitable: true, settled_with_answer: true },
          result: "met" }
      })).status === 403);
    const noCoaching = await call("/control/service/quality", {
      ck: ck("cs"),
      body: { ticketId: call3, reviewedSeat: uSA,
        checks: { answered_the_caller: false, identity_confirmed: false, right_desk: false,
          action_offered: false, words_suitable: false, settled_with_answer: false },
        result: "below" }
    });
    check("a mark short of the promise needs the coach's line",
      noCoaching.status === 400 && msg(noCoaching.json).includes("coach"), noCoaching.text);
    const missingTick = await call("/control/service/quality", {
      ck: ck("cs"),
      body: { ticketId: call3, reviewedSeat: uSA,
        checks: { answered_the_caller: true, identity_confirmed: true, right_desk: true,
          action_offered: true, words_suitable: true },
        result: "met" }
    });
    check("a review answers all six checks, and says which one is missing",
      missingTick.status === 400 && code(missingTick.json) === "VALIDATION_FAILED" &&
        JSON.stringify(missingTick.json).includes("settled_with_answer"), missingTick.text);

    const M1 = await call("/control/service/quality", {
      ck: ck("cs"),
      body: { ticketId: call3, reviewedSeat: uSA,
        checks: { answered_the_caller: true, identity_confirmed: true, right_desk: true,
          action_offered: true, words_suitable: true, settled_with_answer: true },
        result: "met", note: "The caller was told the printing charge before the invoice went out." }
    });
    mark1 = String(M1.json?.id ?? "");
    check("six ticks are a hundred, worked out by the table and not typed by the desk",
      M1.status === 201 && M1.json?.score === 100 && M1.json?.result === "met", M1.text.slice(0, 240));
    const dupMark = await call("/control/service/quality", {
      ck: ck("cs"),
      body: { ticketId: call3, reviewedSeat: uSA,
        checks: { answered_the_caller: true, identity_confirmed: true, right_desk: true,
          action_offered: true, words_suitable: true, settled_with_answer: true },
        result: "met" }
    });
    check("a reviewer marks a call once",
      dupMark.status === 409 && msg(dupMark.json).includes("already graded"), dupMark.text);
    const contradict = await call("/control/service/quality", {
      ck: ck("cs"),
      body: { ticketId: call2, reviewedSeat: uCO,
        checks: { answered_the_caller: true, identity_confirmed: true, right_desk: true,
          action_offered: true, words_suitable: true, settled_with_answer: true },
        result: "below", note: "The word disagrees with every tick above it on the same form." }
    });
    check("a word that contradicts its own ticks is refused, not quietly re-scaled",
      contradict.status === 409 && msg(contradict.json).includes("ticks score"), contradict.text);
    const M2 = await call("/control/service/quality", {
      ck: ck("cs"),
        body: { ticketId: call2, reviewedSeat: uSE,
        checks: { answered_the_caller: true, identity_confirmed: true, right_desk: false,
          action_offered: true, words_suitable: false, settled_with_answer: true },
        result: "partly_met",
        note: "The caller was answered and settled with one, but the call landed on the wrong desk "
          + "first and the words about the charge were typed too fast to follow." }
    });
    mark2 = String(M2.json?.id ?? "");
    check("four of six is sixty-seven, and the word that fits that band is the one accepted",
      M2.status === 201 && M2.json?.score === 67 && M2.json?.result === "partly_met",
      M2.text.slice(0, 240));

    // The two refusals are tried on mark1, which nobody has answered yet: once an answer exists,
    // `the answer is given once` is the guard that speaks first for any seat, right or wrong.
    const inOthersVoice = await call(`/control/service/quality/${mark1}/response`, {
      ck: ck("cs"), body: { response: "Writing an appeal in somebody else's name by accident." }
    });
    check("a desk cannot answer a mark in the graded seat's voice without naming them",
      inOthersVoice.status === 403, inOthersVoice.text);
    const wrongSeat = await call(`/control/service/quality/${mark1}/response`, {
      ck: ck("cs"), body: { response: "Recording what the seat said, but naming the wrong one.",
        seat: uCO }
    });
    check("…and naming the wrong seat is refused rather than filed against an innocent one",
      wrongSeat.status === 409 && msg(wrongSeat.json).includes("not the seat"), wrongSeat.text);
    const recorded = await call(`/control/service/quality/${mark1}/response`, {
      ck: ck("cs"), body: { response: "The seat says the caller was told, only never gave a name.",
        seat: uSA }
    });
    check("…but a desk that names the right seat can write down what that seat said",
      recorded.status === 200 && !!recorded.json?.responded_at &&
        recorded.json?.reviewed_seat === uSA, recorded.text.slice(0, 200));

    const appeal1 = await call(`/control/service/quality/${mark2}/response`, {
      ck: ck("se"), body: { response: "The desk I passed it to had already closed for the day." }
    });
    check("the graded seat answers its own mark, once",
      appeal1.status === 200 && !!appeal1.json?.responded_at, appeal1.text.slice(0, 200));
    const appeal2 = await call(`/control/service/quality/${mark2}/response`, {
      ck: ck("se"), body: { response: "A second thought about the same mark, a week later." }
    });
    check("an answer is given once",
      appeal2.status === 409 && msg(appeal2.json).includes("already been answered"), appeal2.text);
    const M3 = await call("/control/service/quality", {
      ck: ck("cs"),
      body: { ticketId: call1, reviewedSeat: uSA,
        checks: { answered_the_caller: true, identity_confirmed: false, right_desk: true,
          action_offered: true, words_suitable: true, settled_with_answer: true },
        result: "met", note: "Identity was never confirmed on the recording." }
    });
    mark3 = String(M3.json?.id ?? "");
    check("five of the six is still met, and the band is the table's, not the desk's",
      M3.status === 201 && M3.json?.score === 83 && M3.json?.result === "met",
      M3.text.slice(0, 200));
    const WD = await call(`/control/service/quality/${mark3}/withdraw`, {
      ck: ck("cs"), body: { reason: "The recording was the wrong call: the mark was given to nothing." }
    });
    check("a mark can be taken off the board, with the reason beside it",
      WD.status === 200 && !!WD.json?.withdrawn_at, WD.text.slice(0, 200));
    const WDagain = await call(`/control/service/quality/${mark3}/withdraw`, {
      ck: ck("cs"), body: { reason: "Withdrawing the same mark a second time." }
    });
    check("a withdrawn review stays withdrawn",
      WDagain.status === 409 && msg(WDagain.json).includes("already withdrawn"), WDagain.text);
    const appealGone = await call(`/control/service/quality/${mark3}/response`, {
      ck: ck("sa"), body: { response: "Answering a mark that was taken off the board." }
    });
    check("there is nothing to answer on a withdrawn mark",
      appealGone.status === 409, appealGone.text);

    const qual = await call("/control/service/quality?result=all", { ck: ck("cs") });
    check("the marks board shows the live marks and the roll-up beside them",
      qual.status === 200 && (qual.json?.rows ?? []).length === 3 &&
        qual.json?.counts?.live === 2 && qual.json?.counts?.withdrawn === 1 &&
        qual.json?.counts?.met === 1 && qual.json?.counts?.partly === 1 &&
        qual.json?.counts?.answered === 2, qual.json?.counts);
    const liveRows = (qual.json?.rows ?? [])
      .filter((r: any) => !r.withdrawn_at).map((r: any) => r.id);
    check("…the two marks that stand are the ones the board shows; a withdrawn one is history only",
      liveRows.length === 2 && liveRows.includes(mark1) && liveRows.includes(mark2) &&
        !liveRows.includes(mark3), liveRows);
    const rollUp = (qual.json?.seats ?? []).find((s: any) => s.seat_id === uSA) ?? {};
    check("…and the per-seat roll-up does not count the mark that was withdrawn",
      rollUp.marks === 1 && Number(rollUp.mean) === 100, rollUp);
    const bySeat = await call(`/control/service/quality?seat=${uSE}`, { ck: ck("cs") });
    check("one seat's marks can be pulled out on their own",
      (bySeat.json?.rows ?? []).length === 1 && bySeat.json.rows[0].seat_name === "Simba Engineer",
      bySeat.json?.rows?.length);

    // ============================================================
    phase("the CSV every tab is asked to carry");
    const exp = async (q: string, who = "sa") => {
      const res = await fetch(`${API}/control/service/export?${q}`, { headers: { Cookie: ck(who) } });
      return { status: res.status, type: res.headers.get("content-type") ?? "",
        disp: res.headers.get("content-disposition") ?? "", text: await res.text() };
    };
    const e1 = await exp("register=disputes");
    check("a CSV of disputes starts with the columns a dispute is argued on",
      e1.status === 200 && /text\/csv/.test(e1.type) &&
        e1.text.split("\r\n")[0].includes('"amount","currency","claim","opened_name"') &&
        /attachment; filename=/.test(e1.disp), { s: e1.status, head: e1.text.slice(0, 120) });
    check("…it carries both findings and names the paper the settled one stands on",
      e1.text.includes(d1ref) && e1.text.includes(d2ref) &&
        e1.text.includes(String(onePaper.json?.ref ?? "")), e1.text.length);
    const e2 = await exp("register=refunds");
    const e2head = e2.text.split("\r\n")[0];
    check("a CSV of papers carries the signature state, read through the board and not the register",
      e2.status === 200 && ["request_status", "approval_status", "approval_proposed_name",
        "signed_name", "released_name", "declined_note"]
        .every((h) => e2head.includes(`"${h}"`)) &&
        e2.text.includes("applied") && /Amani Super/.test(e2.text), e2.text.slice(0, 300));
    const e3 = await exp("register=satisfaction&status=answered");
    check("a CSV of the survey is filterable to the answers a manager has to read",
      e3.status === 200 && e3.text.includes(ref2) && e3.text.includes(ref3) &&
        !/unanswered/.test(e3.text), e3.text.slice(0, 200));
    const formula = e3.text.split("\r\n").find((l) => l.includes("HYPERLINK")) ?? "";
    check("a caller's own word is neutralised, so a CSV cell cannot open as a formula",
      formula.includes(`"'=HYPERLINK(""https://waisha.test"")`), formula.slice(0, 120));
    const e4 = await exp(`register=quality&seat=${uSE}`);
    check("a CSV of marks puts the six ticks in six columns, so it can be sorted by the one it failed on",
      e4.status === 200 && ["answered_the_caller", "identity_confirmed", "right_desk",
        "action_offered", "words_suitable", "settled_with_answer"]
        .every((h) => e4.text.split("\r\n")[0].includes(`"${h}"`)), e4.text.split("\r\n")[0]);
    check("…and the filter is the seat's own: one graded call, named, nothing else's",
      e4.text.split("\r\n").length === 2 && e4.text.includes("Simba Engineer") &&
        !e4.text.includes("Amani Super"), e4.text.split("\r\n").length);
    check("no export of any register carries the caller's phone",
      ![e1, e2, e3, e4].some((r) => r.text.includes(PHONE.slice(5))),
      [e1, e2, e3, e4].map((r) => r.status));
    const badRegister = await exp("register=teleported");
    check("an unknown register is a 400 that names what does exist",
      badRegister.status === 400 && badRegister.text.includes("satisfaction"), badRegister.text);
    const badState = await exp("register=disputes&status=finished");
    check("a typo in a status is refused, because an empty CSV would be believed",
      badState.status === 400 && badState.text.includes("open, investigating"), badState.text);
    const badGroundCsv = await exp("register=disputes&ground=teleported");
    check("…and so is a ground the office never keeps",
      badGroundCsv.status === 400 && badGroundCsv.text.includes("overcharge"), badGroundCsv.text);
    check("the read duty exports; the seat with no service duty at all does not",
      (await exp("register=disputes", "ba")).status === 403);
    // Seven of the twelve an hour have gone on this seat already (four registers, three refused
    // queries — the limiter is taken before the query is even read), so five more fit and the
    // thirteenth does not.
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await exp(`register=disputes&search=${d1ref}`)).status;
    const capped = await exp("register=disputes");
    check("the export is limited to twelve an hour per seat, and the refusal is a 429",
      last === 200 && capped.status === 429, { last, capped: capped.status });

    // ============================================================
    phase("the register is this desk's, and nobody else's");
    const foreign = await call("/control/service/disputes?status=all", { ck: ck("for") });
    check("another platform desk's dispute board is genuinely empty",
      foreign.status === 200 && (foreign.json?.rows ?? []).length === 0 &&
        foreign.json?.counts?.total === 0, foreign.json?.counts);
    const foreignBoard = await call("/control/service/board", { ck: ck("for") });
    check("…and so is its money: nothing waited for a signature there",
      foreignBoard.json?.refunds?.awaiting_signature === 0 &&
        foreignBoard.json?.disputes?.open === 0, foreignBoard.json?.refunds);
    const foreignNote = await call(`/control/service/disputes/${d1}/note`, {
      ck: ck("for"), body: { reason: "A note written from a desk that does not hold this dispute." }
    });
    check("a foreign desk cannot write on a dispute it cannot see",
      foreignNote.status === 404, foreignNote.text);
    const foreignPaper = await call(`/control/service/refunds/${paper2}`, { ck: ck("for") });
    check("…nor read the paper it stands on", foreignPaper.status === 404, foreignPaper.text);
    const foreignCsv = await exp("register=disputes", "for");
    check("…nor export a copy of it",
      foreignCsv.status === 200 && !foreignCsv.text.includes(d1ref), foreignCsv.text.slice(0, 160));
    const foreignQuality = await call("/control/service/quality?result=all", { ck: ck("for") });
    check("…and the marks board reads its own office and no other",
      (foreignQuality.json?.rows ?? []).length === 0 && foreignQuality.json?.counts?.live === 0,
      foreignQuality.json?.counts);
    const badUuid = await call("/control/service/disputes/not-a-uuid", { ck: ck("sa") });
    check("a malformed id is a 400, not a 500 from the driver",
      badUuid.status === 400, badUuid.text);
    const companyToken = await mint(uDir, CO, "director");
    check("a company bearer token never reaches this desk at all",
      (await fetch(`${API}/control/service/disputes`, {
        headers: { Authorization: `Bearer ${companyToken}` }
      })).status === 401);

    // ============================================================
    phase("every write left its line in the office's book");
    const audit = await oi(
      `select action, count(*)::int as n from audit_logs
        where tenant_id = $1 and action like 'control.service.%' group by action`, [TC]);
    const by = Object.fromEntries(audit.rows.map((r: any) => [r.action, r.n]));
    check("the dispute history is in the ordinary audit book as well as on the file",
      by["control.service.opened"] === 2 && by["control.service.status_changed"] === 1 &&
        by["control.service.decided"] === 2 && by["control.service.note"] === 1 &&
        by["control.service.paper_filed"] === 3 && by["control.service.paper_retired"] === 1, by);
    check("…the survey, the marks and the money each leave exactly the lines they should",
      by["control.service.csat_asked"] === 2 && by["control.service.csat_answered"] === 2 &&
        by["control.service.review_marked"] === 3 &&
        by["control.service.review_answered"] === 2 &&
        by["control.service.review_withdrawn"] === 1 &&
        by["control.service.refund_raised"] === 2, by);
    const eventLines = await one(
      `select count(*)::int as n, count(*) filter (where ip is null)::int as blind,
              count(*) filter (where actor_role is null)::int as roleless
         from service_dispute_events where tenant_id = $1`, [TC]);
    // Eleven, not ten: raising the paper under d2 writes its own line on the file, so a dispute's
    // history is the desk's moves and the paper it stands on, in one read.
    check("every line on the dispute file names who wrote it, in what role and from where",
      eventLines?.n === 11 && eventLines?.blind === 0 && eventLines?.roleless === 0, eventLines);
    const live = await one(
      `select (select count(*)::int from service_disputes where tenant_id = $1) as disputes,
              (select count(*)::int from service_refund_requests where tenant_id = $1) as papers,
              (select count(*)::int from service_satisfaction where tenant_id = $1) as survey,
              (select count(*)::int from service_quality_reviews where tenant_id = $1) as marks`,
      [TC]);
    check("the registers hold exactly what this run wrote and nothing else",
      live?.disputes === 2 && live?.papers === 2 && live?.survey === 2 && live?.marks === 3, live);
  } finally {
    // ---------------- teardown ----------------
    phase("teardown");
    const tids = [TC, TB, CO];
    const residue = await one(
      `select (select count(*)::int from service_disputes where tenant_id = any($1::uuid[])) as disputes,
              (select count(*)::int from service_dispute_events where tenant_id = any($1::uuid[])) as lines,
              (select count(*)::int from service_refund_requests where tenant_id = any($1::uuid[])) as papers,
              (select count(*)::int from service_satisfaction where tenant_id = any($1::uuid[])) as survey,
              (select count(*)::int from service_quality_reviews where tenant_id = any($1::uuid[])) as marks,
              (select count(*)::int from documents where tenant_id = any($1::uuid[])
                 and entity_type = 'service_dispute') as files,
              (select count(*)::int from support_tickets where tenant_id = any($1::uuid[])) as calls`,
      [tids]);
    await sweep();
    await oi(`delete from rate_limits where bucket like 'service-%' or bucket like 'approvals-%'
                or bucket like 'tickets-write%' or bucket like 'dept-write%'`);

    let removed = 0;
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      for (const path of uploaded) {
        const res = await fetch(
          `${env.SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/${env.DOCUMENTS_BUCKET}/` +
          `${encodeURI(path)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            apikey: env.SUPABASE_SERVICE_ROLE_KEY } });
        if (res.ok || res.status === 404) removed++;
        else console.log(`  the bucket kept ${path} (${res.status})`);
      }
    }
    const left = await one(
      `select (select count(*)::int from tenants where name like $1) as tenants,
              (select count(*)::int from users where email like $2) as seats,
              (select count(*)::int from sessions where user_agent = 'smoke-service') as sessions,
              (select count(*)::int from platform_approvals
                 where target_kind = 'refund_request'
                   and target_id in (select id::text from service_refund_requests)) as signatures,
              (select count(*)::int from rate_limits where bucket like 'service-%') as limiters`,
      [TENANT_SWEEP, EMAIL_SWEEP]);
    check(`the uploaded papers came out of the bucket (${uploaded.length} attempted)`,
      removed === uploaded.length, { wanted: uploaded.length, removed });
    check(`the registers were left with exactly what this run wrote (${JSON.stringify(residue)})`,
      residue?.disputes === 2 && residue?.papers === 2 && residue?.calls === 3, residue);
    check("nothing of this run is left in the database",
      left?.tenants === 0 && left?.seats === 0 && left?.sessions === 0 &&
        left?.signatures === 0 && left?.limiters === 0, left);
    note("audit_logs is never deleted — this run's service lines stay in the fixture tenants, "
      + "as every earlier smoke leaves its own.");
    await owner.end();
  }

  console.log(`\n${failures ? `${failures} FAILURES of ${failures + proved}`
    : `all ${proved} checks passed — the service desk`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
