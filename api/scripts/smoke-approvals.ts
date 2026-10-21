/**
 * #338 — a ban that two seats signed, asked of the running API.
 *
 * 121's SQL suite proves the machinery: the trigger that refuses an unsigned ban, the
 * hash that a signature is taken on, the claim that can only be won once. This suite is
 * the other half — that a person at the desk can actually walk the chain through HTTP and
 * that nothing along the way leaks. So it signs in as three real platform seats against
 * two companies that signed up for real, and it reads the database back after every call:
 * the proposal row, the register row, the audit rows, the company's status, the sessions,
 * the notice receipt.
 *
 * The three things this can only prove over HTTP:
 *
 *   1. a proposal changes nothing. The company is still trading, its seat still works, and
 *      `tenant_actions` is empty — a queued ban is not a ban.
 *   2. the seat that raised a proposal is refused when it signs its own work, and the same
 *      call from a second seat is accepted. That is the office's rule, and it holds with a
 *      cookie, a body and a route between the person and the database.
 *   3. the duty split survives contact with a real role: a billing admin cannot raise a
 *      ban, cannot read the register, and cannot sign one — while the compliance seat it
 *      works beside can do all three, because 121 seeded the keys onto roles, not onto
 *      people.
 *
 * Nothing here shuts a company the smoke did not make. Every block lands on a fixture
 * company, and the teardown deletes the register rows, the seats and the companies.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-approvals.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { encryptField, searchHash, sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";

const STAMP = Date.now().toString().slice(-8);
const COMPANY_A = `Approvals Smoke Alpha ${STAMP} Ltd`;
const COMPANY_B = `Approvals Smoke Bravo ${STAMP} Ltd`;
const DESK = `Approvals Smoke Desk ${STAMP}`;
const SEEKER = `Approvals Smoke Seeker ${STAMP}`;
const EMAIL_A = `appr.smoke.a.${STAMP}@waisha.test`;
const EMAIL_B = `appr.smoke.b.${STAMP}@waisha.test`;
const TIN_A = `7${STAMP}`;
const TIN_B = `6${STAMP}`;
const PHONE_A = `+2557${STAMP}`;
const PHONE_B = `+2556${STAMP}`;
const PASSWORD = `Ap-${STAMP}-Q4!v`;
const NAME_SWEEP = `Approvals Smoke %`;

/** `reason` is what the second seat signs; `note` is what the company is sent. */
const REASON = "Two cargoes carried outside the licence this company holds, in one month.";
const NOTE = "Blocked by the WAISHA office after two cargoes outside your licence.";
const CLOSE_REASON = "The company has not paid and is not answering the office.";
const CLOSE_NOTE = "Account closed by the WAISHA office for long-standing non-payment.";
const SIGN_LINE = "Yes. I read the file: block it.";
const REFUSE_LINE = "No. Give the company a week to answer first.";

const LEAK_MARKERS = [
  "password_hash", "token_hash", "code_hash", "ntra_encrypted", "nida_encrypted",
  "phone_encrypted", "totp_secret", "syntax error at or near", "duplicate key value violates",
  "Postgres", "node_modules", "at Object.<anonymous>", "FastifyError", '"targets"'
];

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const bodies: string[] = [];
const approvalBodies: string[] = [];
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
  if (init.method === "POST" && path.startsWith("/control/approvals")) approvalBodies.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

const ck = (who: string) => ({ Cookie: `waisha_control=${who}` });

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const clearBuckets = async (...prefixes: string[]) => {
    for (const p of prefixes) await oi(`delete from rate_limits where bucket like $1`, [`${p}%`]);
  };

  const WIPE = ["trip_checkpoint_logs", "route_checkpoints", "shipper_file_shares", "shipper_accounts",
    "freight_invoice_payments", "freight_invoice_items", "freight_invoices", "freight_expenses",
    "fuel_logs", "incidents", "trip_shipments", "trips", "routes", "message_reads", "messages",
    "office_costs", "office_tasks", "employee_evaluations", "employees", "screening_checks",
    "screening_entries", "cargo_tasks", "cargo_shipments", "clients", "drivers", "vessels",
    "office_budgets", "regulatory_licences", "inventory_items", "documents", "branches",
    "transport_requests", "transport_bookings", "tenant_actions", "payments", "invoices",
    "sessions", "otp_codes", "password_resets", "settings", "subscriptions", "user_roles"];

  const seats: string[] = [];
  const tids: string[] = [];

  /** Scoped to this run's companies and seats, so a foreign approval is never touched. */
  const wipeApprovals = async () => {
    if (!tids.length && !seats.length) return;
    // The act row is what references the signature, so it goes first — a delete that leaves
    // a proposal behind is a delete that silently did nothing.
    await oi(`delete from tenant_actions where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from platform_approvals where target_id = any($1::text[])
                or proposed_by = any($2::uuid[]) or decided_by = any($2::uuid[])`,
      [tids, seats]).catch(() => { });
    // Not the audit rows: 001's trigger raises on any update or delete of `audit_logs`, so
    // this suite's own lines are permanent. The teardown says how many rather than pretending
    // to remove them.
  };

  const wipeTenants = async (list: string[]) => {
    if (!list.length) return;
    for (const t of WIPE) {
      await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [list]).catch(() => { });
    }
    await oi(`delete from alert_reads where tenant_id = any($1::uuid[])`, [list]).catch(() => { });
    await oi(`delete from documents where entity_type = 'user' and entity_id in
             (select id from users where tenant_id = any($1::uuid[]))`, [list]).catch(() => { });
    await oi(`delete from user_roles where user_id in
             (select id from users where tenant_id = any($1::uuid[]))`, [list]).catch(() => { });
    await oi(`delete from roles where tenant_id = any($1::uuid[])`, [list]).catch(() => { });
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [list]).catch(() => { });
    await oi(`delete from tenants where id = any($1::uuid[])`, [list]);
  };

  // An earlier aborted run leaves rows behind; fixture names carry the stamp.
  const stale = (await oi(`select id from tenants where name like $1`, [NAME_SWEEP]))
    .rows.map((r: any) => r.id);
  const staleSeats = (await oi(`select id from users where full_name in
                    ('Ada Desk','Cie Compliance','Ben Billing') and tenant_id = any($1::uuid[])`,
    [stale])).rows.map((r: any) => r.id);
  seats.push(...staleSeats); tids.push(...stale);
  await wipeApprovals();
  await wipeTenants(stale);
  await clearBuckets("login:", "signup:", "otp:", "tenant-action:", "activate:uid:",
    "approvals-", "internal-tick:", "ip:");

  // The gate's snapshot is not empty on a development database — the office has closed
  // companies by hand here. Anything this suite asserts about suspended companies is
  // therefore measured against what it found, never against zero.
  const baseline = new Set<string>(((await oi(
    `select platform_auth.tenant_suspensions() as s`)).rows[0].s as any[])
    .map((x: any) => x.tenant_id));

  const roleRows = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "billing_admin", "compliance_officer", "director"]]
  )).rows;
  const rid = (k: string) => roleRows.find((r: any) => r.key === k)?.id;
  if (!rid("super_admin") || !rid("compliance_officer") || !rid("billing_admin")) {
    throw new Error("global platform roles missing");
  }
  const duty = (await oi(
    `select r.key, rp.permission_key from role_permissions rp join roles r on r.id = rp.role_id
      where r.tenant_id is null and rp.permission_key in
        ('control.tenants.manage','control.approvals.view','control.approvals.decide')
      order by r.key`)).rows;
  const holds = (roleKey: string, key: string) =>
    duty.some((d: any) => d.key === roleKey && d.permission_key === key);

  const CT = randomUUID();     // the platform desk
  const CS = randomUUID();     // a seeker account, which no seat may ban
  const uADM = randomUUID();   // super admin: raises, and may sign another seat's work
  const uCMP = randomUUID();   // compliance officer: the second seat
  const uBIL = randomUUID();   // billing admin: sells licences, holds none of the register's duties
  seats.push(uADM, uCMP, uBIL);
  const tok = (who: string) => `appr-smoke-${who}-${STAMP}`;

  let TCA = ""; let dirA = ""; let tokenA = "";
  let TCB = ""; let dirB = "";

  const appr = async (id: string) => (await oi(
    `select a.action, a.target_kind, a.target_id, a.status, a.reason, a.payload, a.payload_sha256,
            a.proposed_by, a.proposed_role, a.decided_by, a.decided_role, a.decided_note,
            a.applied_at, a.result, a.expires_at,
            encode(extensions.digest(a.payload::text, 'sha256'), 'hex') as rehash,
            (select count(*)::int from tenant_actions t where t.approval_id = a.id) as spent_on
       from platform_approvals a where a.id = $1`, [id])).rows[0];
  const register = async (tid: string) => (await oi(
    `select action, reason_code, actor_kind, note, prior_status, new_status, approval_id,
            delivery <> '{}'::jsonb as told
       from tenant_actions where tenant_id = $1 order by created_at`, [tid])).rows;
  const seatState = async (tid: string) => (await oi(
    `select status, deleted_at is not null as closed from tenants where id = $1`, [tid])).rows[0];
  const liveSessions = async (tid: string) => (await oi(
    `select count(*)::int as n from sessions where tenant_id = $1 and revoked_at is null`,
    [tid])).rows[0].n;
  const auditFor = async (tid: string, action: string) => (await oi(
    `select actor_user_id, actor_role, before, after from audit_logs
      where tenant_id = $1 and action = $2 order by ts desc limit 1`, [tid, action])).rows[0];
  const auditCount = async (tid: string, action: string) => (await oi(
    `select count(*)::int as n from audit_logs where tenant_id = $1 and action = $2`,
    [tid, action])).rows[0].n;

  const propose = (token: string, action: string, body: any) => call("/control/approvals", null, {
    method: "POST", headers: ck(token), body: JSON.stringify({ action, ...body })
  });
  const sign = (token: string, id: string, note: string, verb = "approve") =>
    call(`/control/approvals/${id}/${verb}`, null, {
      method: "POST", headers: ck(token), body: JSON.stringify({ note })
    });
  /** `result` defaults to `{}`, so an unspent signature is read as "nothing in it", never as null. */
  const unspent = (r: any) => r?.result === null || Object.keys(r?.result ?? {}).length === 0;

  try {
    // ==================================================================
    phase("A · three platform seats, two real companies, one open question");

    const signupA = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: COMPANY_A, tin: TIN_A, phone: PHONE_A, email: EMAIL_A,
        password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true
      })
    });
    dirA = signupA.json?.userId ?? "";
    TCA = (await oi(`select tenant_id from users where id = $1`, [dirA])).rows[0]?.tenant_id ?? "";
    tids.push(TCA);
    check("company alpha signed up for real", signupA.status === 201 && !!TCA, { s: signupA.status });

    const signupB = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: COMPANY_B, tin: TIN_B, phone: PHONE_B, email: EMAIL_B,
        password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true
      })
    });
    dirB = signupB.json?.userId ?? "";
    TCB = (await oi(`select tenant_id from users where id = $1`, [dirB])).rows[0]?.tenant_id ?? "";
    tids.push(TCB, CT, CS);
    check("company beta signed up for real", signupB.status === 201 && !!TCB, { s: signupB.status });

    await oi(`insert into tenants (id, type, name, status) values
        ($1,'platform',$2,'active'), ($3,'seeker',$4,'active')`, [CT, DESK, CS, SEEKER]);
    await oi(`insert into users (id, tenant_id, user_type, full_name, email,
             email_normalized_search, status, totp_enabled)
       values ($1,$2,'platform','Ada Desk',$3,$4,'active',false),
              ($5,$2,'platform','Cie Compliance',$6,$7,'active',false),
              ($8,$2,'platform','Ben Billing',$9,$10,'active',false)`,
      [uADM, CT, `appr.desk.admin.${STAMP}@waisha.test`, searchHash(`appr.desk.admin.${STAMP}@waisha.test`),
      uCMP, `appr.desk.comp.${STAMP}@waisha.test`, searchHash(`appr.desk.comp.${STAMP}@waisha.test`),
      uBIL, `appr.desk.billing.${STAMP}@waisha.test`, searchHash(`appr.desk.billing.${STAMP}@waisha.test`)]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2), ($3,$4), ($5,$6)`,
      [uADM, rid("super_admin"), uCMP, rid("compliance_officer"), uBIL, rid("billing_admin")]);
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
            refresh_token_hash, user_agent, ip, expires_at)
         values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-approvals','127.0.0.1',
                 now() + interval '2 hours'),
                ($6,$7,$3,$8, now() + interval '2 hours', $9,'smoke-approvals','127.0.0.1',
                 now() + interval '2 hours'),
                ($10,$11,$3,$12, now() + interval '2 hours', $13,'smoke-approvals','127.0.0.1',
                 now() + interval '2 hours')`,
      [randomUUID(), uADM, CT, randomUUID(), sha256(tok("adm")),
      randomUUID(), uCMP, randomUUID(), sha256(tok("cmp")),
      randomUUID(), uBIL, randomUUID(), sha256(tok("bil"))]);

    await oi(`update tenants set status = 'active' where id = any($1::uuid[])`, [[TCA, TCB]]);
    await oi(`update users set status = 'active', phone_encrypted = $2, phone_search = $3
               where id = any($1::uuid[])`,
      [[dirA, dirB], encryptField(PHONE_A), searchHash(PHONE_A)]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2), ($3,$4)`,
      [dirA, rid("director"), dirB, rid("director")]);

    const loginA = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN_A, email: EMAIL_A, password: PASSWORD })
    });
    tokenA = loginA.json?.accessToken ?? "";
    check("alpha's director signs in with a real password", loginA.status === 200 && !!tokenA, loginA.status);
    const quiet = await call("/notifications", tokenA);
    check("and the company is trading: the gate is quiet", quiet.status === 200, quiet.status);

    // The register's doors are the roles' own keys, read from the database rather than
    // assumed: if a later migration moves one, the checks below say so instead of passing.
    check("121 put the register's two duties on the seats that already could ban",
      holds("super_admin", "control.approvals.decide")
      && holds("compliance_officer", "control.approvals.decide")
      && holds("super_admin", "control.approvals.view"), duty);
    check("and the duty to raise a ban is the duty to perform it",
      holds("super_admin", "control.tenants.manage")
      && !holds("billing_admin", "control.tenants.manage"), duty);

    // ==================================================================
    phase("B · the board, and who is allowed to look at it");

    const board = await call("/control/approvals", null, { headers: ck(tok("adm")) });
    check("a platform seat reads the register", board.status === 200 && Array.isArray(board.json?.rows)
      && typeof board.json?.counts?.total === "number", { s: board.status, c: board.json?.counts });
    check("the board counts every state a proposal can be in",
      ["pending", "approved", "applied", "rejected", "lapsed", "total"]
        .every((k) => k in (board.json?.counts ?? {})), board.json?.counts);
    const boardCmp = await call("/control/approvals?limit=5", null, { headers: ck(tok("cmp")) });
    check("the seat that signs can read it too", boardCmp.status === 200, boardCmp.status);

    const boardBil = await call("/control/approvals", null, { headers: ck(tok("bil")) });
    check("a billing admin cannot read the register at all",
      boardBil.status === 403 && boardBil.json?.error?.code === "FORBIDDEN",
      { s: boardBil.status, c: boardBil.json?.error?.code });
    const boardAnon = await call("/control/approvals", null);
    check("an anonymous reader is turned away before the query runs", boardAnon.status === 401, boardAnon.status);
    const boardForged = await call("/control/approvals", null, { headers: ck(`appr-smoke-forged-${STAMP}`) });
    check("and so is a cookie that is not a session", boardForged.status === 401, boardForged.status);
    const boardBadStatus = await call("/control/approvals?status=on_hold", null, { headers: ck(tok("adm")) });
    check("a status nobody defined is refused rather than quietly ignored",
      boardBadStatus.status === 400, boardBadStatus.status);

    const ghostDetail = await call(`/control/approvals/${randomUUID()}`, null, { headers: ck(tok("adm")) });
    check("a proposal that does not exist is a 404, not a 500",
      ghostDetail.status === 404 && ghostDetail.json?.error?.code === "NOT_FOUND", ghostDetail.status);
    const badId = await call("/control/approvals/not-an-id", null, { headers: ck(tok("adm")) });
    check("a route parameter that is not an id never reaches the definer", badId.status === 400, badId.status);

    // ==================================================================
    phase("C · raising a proposal does nothing to anybody");

    const badAction = await propose(tok("adm"), "tenant.delete",
      { targetId: TCA, reasonCode: "abuse", reason: REASON, note: NOTE });
    check("an action this desk cannot apply is refused by name",
      badAction.status === 400 && /tenant\.delete/.test(badAction.json?.error?.message ?? ""),
      { s: badAction.status, m: badAction.json?.error?.message });

    const billingPropose = await propose(tok("bil"), "tenant.block",
      { targetId: TCA, reasonCode: "abuse", reason: REASON, note: NOTE });
    check("a billing admin cannot queue a ban it has no right to perform",
      billingPropose.status === 403 && (await register(TCA)).length === 0,
      { s: billingPropose.status, c: billingPropose.json?.error?.code });

    const shortReason = await propose(tok("adm"), "tenant.block",
      { targetId: TCA, reasonCode: "abuse", reason: "bad", note: NOTE });
    check("a one-word reason is refused: two people have to read it",
      shortReason.status === 400, shortReason.status);
    const shortNote = await propose(tok("adm"), "tenant.block",
      { targetId: TCA, reasonCode: "abuse", reason: REASON, note: "bad" });
    check("and so is a one-word note: the company is the one that receives it",
      shortNote.status === 400, shortNote.status);
    const noReason = await propose(tok("adm"), "tenant.block", { targetId: TCA, reasonCode: "abuse", note: NOTE });
    check("a body missing the reason the second seat signs is refused", noReason.status === 400, noReason.status);
    const overtyped = await propose(tok("adm"), "tenant.block",
      { targetId: TCA, reasonCode: "abuse", reason: REASON, note: NOTE, status: "applied", actor_kind: "system" });
    check("a body cannot overtype the state or the actor a proposal claims to be",
      overtyped.status === 400, overtyped.status);
    const badTarget = await propose(tok("adm"), "tenant.block",
      { targetId: "not-a-uuid", reasonCode: "abuse", reason: REASON, note: NOTE });
    check("a company id that is not an id is refused before the register is asked",
      badTarget.status === 400, badTarget.status);
    check("none of those refusals wrote a register row", (await register(TCA)).length === 0, await register(TCA));

    const raised = await propose(tok("adm"), "tenant.block",
      { targetId: TCA, reasonCode: "terms_violation", reason: REASON, note: NOTE });
    const idA = raised.json?.approval_id ?? "";
    check("block → 200, and the answer says it is only pending",
      raised.status === 200 && raised.json?.status === "ok"
      && raised.json?.approval_status === "pending" && !!idA,
      { s: raised.status, b: raised.json });
    check("the proposal names the company and the seat that raised it",
      raised.json?.target_id === TCA && raised.json?.target_name === COMPANY_A
      && /^[0-9a-f]{64}$/.test(raised.json?.payload_sha256 ?? ""), raised.json);
    const days = (new Date(raised.json?.expires_at ?? 0).getTime() - Date.now()) / 86400000;
    check("the signature has a week to be collected", days > 6.9 && days < 7.1, days);

    const rowA = await appr(idA);
    check("the row is pending, signed by nobody, and spent on nothing",
      rowA?.status === "pending" && rowA?.proposed_by === uADM
      && rowA?.proposed_role === "super_admin" && rowA?.decided_by === null
      && rowA?.applied_at === null && unspent(rowA) && rowA?.spent_on === 0, rowA);
    check("the payload is the three fields the act needs, and nothing else",
      JSON.stringify(Object.keys(rowA?.payload ?? {}).sort()) ===
      JSON.stringify(["note", "reason_code", "tenant_id"]), rowA?.payload);
    check("the hash on the row is provably the hash of the payload on the row",
      rowA?.payload_sha256 === rowA?.rehash, { stored: rowA?.payload_sha256, rehash: rowA?.rehash });
    check("…so a signature is taken on these bytes, not on a body that can be re-sent",
      rowA?.payload?.note === NOTE && rowA?.payload?.reason_code === "terms_violation"
      && rowA?.payload?.tenant_id === TCA, rowA?.payload);

    const stillOpen = await seatState(TCA);
    check("the company is still trading: a queued ban is not a ban",
      stillOpen?.status === "active" && !stillOpen?.closed, stillOpen);
    check("nothing was revoked", (await liveSessions(TCA)) === 1, await liveSessions(TCA));
    check("the act register is still empty", (await register(TCA)).length === 0, await register(TCA));
    const reopen = await call("/notifications", tokenA);
    check("and the director's token still works", reopen.status === 200, reopen.status);
    check("raising it is audited against the company it names",
      (await auditCount(TCA, "approval.proposed")) === 1, await auditCount(TCA, "approval.proposed"));
    const propAudit = await auditFor(TCA, "approval.proposed");
    check("the audit line carries the payload hash and no decision",
      propAudit?.after?.payload_sha256 === rowA?.payload_sha256
      && propAudit?.after?.reason === REASON && propAudit?.before === null && !propAudit?.after?.decided_by,
      propAudit?.after);

    const dupe = await propose(tok("cmp"), "tenant.block",
      { targetId: TCA, reasonCode: "abuse", reason: "A second seat tries to queue the same ban.", note: NOTE });
    check("a second seat cannot queue a competing ban on the same company",
      dupe.status === 409 && dupe.json?.error?.code === "APPROVAL_OPEN", { s: dupe.status, c: dupe.json?.error?.code });
    const openNow = (await oi(`select id, status, proposed_by from platform_approvals
                                where target_id = $1`, [TCA])).rows;
    check("…and exactly one proposal still stands: the refusal wrote no second one",
      openNow.length === 1 && openNow[0].status === "pending" && openNow[0].id === idA, openNow);

    // ==================================================================
    phase("D · the rule: the seat that raised it cannot sign it");

    const self = await sign(tok("adm"), idA, SIGN_LINE);
    check("the proposer signing its own work is refused",
      self.status === 403 && self.json?.error?.code === "SELF_APPROVAL", { s: self.status, c: self.json?.error?.code });
    check("…and the refusal tells the desk to find a second person",
      /second seat|second person/i.test(self.json?.error?.message ?? ""), self.json?.error?.message);
    const afterSelf = await appr(idA);
    check("the proposal is still pending and the company is untouched",
      afterSelf?.status === "pending" && afterSelf?.decided_by === null && afterSelf?.spent_on === 0, afterSelf);
    check("the company is still trading after the refusal", (await seatState(TCA)).status === "active");

    const byBilling = await sign(tok("bil"), idA, SIGN_LINE);
    check("a seat without the duty is refused before the two-person rule is consulted",
      byBilling.status === 403 && (await appr(idA))?.status === "pending", byBilling.status);

    const tooShort = await sign(tok("cmp"), idA, "yes");
    check("a signature needs a line: three characters is not a decision",
      tooShort.status === 400 && (await appr(idA))?.status === "pending", tooShort.status);

    const signed = await sign(tok("cmp"), idA, SIGN_LINE);
    check("the second seat signs and the ban lands in the same call",
      signed.status === 200 && signed.json?.status === "ok"
      && signed.json?.new_status === "suspended" && signed.json?.prior_status === "active",
      { s: signed.status, b: signed.json });
    check("the answer carries the approval it stood on",
      signed.json?.approval_id === idA, signed.json?.approval_id);
    check("it reports the seats it shut and the people it tried to tell",
      signed.json?.sessions_revoked === 1 && signed.json?.delivery?.recipients === 1
      && !!signed.json?.delivery?.to?.[0]?.email, signed.json?.delivery);
    // Resend has no verified sending domain yet and no aggregator is configured, so on this
    // database a notice is attempted and refused. The register still has to carry the proof
    // of the attempt — that is what "we told you" means later — so `told` below is the check
    // that matters, and the refusal is printed rather than hidden.
    if (!signed.json?.delivery?.email?.sent) {
      console.log(`     (notice attempted, provider refused: ${String(signed.json?.delivery?.errors?.[0] ?? "").slice(0, 150)})`);
    }

    const st = await seatState(TCA);
    check("the company is suspended in the table", st?.status === "suspended" && !st?.closed, st);
    check("every session of the company is revoked", (await liveSessions(TCA)) === 0, await liveSessions(TCA));
    const reg = await register(TCA);
    check("one act row, and it stands on the signature",
      reg.length === 1 && reg[0].action === "block" && reg[0].approval_id === idA
      && reg[0].actor_kind === "control" && reg[0].reason_code === "terms_violation"
      && reg[0].note === NOTE && reg[0].told, reg);
    const spent = await appr(idA);
    check("the proposal is applied, and the effect is written back onto it",
      spent?.status === "applied" && spent?.decided_by === uCMP
      && spent?.decided_role === "compliance_officer" && spent?.decided_note === SIGN_LINE
      && spent?.applied_at !== null && spent?.result?.new_status === "suspended"
      && spent?.result?.sessions_revoked === 1 && spent?.spent_on === 1, spent);
    check("two signatures on one row, and the row still holds one payload hash",
      spent?.proposed_by === uADM && spent?.decided_by === uCMP && spent?.payload_sha256 === rowA?.payload_sha256,
      { proposed_by: spent?.proposed_by, decided_by: spent?.decided_by });

    const hist = await call(`/control/tenants/${TCA}/actions`, null, { headers: ck(tok("adm")) });
    check("the company's own history says which two people a ban stands on",
      hist.status === 200 && hist.json?.actions?.[0]?.raised_by === "Ada Desk"
      && hist.json?.actions?.[0]?.signed_by === "Cie Compliance"
      && !!hist.json?.actions?.[0]?.signed_at, hist.json?.actions?.[0]);

    check("both steps of the signature are audited, one line each",
      (await auditCount(TCA, "approval.proposed")) === 1
      && (await auditCount(TCA, "approval.approve")) === 1
      && (await auditCount(TCA, "tenant.block")) === 1,
      { proposed: await auditCount(TCA, "approval.proposed"), approved: await auditCount(TCA, "approval.approve") });
    const decAudit = await auditFor(TCA, "approval.approve");
    check("the decision's audit row carries the before and the after",
      decAudit?.before?.status === "pending" && decAudit?.before?.proposed_by === uADM
      && decAudit?.after?.status === "approved" && decAudit?.after?.decided_by === uCMP
      && decAudit?.after?.decided_name === "Cie Compliance" && decAudit?.actor_role === "compliance_officer",
      decAudit);
    const blockAudit = await auditFor(TCA, "tenant.block");
    check("…and the act itself is audited by the seat that pressed the button",
      blockAudit?.actor_user_id === uCMP && blockAudit?.after?.approval_id === idA, blockAudit);

    // ==================================================================
    phase("E · what a signed-out company feels, and what a signature cannot be re-spent");

    const gated = await call("/notifications", tokenA);
    check("the token that worked a minute ago is refused by the gate",
      gated.status === 403 && gated.json?.error?.code === "TENANT_BLOCKED", { s: gated.status, c: gated.json?.error?.code });
    check("the refusal is the note the second seat signed",
      /suspended by the WAISHA office/.test(gated.json?.error?.message ?? "")
      && gated.json?.error?.message.includes(NOTE), gated.json?.error?.message);
    await clearBuckets("login:");
    const refused = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN_A, email: EMAIL_A, password: PASSWORD })
    });
    check("the right password does not open a company two people shut",
      refused.status === 403 && refused.json?.error?.code === "TENANT_BLOCKED", refused.status);
    check("a refused sign-in on a blocked company is audited",
      (await auditCount(TCA, "auth.login_blocked")) === 1, await auditCount(TCA, "auth.login_blocked"));

    const resign = await sign(tok("cmp"), idA, SIGN_LINE);
    check("a signature cannot be spent twice",
      resign.status === 409 && resign.json?.error?.code === "APPROVAL_OPEN", { s: resign.status, c: resign.json?.error?.code });
    check("…and the refusal says which state it is already in",
      /already been decided/.test(resign.json?.error?.message ?? ""), resign.json?.error?.message);
    const notSpent = await appr(idA);
    check("the register still holds exactly one act for that signature",
      notSpent?.status === "applied" && notSpent?.spent_on === 1, notSpent);

    const reblock = await propose(tok("cmp"), "tenant.block",
      { targetId: TCA, reasonCode: "abuse", reason: REASON, note: NOTE });
    check("no ban is queued for a company that is already blocked",
      reblock.status === 409 && /already blocked/.test(reblock.json?.error?.message ?? ""),
      { s: reblock.status, m: reblock.json?.error?.message });

    const unblock = await call(`/control/tenants/${TCA}/unblock`, null, {
      method: "POST", headers: ck(tok("adm")),
      body: JSON.stringify({ reasonCode: "other", note: "The licence was renewed out of band; opened again." })
    });
    check("reopening a company still needs one seat, not two",
      unblock.status === 200 && unblock.json?.new_status === "active", { s: unblock.status, b: unblock.json });
    const regU = await register(TCA);
    check("the unblock stands on no signature, because nothing demanded one",
      regU.length === 2 && regU[1].action === "unblock" && regU[1].approval_id === null, regU[1]);
    const boardAfter = await call("/control/approvals?limit=100", null, { headers: ck(tok("adm")) });
    check("the applied proposal is still on the board, with both names",
      boardAfter.status === 200 && (boardAfter.json?.rows ?? []).some((r: any) =>
        r.id === idA && r.approval_status === "applied" && r.proposed_name === "Ada Desk"
        && r.decided_name === "Cie Compliance" && r.target_name === COMPANY_A),
      (boardAfter.json?.rows ?? []).filter((r: any) => r.target_id === TCA).map((r: any) => r.approval_status));

    // ==================================================================
    phase("F · a refusal is a decision, and nothing happens afterwards");

    const closeP = await propose(tok("cmp"), "tenant.close",
      { targetId: TCB, reasonCode: "payment_default", reason: CLOSE_REASON, note: CLOSE_NOTE });
    const idB = closeP.json?.approval_id ?? "";
    check("a close can be raised by either seat", closeP.status === 200 && !!idB, { s: closeP.status, b: closeP.json });

    const refusedByOther = await sign(tok("adm"), idB, REFUSE_LINE, "reject");
    check("the other seat refuses it: 200, and the proposal is rejected",
      refusedByOther.status === 200 && refusedByOther.json?.approval_status === "rejected"
      && refusedByOther.json?.decided_name === "Ada Desk", { s: refusedByOther.status, b: refusedByOther.json });
    const stB = await seatState(TCB);
    check("a refusal changes nothing about the company",
      stB?.status === "active" && !stB?.closed, stB);
    check("…and writes no act row", (await register(TCB)).length === 0, await register(TCB));
    const rowB = await appr(idB);
    check("the rejected signature cannot be spent: no result, no application",
      rowB?.status === "rejected" && rowB?.applied_at === null && unspent(rowB)
      && rowB?.spent_on === 0 && rowB?.decided_note === REFUSE_LINE, rowB);
    check("refusing is audited as its own act",
      (await auditCount(TCB, "approval.reject")) === 1, await auditCount(TCB, "approval.reject"));
    const afterReject = await sign(tok("adm"), idB, SIGN_LINE);
    check("signing a refused proposal afterwards is a 409, not a second chance",
      afterReject.status === 409 && (await seatState(TCB)).status === "active", afterReject.status);

    const freeSlot = await propose(tok("adm"), "tenant.close",
      { targetId: TCB, reasonCode: "payment_default", reason: "A fresh close after the refusal.", note: CLOSE_NOTE });
    check("a refused proposal frees the slot: the desk can ask again",
      freeSlot.status === 200 && freeSlot.json?.approval_id !== idB, freeSlot.status);

    // ==================================================================
    phase("G · a signature nobody collected lapses");

    const idC = freeSlot.json?.approval_id ?? "";
    await oi(`update platform_approvals set proposed_at = now() - interval '8 days',
                    created_at = now() - interval '8 days',
                    expires_at = now() - interval '1 hour' where id = $1`, [idC]);
    // A window that has passed is discovered by whoever asks first, and both doors answer
    // the same way: a signature attempt refuses with 410 and marks the row, the board sweeps
    // and marks the row. Read in that order, because once the board has looked, the row is
    // already lapsed and a second attempt is a refusal on a decided proposal — 409, not 410.
    const lapseSign = await sign(tok("cmp"), idC, SIGN_LINE);
    check("signing a proposal whose window has passed is a 410, whatever the desk believes",
      lapseSign.status === 410 && lapseSign.json?.error?.code === "APPROVAL_LAPSED",
      { s: lapseSign.status, c: lapseSign.json?.error?.code });
    check("a lapsed signature cannot close a company", (await seatState(TCB)).status === "active");
    check("…and leaves no act row behind", (await register(TCB)).length === 0);
    const rowC = await appr(idC);
    check("the attempt itself marked the row lapsed: nobody decided it, nothing applied",
      rowC?.status === "lapsed" && rowC?.proposed_by === uADM && rowC?.decided_by === null
      && rowC?.applied_at === null && rowC?.spent_on === 0, rowC);
    const lapsedBoard = await call("/control/approvals?limit=100", null, { headers: ck(tok("cmp")) });
    const lapsedRow = (lapsedBoard.json?.rows ?? []).find((r: any) => r.id === idC);
    check("the board reports the same state the refusal acted on",
      lapsedBoard.status === 200 && lapsedRow?.approval_status === "lapsed", lapsedRow?.approval_status);
    const lapsedDetail = await call(`/control/approvals/${idC}`, null, { headers: ck(tok("cmp")) });
    check("…and so does the deep link", lapsedDetail.json?.approval_status === "lapsed",
      lapsedDetail.json?.approval_status);
    const afterLapse = await sign(tok("cmp"), idC, SIGN_LINE);
    check("a second attempt on a row the register already knows is lapsed is a 409",
      afterLapse.status === 409 && afterLapse.json?.error?.code === "APPROVAL_OPEN", afterLapse.status);
    // The load-bearing consequence of the 410 marking the row: one open proposal per act
    // per target is what `approvals_one_open` enforces, so an expired row that still claimed
    // to be pending would keep the slot and answer the next seat "already open" for a
    // signature nobody can give. The rollback inside the transaction used to do exactly that.
    const slotFreed = await propose(tok("cmp"), "tenant.close",
      { targetId: TCB, reasonCode: "payment_default", reason: "Asked again, after the first window passed.", note: CLOSE_NOTE });
    check("a lapsed proposal frees the slot it held, so the desk can ask again",
      slotFreed.status === 200 && !!slotFreed.json?.approval_id,
      { s: slotFreed.status, m: slotFreed.json?.error?.message });

    // ==================================================================
    phase("H · the register's own refusals");

    const onDesk = await propose(tok("adm"), "tenant.block",
      { targetId: CT, reasonCode: "abuse", reason: REASON, note: NOTE });
    check("the platform desk cannot be banned from the desk",
      onDesk.status === 400 && /company account/.test(onDesk.json?.error?.message ?? ""), onDesk.json?.error?.message);
    const onSeeker = await propose(tok("adm"), "tenant.block",
      { targetId: CS, reasonCode: "abuse", reason: REASON, note: NOTE });
    check("a seeker account is not a company and is refused", onSeeker.status === 400, onSeeker.status);
    const ghost = await propose(tok("adm"), "tenant.block",
      { targetId: randomUUID(), reasonCode: "abuse", reason: REASON, note: NOTE });
    check("a company that does not exist is a 404", ghost.status === 404, ghost.status);
    const badReason = await propose(tok("adm"), "tenant.block",
      { targetId: TCB, reasonCode: "because_i_said_so" as any, reason: REASON, note: NOTE });
    check("an invented reason code is refused before the register is written",
      badReason.status === 400, badReason.status);

    const filters = await call(
      `/control/approvals?action=tenant.close&status=lapsed&limit=50`, null, { headers: ck(tok("adm")) });
    const closes = (filters.json?.rows ?? []).filter((r: any) => r.target_id === TCB);
    check("the board filters by action and status and finds the lapsed close",
      filters.status === 200 && closes.length === 1 && closes[0].id === idC, closes);
    const search = await call(`/control/approvals?q=${encodeURIComponent("outside your licence")}`, null,
      { headers: ck(tok("adm")) });
    check("the search box reads the note the company was sent",
      (search.json?.rows ?? []).some((r: any) => r.id === idA), (search.json?.rows ?? []).length);
    const reasonSearch = await call(`/control/approvals?q=${encodeURIComponent("in one month")}`, null,
      { headers: ck(tok("adm")) });
    check("…and the sentence the second seat was asked to sign",
      (reasonSearch.json?.rows ?? []).some((r: any) => r.id === idA), (reasonSearch.json?.rows ?? []).length);
    const byIdSearch = await call(`/control/approvals?q=${encodeURIComponent(COMPANY_B)}`, null,
      { headers: ck(tok("adm")) });
    check("…and the company's name", (byIdSearch.json?.rows ?? []).every((r: any) => r.target_id === TCB),
      (byIdSearch.json?.rows ?? []).map((r: any) => r.target_name));
    const paged = await call("/control/approvals?limit=1&offset=0", null, { headers: ck(tok("adm")) });
    check("pagination holds: one row asked, one row returned",
      paged.status === 200 && paged.json?.rows?.length <= 1, paged.json?.rows?.length);
    const tooMany = await call("/control/approvals?limit=5000", null, { headers: ck(tok("adm")) });
    check("a desk cannot ask the board for the whole register at once", tooMany.status === 400, tooMany.status);

    const detail = await call(`/control/approvals/${idA}`, null, { headers: ck(tok("cmp")) });
    check("one proposal by id, for a deep link",
      detail.status === 200 && detail.json?.action === "tenant.block"
      && detail.json?.proposed_name === "Ada Desk" && detail.json?.decided_name === "Cie Compliance"
      && detail.json?.target_name === COMPANY_A && detail.json?.payload?.note === NOTE, detail.json);
    check("…and the same payload hash on every surface that shows it",
      detail.json?.payload_sha256 === rowA?.payload_sha256, detail.json?.payload_sha256);

    const buckets = (await oi(`select bucket from rate_limits where bucket like 'approvals-%'`)).rows;
    check("the register's own limiters are counting", buckets.length > 0, buckets.map((b: any) => b.bucket));

    // ==================================================================
    phase("I · what must never reach a client");

    const blob = bodies.join("\n");
    const leaked = LEAK_MARKERS.filter((m) => blob.includes(m));
    check("no credential column, engine error, stack frame or working copy in any response",
      leaked.length === 0, leaked);
    const echoed = approvalBodies.join("\n");
    check("an approval response does not echo a director's address or phone",
      !echoed.includes(EMAIL_A) && !echoed.includes(PHONE_A) && !echoed.includes(PHONE_B),
      { email: echoed.includes(EMAIL_A), phone: echoed.includes(PHONE_A) });
    check("what the desk sees instead is the masked receipt",
      echoed.includes("a***@waisha.test"), echoed.match(/"email":\{[^}]*\}/)?.[0]);
    check("no seat's email address is in the register's own answers",
      !echoed.includes(`appr.desk.comp.${STAMP}@waisha.test`), echoed.match(/desk[^"]*waisha\.test/)?.[0]);

    // ==================================================================
    phase("J · the doors are the only way in");

    // The dev DSN hands us the owner role, so rebuild the runtime DSN the way
    // verify-privileges-sql does: keep the pooler's resource ref, swap the login.
    const appUrl = new URL(process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL!);
    if (!appUrl.username.startsWith("app_runtime")) {
      const ref = appUrl.username.split(".")[1];
      appUrl.username = "app_runtime" + (ref ? "." + ref : "");
      appUrl.password = encodeURIComponent(process.env.APP_DB_PASSWORD ?? "");
    }
    const runtime = new pg.Client({ connectionString: appUrl.toString(), ssl: { rejectUnauthorized: false } });
    await runtime.connect();
    const readable = await runtime.query(
      `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'platform_approvals'
          and has_table_privilege('app_runtime', c.oid, 'select')`);
    check("app_runtime cannot read the register table directly", !readable.rowCount, readable.rows);
    const pubExec = await runtime.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'platform_auth'
          and p.proname in ('propose_approval','decide_approval','claim_approval','settle_approval',
                             'approvals_board','approval_detail','count_open_approvals',
                             'approval_seat','action_needs_two_seats')
          and has_function_privilege('public', p.oid, 'execute')`).catch(() => null);
    check("and none of the register's functions are executable by PUBLIC",
      !pubExec?.rows.length, pubExec?.rows?.map((r: any) => r.proname));
    await runtime.end();
  } finally {
    // ==================================================================
    phase("teardown");
    await clearBuckets("login:", "signup:", "otp:", "tenant-action:", "approvals-", "internal-tick:");
    await wipeApprovals();
    await wipeTenants(tids.filter(Boolean));
    const left = await oi(
      `select (select count(*)::int from tenants where name like $1) as tenants,
              (select count(*)::int from platform_approvals
                where proposed_by = any($2::uuid[]) or decided_by = any($2::uuid[])) as approvals,
              (select count(*)::int from tenant_actions where tenant_id = any($3::uuid[])) as actions,
              (select count(*)::int from audit_logs where tenant_id = any($3::uuid[])
                 or actor_user_id = any($2::uuid[])) as audit,
              (select count(*)::int from sessions where tenant_id = any($3::uuid[])) as sessions,
              (select count(*)::int from users where id = any($2::uuid[])) as seats,
              (select count(*)::int from rate_limits where bucket like 'approvals-%') as buckets`,
      [NAME_SWEEP, seats, tids.filter(Boolean)]);
    check("no fixture company, proposal, act row, session, seat or bucket is left behind",
      left.rows[0].tenants === 0 && left.rows[0].approvals === 0 && left.rows[0].actions === 0
      && left.rows[0].sessions === 0 && left.rows[0].seats === 0 && left.rows[0].buckets === 0,
      left.rows[0]);
    console.log(`     (${left.rows[0].audit} audit lines this run wrote stay in the register: 001 makes audit_logs append-only, so a suite cannot erase its own paper trail.)`);
    const after = new Set<string>(((await oi(`select platform_auth.tenant_suspensions() as s`))
      .rows[0].s as any[]).map((x: any) => x.tenant_id));
    check("the gate holds exactly the companies it held before this run",
      !after.has(TCA) && !after.has(TCB) && [...after].every((t) => baseline.has(t)),
      { now: [...after], before: [...baseline] });
    if (after.size > baseline.size || !baseline.size) {
      console.log(`     (${baseline.size} companies were already shut on this database before the probe ran.)`);
    }
    await owner.end();
  }

  console.log(`\n${failures ? "FAILURES: " + failures : "all approval-desk checks passed"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
