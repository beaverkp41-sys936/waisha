/**
 * #127 — the seats a company paid for, and what the office can do to the company.
 *
 * Two halves of one complaint. The first is the bug the user hit: a company moved from
 * Starter to Enterprise and still had one seat, because 068 kept whichever seat count was
 * already on the subscription row and the legacy 1 always won. That is proved here over
 * HTTP rather than in SQL: buy Enterprise, read the licence back, and only then try the
 * invite that used to be refused.
 *
 * The second half is the register. Block, unblock, notice and close all go through
 * `platform_auth.tenant_apply_action`, so this suite is mostly read-backs: after a block,
 * does the status say suspended, are the sessions revoked with the right reason, is there
 * a register row with a delivery receipt on it, is there an audit row, does the token that
 * worked a second ago now get refused by the gate, does the correct password still fail at
 * the door with the reason in the sentence, and does a second block answer 409 instead of
 * writing a second suspension.
 *
 * Since 121 the two bans are no longer buttons. A block is raised as a proposal on
 * `/control/approvals` and only reaches `tenant_apply_action` when a second seat has signed
 * it, so phase B walks that chain — raise, try to sign one's own work, have the compliance
 * seat sign — and asserts that the act row carries the approval it stands on. What this
 * file still owns directly is the pair one person may take alone: reopening a company and
 * sending it a message. The idle clock writes its own bans with no signature at all, which
 * is exactly what phase F proves: a timer is a `system` actor, not a person avoiding the
 * rule.
 *
 * The idle clock (45 days to block, 90 to close) is driven on a SECOND company, because an
 * unblock makes a company invisible to the candidate query until a *later* lapse — so one
 * fixture cannot be blocked by the clock and then used to prove the clock still runs. The
 * sweep is a global function: before the smoke POSTs it, it reads the candidate list and
 * refuses to proceed if any tenant that is not a fixture is in it. A test suite must never
 * be the thing that shuts a real company down.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-tenant-actions.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { encryptField, searchHash, sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";

const STAMP = Date.now().toString().slice(-8);
const COMPANY_A = `Actions Smoke Alpha ${STAMP} Ltd`;
const COMPANY_B = `Actions Smoke Bravo ${STAMP} Ltd`;
const DESK = `Actions Smoke Desk ${STAMP}`;
const SEEKER = `Actions Smoke Seeker ${STAMP}`;
const EMAIL_A = `act.smoke.a.${STAMP}@waisha.test`;
const EMAIL_B = `act.smoke.b.${STAMP}@waisha.test`;
const TIN_A = `9${STAMP}`;
const TIN_B = `8${STAMP}`;
const PHONE_A = `+2557${STAMP}`;
const PHONE_B = `+2556${STAMP}`;
const PASSWORD = `Ta-${STAMP}-R7!x`;
const NAME_SWEEP = `Actions Smoke %`;
const NOTE = "The company posted freight it was not licensed to carry, twice.";
const NOTE_B = "No paid licence has been recorded for this company since the renewal lapsed.";
const SIGN_LINE = "Yes. I read the file: block it.";

const LEAK_MARKERS = [
  "password_hash", "token_hash", "code_hash", "ntra_encrypted", "nida_encrypted",
  "phone_encrypted", "totp_secret", "syntax error at or near", "duplicate key value violates",
  "Postgres", "node_modules", "at Object.<anonymous>", "FastifyError"
];

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const bodies: string[] = [];
/** Only the action routes' bodies: a contact is legitimate in a signup echo, not here. */
const actionBodies: string[] = [];
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
  if (init.method === "POST" && (path.startsWith("/control/tenants/") || path.startsWith("/control/approvals")))
    actionBodies.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

const ck = (who: string) => ({ Cookie: `waisha_control=${who}` });
const cookieOf = (h: Headers) =>
  (typeof h.getSetCookie === "function" ? h.getSetCookie() : [])
    .find((c) => c.startsWith("waisha_refresh="))?.split(";")[0] ?? "";

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

  /** Scoped to the fixture tenants only — never to a tenant id collected from a query. */
  const wipeTenants = async (tids: string[]) => {
    if (!tids.length) return;
    for (const t of WIPE) {
      await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    }
    await oi(`delete from alert_reads where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from documents where entity_type = 'user' and entity_id in
             (select id from users where tenant_id = any($1::uuid[]))`, [tids]).catch(() => { });
    await oi(`delete from user_roles where user_id in
             (select id from users where tenant_id = any($1::uuid[]))`, [tids]).catch(() => { });
    await oi(`delete from roles where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from tenants where id = any($1::uuid[])`, [tids]);
  };

  // Pre-clean an earlier aborted run; fixture names carry the stamp, so this only ever
  // matches smoke companies.
  const stale = (await oi(`select id from tenants where name like $1`, [NAME_SWEEP]))
    .rows.map((r: any) => r.id);
  // 121 put a signature in front of a ban, so an aborted run leaves proposals behind too.
  // The act rows go first: an approval is referenced by the act it released.
  await oi(`delete from tenant_actions where tenant_id = any($1::uuid[])`, [stale]).catch(() => { });
  await oi(`delete from platform_approvals where target_id = any($1::text[])`, [stale]).catch(() => { });
  await wipeTenants(stale);
  await clearBuckets("login:", "signup:", "otp:", "tenant-action:", "tenant-sweep:",
    "internal-tick:", "activate:uid:", "approvals-", "ip:");

  // The gate's snapshot is not empty on a development database — the office has shut
  // companies by hand here, and those rows are other people's work. Anything asserted below
  // about which companies are shut is therefore measured against what this run found,
  // never against zero.
  const baselineSusp = new Set<string>(((await oi(
    `select platform_auth.tenant_suspensions() as s`)).rows[0].s as any[])
    .map((x: any) => x.tenant_id));

  const roleRows = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "billing_admin", "compliance_officer", "director"]]
  )).rows;
  const rid = (k: string) => roleRows.find((r: any) => r.key === k)?.id;
  if (!rid("super_admin") || !rid("billing_admin") || !rid("compliance_officer")) {
    throw new Error("global platform roles missing");
  }
  const planId = async (key: string) =>
    (await oi(`select id from plans where key = $1`, [key])).rows[0]?.id;

  const CT = randomUUID();     // the platform desk
  const CS = randomUUID();     // a seeker account, which the desk must not be able to act on
  const uADM = randomUUID();   // super admin: holds control.tenants.manage
  const uBIL = randomUUID();   // billing admin: sells licences, may not shut companies
  const uCMP = randomUUID();   // compliance officer: 078 gave this duty to the role
  const tok = (who: string) => `act-smoke-${who}-${STAMP}`;

  let TCA = "";   // company alpha (made by the real signup below)
  let dirA = "";
  let TCB = "";   // company beta, for the idle clock
  let dirB = "";
  let tokenA = "";
  let refreshA = "";

  const revokeCount = async (tid: string) => (await oi(
    `select count(*)::int as n from sessions where tenant_id = $1 and revoked_at is null`,
    [tid])).rows[0].n;
  const register = async (tid: string) => (await oi(
    `select action, reason_code, actor_kind, note, prior_status, new_status, approval_id,
            delivery <> '{}'::jsonb as told
       from tenant_actions where tenant_id = $1 order by created_at`, [tid])).rows;
  const approvals = async (tid: string) => (await oi(
    `select status, action, proposed_by, decided_by, payload_sha256
       from platform_approvals where target_id = $1 order by created_at`, [tid])).rows;
  const seatState = async (tid: string) => (await oi(
    `select t.status, t.deleted_at is not null as closed,
            (select s.seats_licensed from subscriptions s
              where s.tenant_id = t.id and s.deleted_at is null limit 1) as seats,
            (select p.key from subscriptions s join plans p on p.id = s.plan_id
              where s.tenant_id = t.id and s.deleted_at is null limit 1) as plan
       from tenants t where t.id = $1`, [tid])).rows[0];
  const auditRow = async (tid: string, action: string) => (await oi(
    `select after from audit_logs where tenant_id = $1 and entity = $2 and action = $3
      order by ts desc limit 1`,
    [tid, action.startsWith("auth.") ? "auth" : "tenants", action])
  ).rows[0]?.after;

  /** A ban is raised, not pressed (121): propose it, then have the other seat sign it. */
  const proposeBlock = (token: string, targetId: string, reasonCode: string, note: string, reason = NOTE) =>
    call("/control/approvals", null, {
      method: "POST", headers: ck(token),
      body: JSON.stringify({ action: "tenant.block", targetId, reasonCode, reason, note })
    });
  const signApproval = (token: string, id: string, note = SIGN_LINE, verb = "approve") =>
    call(`/control/approvals/${id}/${verb}`, null, {
      method: "POST", headers: ck(token), body: JSON.stringify({ note })
    });

  try {
    // ==================================================================
    phase("A · fixtures and the seat ladder the user could not climb");

    const signupA = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: COMPANY_A, tin: TIN_A, phone: PHONE_A, email: EMAIL_A,
        password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true
      })
    });
    dirA = signupA.json?.userId ?? "";
    TCA = (await oi(`select tenant_id from users where id = $1`, [dirA])).rows[0]?.tenant_id ?? "";
    check("company alpha signed up for real", signupA.status === 201 && !!TCA, { s: signupA.status });

    const signupB = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: COMPANY_B, tin: TIN_B, phone: PHONE_B, email: EMAIL_B,
        password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true
      })
    });
    dirB = signupB.json?.userId ?? "";
    TCB = (await oi(`select tenant_id from users where id = $1`, [dirB])).rows[0]?.tenant_id ?? "";
    check("company beta signed up for real", signupB.status === 201 && !!TCB, { s: signupB.status });

    await oi(`insert into tenants (id, type, name, status) values
        ($1,'platform',$2,'active'), ($3,'seeker',$4,'active')`, [CT, DESK, CS, SEEKER]);
    await oi(`insert into users (id, tenant_id, user_type, full_name, email,
             email_normalized_search, status, totp_enabled)
       values ($1,$2,'platform','Ada Desk',$3,$4,'active',false),
              ($5,$2,'platform','Ben Billing',$6,$7,'active',false),
              ($8,$2,'platform','Cie Compliance',$9,$10,'active',false)`,
      [uADM, CT, `act.desk.admin.${STAMP}@waisha.test`, searchHash(`act.desk.admin.${STAMP}@waisha.test`),
      uBIL, `act.desk.billing.${STAMP}@waisha.test`, searchHash(`act.desk.billing.${STAMP}@waisha.test`),
      uCMP, `act.desk.comp.${STAMP}@waisha.test`, searchHash(`act.desk.comp.${STAMP}@waisha.test`)]);
    await oi(`insert into user_roles (user_id, role_id) values
        ($1,$2), ($3,$4), ($5,$6)`,
      [uADM, rid("super_admin"), uBIL, rid("billing_admin"), uCMP, rid("compliance_officer")]);
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
            refresh_token_hash, user_agent, ip, expires_at)
         values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-tenant-actions','127.0.0.1',
                 now() + interval '2 hours'),
                ($6,$7,$3,$8, now() + interval '2 hours', $9,'smoke-tenant-actions','127.0.0.1',
                 now() + interval '2 hours'),
                ($10,$11,$3,$12, now() + interval '2 hours', $13,'smoke-tenant-actions','127.0.0.1',
                 now() + interval '2 hours')`,
      [randomUUID(), uADM, CT, randomUUID(), sha256(tok("adm")),
      randomUUID(), uBIL, randomUUID(), sha256(tok("bil")),
      randomUUID(), uCMP, randomUUID(), sha256(tok("cmp"))]);

    // Verification is what makes a signed-up company real: active tenant, active director,
    // the director duty, and the licence the office sold. Alpha is the stuck case: Starter
    // on paper, one seat on the row.
    await oi(`update tenants set status = 'active' where id = any($1::uuid[])`, [[TCA, TCB]]);
    await oi(`update users set status = 'active', phone_encrypted = $2, phone_search = $3
               where id = any($1::uuid[])`, [[dirA, dirB], encryptField(PHONE_A), searchHash(PHONE_A)]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2), ($3,$4)`,
      [dirA, rid("director"), dirB, rid("director")]);
    await oi(`insert into subscriptions (tenant_id, plan_id, billing_cycle, status, seats_licensed,
             current_period_start, current_period_end)
       values ($1,$2,'monthly','active',1, now(), now() + interval '30 days'),
              ($3,$2,'monthly','active',1, now() - interval '46 days', now() - interval '46 days')`,
      [TCA, await planId("starter"), TCB]);
    await oi(`update tenants set licence_expires_at = now() + interval '30 days' where id = $1`, [TCA]);
    await oi(`update tenants set licence_expires_at = now() - interval '46 days' where id = $1`, [TCB]);

    check("alpha starts on one licensed seat",
      (await seatState(TCA)).seats === 1, await seatState(TCA));

    const loginA = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN_A, email: EMAIL_A, password: PASSWORD })
    });
    tokenA = loginA.json?.accessToken ?? "";
    refreshA = cookieOf(loginA.headers);
    check("a director signs in with a real password", loginA.status === 200 && !!tokenA && !!refreshA, loginA.status);

    const overSeat = await call("/users", tokenA, {
      method: "POST", body: JSON.stringify({
        fullName: "Third Hand", email: `act.staff.${STAMP}@waisha.test`, roleKeys: ["dispatcher"]
      })
    });
    check("one seat, so the second invite is refused",
      overSeat.status === 403 && overSeat.json?.error?.code === "TRIAL_LIMIT",
      { s: overSeat.status, c: overSeat.json?.error?.code });
    check("the refusal counts seats in words a person reads",
      /1 user\b/.test(overSeat.json?.error?.message ?? "") && !/1 users/.test(overSeat.json?.error?.message ?? ""),
      overSeat.json?.error?.message);

    const toEnterprise = await call("/control/tenants/" + TCA + "/activate", null, {
      method: "POST", headers: ck(tok("adm")),
      body: JSON.stringify({ planKey: "enterprise", billingCycle: "monthly", provider: "bank" })
    });
    check("the desk sells Enterprise", toEnterprise.status === 200 && toEnterprise.json?.seats === 100,
      { s: toEnterprise.status, b: toEnterprise.json });
    const afterUp = await seatState(TCA);
    check("the licence now carries the 100 seats that were paid for",
      afterUp.seats === 100 && afterUp.plan === "enterprise", afterUp);

    const backDown = await call("/control/tenants/" + TCA + "/activate", null, {
      method: "POST", headers: ck(tok("adm")),
      body: JSON.stringify({ planKey: "starter", billingCycle: "monthly", provider: "bank" })
    });
    check("re-selling a lower rung does not cut seats mid-term",
      backDown.status === 200 && (await seatState(TCA)).seats === 100, await seatState(TCA));

    const invite = await call("/users", tokenA, {
      method: "POST", body: JSON.stringify({
        fullName: "Third Hand", email: `act.staff.${STAMP}@waisha.test`, roleKeys: ["dispatcher"]
      })
    });
    check("the same invite succeeds on the upgraded licence", invite.status === 201, { s: invite.status, b: invite.json });
    const roster = await call("/users", tokenA);
    check("the roster reports the ceiling the licence actually holds",
      roster.json?.seatLimit === 100 && roster.json?.seatsUsed === 2,
      { limit: roster.json?.seatLimit, used: roster.json?.seatsUsed });

    const listed = await call("/control/tenants?q=" + encodeURIComponent(COMPANY_A), null, { headers: ck(tok("adm")) });
    const rowA = (listed.json ?? []).find?.((r: any) => r.tenant_id === TCA);
    check("the desk list shows the seats, the rung and the members",
      listed.status === 200 && rowA?.seats_licensed === 100 && rowA?.plan_seats === 5 && rowA?.members === 2,
      rowA);

    // ==================================================================
    phase("B · the block, and everything the register has to remember");

    check("alpha holds a live session before the block", (await revokeCount(TCA)) === 1, await revokeCount(TCA));
    const before = await call("/notifications", tokenA);
    check("the gate is quiet while the company is trading", before.status === 200, before.status);

    const raised = await proposeBlock(tok("adm"), TCA, "terms_violation", NOTE);
    const approvalId = raised.json?.approval_id ?? "";
    check("a block is raised as a proposal, and the answer says it is only pending",
      raised.status === 200 && raised.json?.status === "ok"
      && raised.json?.approval_status === "pending" && !!approvalId, { s: raised.status, b: raised.json });
    check("a pending proposal changes nothing: the company trades and its seat stays live",
      (await seatState(TCA)).status === "active" && (await revokeCount(TCA)) === 1
      && (await register(TCA)).length === 0, await seatState(TCA));

    const selfSign = await signApproval(tok("adm"), approvalId);
    check("the seat that raised a ban is refused when it signs its own work",
      selfSign.status === 403 && selfSign.json?.error?.code === "SELF_APPROVAL",
      { s: selfSign.status, c: selfSign.json?.error?.code });
    check("…and the company is still trading after the refusal",
      (await seatState(TCA)).status === "active" && (await register(TCA)).length === 0);
    const byBilling = await signApproval(tok("bil"), approvalId);
    check("a seat with no duty over the register cannot sign either",
      byBilling.status === 403 && (await register(TCA)).length === 0, byBilling.status);

    const block = await signApproval(tok("cmp"), approvalId);
    check("the second seat signs and the block lands: 200, suspended, and it says how many seats it shut",
      block.status === 200 && block.json?.status === "ok" && block.json?.new_status === "suspended"
      && block.json?.prior_status === "active" && block.json?.approval_id === approvalId,
      { s: block.status, b: block.json });
    check("the block reports the sessions it revoked",
      block.json?.sessions_revoked === 1, block.json?.sessions_revoked);
    // Resend has no verified sending domain and no SMS aggregator is configured, so on this
    // database a notice is attempted and refused. What the register must still carry is the
    // proof of the attempt — that is what "we told you" means a month later — so the check is
    // on the masked target list, and the provider's refusal is printed rather than hidden.
    check("the block tried to tell the one director the company has, and says so",
      block.json?.delivery?.recipients === 1 && !!block.json?.delivery?.to?.[0]?.email,
      block.json?.delivery);
    if (!block.json?.delivery?.email?.sent) {
      console.log(`     (notice attempted, provider refused: ${String(block.json?.delivery?.errors?.[0] ?? "").slice(0, 150)})`);
    }

    const stB = await seatState(TCA);
    check("the company is suspended in the table", stB.status === "suspended" && !stB.closed, stB);
    check("every session of the company is revoked", (await revokeCount(TCA)) === 0, await revokeCount(TCA));
    const revReason = (await oi(
      `select revoked_reason from sessions where tenant_id = $1`, [TCA])).rows[0]?.revoked_reason;
    check("the revocations are stamped for the block, not left blank",
      revReason === "tenant_blocked", revReason);
    const regB = await register(TCA);
    check("the register holds the block with its reason, its note and the signature it stands on",
      regB.length === 1 && regB[0].action === "block" && regB[0].reason_code === "terms_violation"
      && regB[0].actor_kind === "control" && regB[0].note === NOTE && regB[0].told
      && regB[0].approval_id === approvalId, regB);
    const apprB = await approvals(TCA);
    check("the proposal is applied, spent by the seat that signed it, not by the one that raised it",
      apprB.length === 1 && apprB[0].status === "applied" && apprB[0].proposed_by === uADM
      && apprB[0].decided_by === uCMP, apprB);
    const histB = await call(`/control/tenants/${TCA}/actions`, null, { headers: ck(tok("adm")) });
    check("the company's history names both people without anybody asking for a join",
      histB.status === 200 && histB.json?.actions?.[0]?.raised_by === "Ada Desk"
      && histB.json?.actions?.[0]?.signed_by === "Cie Compliance", histB.json?.actions?.[0]);
    const audB = await auditRow(TCA, "tenant.block");
    check("the audit row names the reason and the action",
      audB?.reason_code === "terms_violation" && audB?.new_status === "suspended"
      && audB?.sessions_revoked === 1, audB);

    const gated = await call("/notifications", tokenA);
    check("the token that worked a second ago is refused by the gate",
      gated.status === 403 && gated.json?.error?.code === "TENANT_BLOCKED", { s: gated.status, c: gated.json?.error?.code });
    check("the refusal is a sentence, not a code",
      /suspended by the WAISHA office/.test(gated.json?.error?.message ?? "")
      && gated.json?.error?.message.includes(NOTE), gated.json?.error?.message);
    const me = await call("/auth/me", tokenA);
    check("the door itself stays open so a support call can still identify the seat",
      me.status === 200, me.status);
    const refreshed = await call("/auth/refresh", null, { method: "POST", headers: { Cookie: refreshA } });
    check("a revoked session cannot be refreshed back into service",
      refreshed.status === 401, refreshed.status);

    await clearBuckets("login:");
    const blockedLogin = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN_A, email: EMAIL_A, password: PASSWORD })
    });
    check("the right password still does not open a blocked company",
      blockedLogin.status === 403 && blockedLogin.json?.error?.code === "TENANT_BLOCKED",
      { s: blockedLogin.status, c: blockedLogin.json?.error?.code });
    check("the refusal at the door names the reason the office gave",
      /breach of the WAISHA terms/.test(blockedLogin.json?.error?.message ?? ""),
      blockedLogin.json?.error?.message);
    const audL = await auditRow(TCA, "auth.login_blocked");
    check("a refused sign-in on a blocked company is audited",
      audL?.reason_code === "terms_violation", audL);

    const again = await proposeBlock(tok("cmp"), TCA, "abuse", "A second block on a company already shut.");
    check("a second block answers 409 before a signature is collected, and writes no second suspension",
      again.status === 409 && again.json?.error?.code === "APPROVAL_OPEN"
      && /already blocked/.test(again.json?.error?.message ?? "")
      && (await register(TCA)).length === 1 && (await approvals(TCA)).length === 1,
      { s: again.status, c: again.json?.error?.code, n: (await register(TCA)).length });

    // ==================================================================
    phase("C · a notice changes nothing but is still on the record");

    const notice = await call(`/control/tenants/${TCA}/notice`, null, {
      method: "POST", headers: ck(tok("cmp")),
      body: JSON.stringify({ reasonCode: "complaint", note: "A client complaint is open against this company." })
    });
    check("notice → 200 and the status is exactly as it was",
      notice.status === 200 && notice.json?.new_status === "suspended"
      && notice.json?.prior_status === "suspended",
      { s: notice.status, b: notice.json });
    check("a notice revokes nothing", notice.json?.sessions_revoked === 0, notice.json?.sessions_revoked);
    const regC = await register(TCA);
    check("the register now holds the notice beside the block",
      regC.length === 2 && regC[1].action === "notice" && regC[1].reason_code === "complaint"
      && regC[1].actor_kind === "control", regC);
    check("a compliance officer can act: 078 gave the duty to the role",
      notice.json?.delivery?.recipients === 1, notice.json?.delivery);

    // ==================================================================
    phase("D · unblock puts the company back where it was found");

    const unblock = await call(`/control/tenants/${TCA}/unblock`, null, {
      method: "POST", headers: ck(tok("adm")),
      body: JSON.stringify({ reasonCode: "other", note: "The licence was renewed out of band; opened again." })
    });
    check("unblock restores the status found before the block",
      unblock.status === 200 && unblock.json?.new_status === "active", { s: unblock.status, b: unblock.json });
    check("the company is active again in the table", (await seatState(TCA)).status === "active");
    const reopen = await call("/notifications", tokenA);
    check("the same token works again the moment the block is lifted", reopen.status === 200, reopen.status);
    await clearBuckets("login:");
    const reLogin = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN_A, email: EMAIL_A, password: PASSWORD })
    });
    check("and a real sign-in is let in again", reLogin.status === 200, reLogin.status);

    const notBlocked = await call(`/control/tenants/${TCA}/unblock`, null, {
      method: "POST", headers: ck(tok("adm")),
      body: JSON.stringify({ reasonCode: "other", note: "Unblocking a company that is already open." })
    });
    check("unblocking an open company answers 409",
      notBlocked.status === 409 && notBlocked.json?.error?.code === "CONFLICT", notBlocked.status);

    // ==================================================================
    phase("E · who may act, and what a body cannot make it do");

    const anon = await call("/control/approvals", null, {
      method: "POST",
      body: JSON.stringify({ action: "tenant.block", targetId: TCA, reasonCode: "abuse", reason: NOTE, note: NOTE })
    });
    check("an anonymous request to ban a company is turned away before the register is touched",
      anon.status === 401, { s: anon.status, c: anon.json?.error?.code });

    const forged = await proposeBlock(`act-smoke-forged-${STAMP}`, TCA, "abuse", NOTE);
    check("a cookie that is not a session is refused", forged.status === 401, forged.status);

    const billing = await proposeBlock(tok("bil"), TCA, "abuse", NOTE);
    check("a billing admin cannot even queue a ban it has no right to perform",
      billing.status === 403 && billing.json?.error?.code === "FORBIDDEN", { s: billing.status, c: billing.json?.error?.code });
    const billingReads = await call("/control/tenants?q=" + encodeURIComponent(COMPANY_A), null, { headers: ck(tok("bil")) });
    check("while it can still sell, so the two duties really are two",
      billingReads.status === 200, billingReads.status);

    // The desk's own precondition: 078 handed control.tenants.manage to compliance_officer,
    // and a register that the seat holding it cannot list is a decision it cannot make.
    const compReads = await call("/control/tenants?q=" + encodeURIComponent(COMPANY_A), null, { headers: ck(tok("cmp")) });
    check("the seat that shuts a company can read the list it shuts from",
      compReads.status === 200 && !!compReads.json?.some?.((r: any) => r.tenant_id === TCA),
      { s: compReads.status, n: Array.isArray(compReads.json) ? compReads.json.length : compReads.json });
    const compSells = await call(`/control/tenants/${TCA}/activate`, null, {
      method: "POST", headers: ck(tok("cmp")), body: JSON.stringify({ planKey: "starter" })
    });
    check("and reading is not selling: activation stays with the licence roles",
      compSells.status === 403, { s: compSells.status, c: compSells.json?.error?.code });

    const shortNote = await proposeBlock(tok("adm"), TCA, "abuse", "bad");
    check("a one-word note is refused before the register is asked",
      shortNote.status === 400 && (await register(TCA)).length === 3 && (await approvals(TCA)).length === 1,
      { s: shortNote.status });
    const shortReason = await proposeBlock(tok("adm"), TCA, "abuse", NOTE, "bad");
    check("and so is a one-word reason: it is the sentence the second seat signs",
      shortReason.status === 400, shortReason.status);
    const badReason = await call("/control/approvals", null, {
      method: "POST", headers: ck(tok("adm")),
      body: JSON.stringify({ action: "tenant.block", targetId: TCA, reasonCode: "because_i_said_so", reason: NOTE, note: NOTE })
    });
    check("an invented reason code is refused", badReason.status === 400, badReason.status);
    const extraKey = await call("/control/approvals", null, {
      method: "POST", headers: ck(tok("adm")),
      body: JSON.stringify({ action: "tenant.block", targetId: TCA, reasonCode: "abuse", reason: NOTE,
        note: NOTE, status: "applied", actor_kind: "system" })
    });
    check("a body cannot overtype the state or the actor a proposal claims to be",
      extraKey.status === 400 && (await seatState(TCA)).status === "active", { s: extraKey.status });
    const wrongVerb = await signApproval(tok("adm"), approvalId, "Approve it again, harder.", "approve_again");
    check("a decision route that does not exist is not a second way to sign",
      wrongVerb.status === 404, wrongVerb.status);

    const ghost = await proposeBlock(tok("adm"), randomUUID(), "abuse", NOTE);
    check("a company that does not exist is a 404, not a 500",
      ghost.status === 404 && ghost.json?.error?.code === "NOT_FOUND", { s: ghost.status, c: ghost.json?.error?.code });
    const onDesk = await proposeBlock(tok("adm"), CT, "abuse", NOTE);
    check("the platform desk cannot be blocked from the desk",
      onDesk.status === 400, { s: onDesk.status, m: onDesk.json?.error?.message });
    const onSeeker = await proposeBlock(tok("adm"), CS, "abuse", NOTE);
    check("a seeker account is not a company and is refused", onSeeker.status === 400, onSeeker.status);
    check("nothing in phase E wrote a register row", (await register(TCA)).length === 3, await register(TCA));
    check("…and nothing in phase E left a proposal standing either",
      (await approvals(TCA)).length === 1, await approvals(TCA));

    const actions = await call(`/control/tenants/${TCA}/actions`, null, { headers: ck(tok("adm")) });
    check("the history endpoint reads the register newest first",
      actions.status === 200 && actions.json?.actions?.length === 3
      && actions.json?.actions[0].action === "unblock", actions.json?.actions?.map?.((a: any) => a.action));
    const idle = await call("/control/tenants/policy/idle", null, { headers: ck(tok("adm")) });
    check("the idle preview names its own windows",
      idle.status === 200 && idle.json?.block_after_days === 45 && idle.json?.close_after_days === 90,
      idle.json);

    // ==================================================================
    phase("F · the idle clock: six weeks to block, three months to close");

    // A seat that is already signed in when the clock comes round. The block has to
    // revoke it, and so does the close — which needs a second one, because the first
    // is already revoked by the time the three-month pass runs.
    const openBetaSession = (label: string) => oi(
      `insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,$6,'127.0.0.1',
                now() + interval '2 hours')`,
      [randomUUID(), dirB, TCB, randomUUID(), sha256(`act-smoke-beta-${label}-${STAMP}`),
      "smoke-tenant-actions"]);
    await openBetaSession("before-block");

    const preview = await oi(`select platform_auth.tenant_policy_candidates(45, 90) as c`);
    const cand = (preview.rows[0]?.c as any[]) ?? [];
    const foreign = cand.filter((c: any) => c.tenant_id !== TCB && c.tenant_id !== TCA);
    check("every company the clock wants to act on is a fixture",
      foreign.length === 0, { candidates: cand.map((c: any) => `${c.name}/${c.action}`), foreign: foreign.map((c: any) => c.name) });
    check("beta is overdue at about six weeks and the clock says block",
      cand.some((c: any) => c.tenant_id === TCB && c.action === "block" && c.days_idle >= 45 && c.days_idle < 90),
      cand);
    check("alpha, current on its licence, is not a candidate",
      !cand.some((c: any) => c.tenant_id === TCA), cand);

    if (foreign.length === 0) {
      const sweep = await call("/control/tenants/policy/sweep", null, { method: "POST", headers: ck(tok("adm")) });
      check("the sweep blocks exactly the one overdue company",
        sweep.status === 200 && sweep.json?.blocked === 1 && sweep.json?.closed === 0
        && sweep.json?.skipped === 0, { s: sweep.status, b: sweep.json });
      const stF = await seatState(TCB);
      check("and leaves it suspended, not deleted", stF.status === "suspended" && !stF.closed, stF);
      check("the clock revoked the seat that was open when it ran",
        (await oi(`select count(*)::int as n from sessions where tenant_id = $1
                    and revoked_reason = 'tenant_blocked'`, [TCB])).rows[0].n === 1);
      const regF = await register(TCB);
      check("the clock writes its own actor kind and reason",
        regF.length === 1 && regF[0].actor_kind === "system" && regF[0].reason_code === "long_idle"
        && regF[0].told, regF);
      check("the note the clock sends states how long the licence has been down",
        /No paid licence has been recorded/.test(regF[0].note ?? "") && /six-week/.test(regF[0].note ?? ""),
        (regF[0].note ?? "").slice(0, 90));
      // `notices_sent` counts notices a provider accepted, not notices the clock attempted.
      // With no aggregator configured and Resend still on an unverified domain the honest
      // answer here is 0, so the assertion is that the sweep's tally is the receipt written on
      // its own register row — the two must never disagree, whoever the provider turns away.
      const told = (await oi(`select delivery from tenant_actions where tenant_id = $1
                               and action = 'block'`, [TCB])).rows[0]?.delivery;
      const delivered = (told?.sms?.sent ?? 0) + (told?.email?.sent ?? 0);
      check("the clock's notice tally is the receipt on its own register row",
        sweep.json?.notices_sent === delivered, { tally: sweep.json?.notices_sent, receipt: delivered });
      if (delivered === 0) {
        console.log(`     (notice attempted, provider refused: ${String(told?.errors?.[0] ?? "").slice(0, 150)})`);
      }
      await clearBuckets("login:");
      const idleLogin = await call("/auth/login", null, {
        method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN_B, email: EMAIL_B, password: PASSWORD })
      });
      check("the idle company is refused at the door by the policy clock",
        idleLogin.status === 403 && /WAISHA policy clock/.test(idleLogin.json?.error?.message ?? ""),
        { s: idleLogin.status, m: idleLogin.json?.error?.message });

      // Now past the three-month window: the same clock closes it.
      await openBetaSession("before-close");
      await oi(`update tenants set licence_expires_at = now() - interval '91 days' where id = $1`, [TCB]);
      await oi(`update subscriptions set current_period_end = now() - interval '91 days'
                 where tenant_id = $1`, [TCB]);
      const sweep2 = await call("/control/tenants/policy/sweep", null, { method: "POST", headers: ck(tok("adm")) });
      check("at three months the clock closes rather than blocks",
        sweep2.status === 200 && sweep2.json?.closed === 1 && sweep2.json?.blocked === 0, sweep2.json);
      const stC = await seatState(TCB);
      check("a closed company is tombstoned and suspended, so it can never be a zombie",
        stC.closed && stC.status === "suspended", stC);
      const regC2 = await register(TCB);
      check("the close is on the register with its own audit stamp",
        regC2.length === 2 && regC2[1].action === "close" && regC2[1].actor_kind === "system", regC2);
      const audC = await auditRow(TCB, "tenant.close");
      check("the audit row marks the company closed", audC?.closed === true, audC);
      check("beta's sessions are revoked for the close",
        (await oi(`select count(*)::int as n from sessions where tenant_id = $1
                    and revoked_reason = 'tenant_closed'`, [TCB])).rows[0].n >= 1);
      const third = await call("/control/tenants/policy/sweep", null, { method: "POST", headers: ck(tok("adm")) });
      check("a closed company is no longer a candidate: the third pass does nothing",
        third.status === 200 && third.json?.blocked === 0 && third.json?.closed === 0
        && third.json?.skipped === 0, third.json);
      const reopenClosed = await call(`/control/tenants/${TCB}/unblock`, null, {
        method: "POST", headers: ck(tok("adm")),
        body: JSON.stringify({ reasonCode: "other", note: "Trying to reopen a company that was closed." })
      });
      check("once closed, the desk cannot reopen it — that is a new account",
        reopenClosed.status === 404, { s: reopenClosed.status, c: reopenClosed.json?.error?.code });
    } else {
      check("sweep skipped because a real company was on the list", false, "see the candidate check above");
    }

    // ==================================================================
    phase("G · the cron surface, which is a scheduled write with no user behind it");

    const noSecret = await call("/internal/tenant-policy/tick", null, { method: "POST" });
    check("the idle tick refuses an unauthenticated caller", noSecret.status === 403, noSecret.status);
    const wrongSecret = await call("/internal/tenant-policy/tick", null, {
      method: "POST", headers: { "x-internal-secret": "not-the-tick-secret-at-all" }
    });
    check("and a wrong secret, whatever its length", wrongSecret.status === 403, wrongSecret.status);
    const rightSecret = await call("/internal/tenant-policy/tick", null, {
      method: "POST", headers: { "x-internal-secret": process.env.INTERNAL_TICK_SECRET ?? "" }
    });
    check("with the server's own secret the clock runs and finds nobody",
      rightSecret.status === 200 && rightSecret.json?.blocked === 0 && rightSecret.json?.closed === 0,
      { s: rightSecret.status, b: rightSecret.json });

    // ==================================================================
    phase("H · what must never reach a client");

    const blob = bodies.join("\n");
    const leaked = LEAK_MARKERS.filter((m) => blob.includes(m));
    check("no credential column, engine error or stack frame in any response", leaked.length === 0, leaked);
    const echoed = actionBodies.join("\n");
    check("an action route does not echo a director's address or phone",
      !echoed.includes(EMAIL_A) && !echoed.includes(PHONE_A) && !echoed.includes("phone_encrypted"),
      { email: echoed.includes(EMAIL_A), phone: echoed.includes(PHONE_A) });
    check("what the desk sees instead is the masked receipt",
      echoed.includes("a***@waisha.test"), echoed.match(/"email":"[^"]*"/)?.[0]);

    // The dev DSN hands us the owner role, so rebuild the runtime DSN the same way
    // verify-privileges-sql does: keep the pooler's resource ref, swap the login.
    const appUrl = new URL(process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL!);
    if (!appUrl.username.startsWith("app_runtime")) {
      const ref = appUrl.username.split(".")[1];
      appUrl.username = "app_runtime" + (ref ? "." + ref : "");
      appUrl.password = encodeURIComponent(process.env.APP_DB_PASSWORD ?? "");
    }
    const runtime = new pg.Client({ connectionString: appUrl.toString(), ssl: { rejectUnauthorized: false } });
    await runtime.connect();
    const denied = await runtime.query(
      `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'tenant_actions'
          and has_table_privilege('app_runtime', c.oid, 'select')`).catch(() => null);
    check("app_runtime has no read grant on the register table",
      !denied?.rowCount, denied?.rows);
    const pubExec = await runtime.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'platform_auth'
          and p.proname in ('tenant_apply_action','tenant_block_state','tenant_suspensions',
                             'manual_activate','list_tenants_for_control')
          and has_function_privilege('public', p.oid, 'execute')`).catch(() => null);
    check("and none of the new definers are executable by PUBLIC",
      !pubExec?.rows.length, pubExec?.rows?.map((r: any) => r.proname));
    await runtime.end();
  } finally {
    // ==================================================================
    phase("teardown");
    const tids = [TCA, TCB, CT, CS].filter(Boolean);
    const seats = [uADM, uBIL, uCMP, dirA, dirB].filter(Boolean);
    await clearBuckets("login:", "signup:", "otp:", "tenant-action:", "tenant-sweep:",
      "internal-tick:", "activate:uid:", "approvals-");
    // 121: a proposal is referenced by the act it released, so the act rows go first and the
    // signatures after them — both scoped to this run's companies and seats, never to a list
    // collected from a wider query.
    await oi(`delete from tenant_actions where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from platform_approvals where target_id = any($1::text[])
                or proposed_by = any($2::uuid[]) or decided_by = any($2::uuid[])`,
      [tids, seats]).catch(() => { });
    await wipeTenants(tids);
    const left = await oi(
      `select (select count(*)::int from tenants where name like $1) as tenants,
              (select count(*)::int from tenant_actions where tenant_id = any($2::uuid[])) as actions,
              (select count(*)::int from sessions where tenant_id = any($2::uuid[])) as sessions,
              (select count(*)::int from subscriptions where tenant_id = any($2::uuid[])) as subs,
              (select count(*)::int from invoices where tenant_id = any($2::uuid[])) as invoices,
              (select count(*)::int from platform_approvals
                where target_id = any($2::text[]) or proposed_by = any($3::uuid[])
                   or decided_by = any($3::uuid[])) as approvals,
              (select count(*)::int from users where id = any($3::uuid[])) as seats,
              (select count(*)::int from rate_limits where bucket like 'approvals-%') as buckets`,
      [NAME_SWEEP, tids, seats]);
    check("no fixture company, register row, proposal, signature, session, seat, licence, invoice or bucket is left behind",
      left.rows[0].tenants === 0 && left.rows[0].actions === 0 && left.rows[0].sessions === 0
      && left.rows[0].subs === 0 && left.rows[0].invoices === 0 && left.rows[0].approvals === 0
      && left.rows[0].seats === 0 && left.rows[0].buckets === 0, left.rows[0]);
    const afterSusp = (((await oi(`select platform_auth.tenant_suspensions() as s`))
      .rows[0]?.s as any[]) ?? []).map((x: any) => x.tenant_id);
    check("the gate holds exactly the companies it held before this run, and not one fixture",
      !afterSusp.includes(TCA) && !afterSusp.includes(TCB)
      && afterSusp.every((t: string) => baselineSusp.has(t)),
      { now: afterSusp, before: [...baselineSusp] });
    if (baselineSusp.size) {
      console.log(`     (${baselineSusp.size} companies were already shut on this database before the probe ran.)`);
    }
    await owner.end();
  }

  console.log(`\n${failures ? "FAILURES: " + failures : "all tenant-action checks passed"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
