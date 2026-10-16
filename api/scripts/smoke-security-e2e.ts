/**
 * Step 8 — end-to-end breach-attempt suite.
 *
 * Drives the real HTTP surface against a running API: genuine signup → OTP →
 * login → refresh → replay → logout, forged and tampered tokens, the permission
 * and audience gates, tenant-isolation probes, PII at rest and in transit,
 * injection-shaped input and error hygiene.
 *
 * Rate-limit buckets are cleared between phases deliberately. The throttle
 * windows are clock-aligned (platform_auth.hit_rate_limit), so a leftover
 * bucket would make pass/fail depend on when the suite last ran rather than on
 * what it tested.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-security-e2e.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";
import { createHmac } from "node:crypto";
import { encryptField, decryptField, searchHash, sha256 } from "../src/util/crypto.js";
import { hashPassword } from "../src/security/argon2.js";
import { hashOtp, OTP_MAX_ATTEMPTS } from "../src/security/otp.js";
import { BOARD_FORBIDDEN_KEYS } from "../src/util/board.js";
import { formatTin } from "../src/security/tin.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);
const WRONG_KEY = new TextEncoder().encode(createHmac("sha256", "not-the-secret").update("k").digest("hex"));

const STAMP = Date.now().toString().slice(-8);
const COMPANY = `Sec Smoke Alpha Ltd`;
const EMAIL = `sec.smoke.${STAMP}@waisha.test`;
const PHONE = `+2557${STAMP}`;
const TIN = `9${STAMP}`;                        // 9 digits — structure-mode valid
const PASSWORD = `Sq-${STAMP}-R7!x`;
const PASSWORD2 = `Sq-${STAMP}-R8!y`;
const NIDA = `1994${STAMP}${STAMP.slice(0, 6)}`; // 20 digits, distinctive
const SHIPPER_EMAIL = `sec.smoke.shipper.${STAMP}@waisha.test`;
const STAFF_EMAIL = `sec.smoke.staff.${STAMP}@waisha.test`;
const INVOICE_NO = `SEC-${STAMP}`;
const OTP_KNOWN = "246810";
const RESET_TOKEN = `sec-smoke-reset-token-${STAMP}-abcdef`;

/** Field names and engine strings that must never reach a client. */
const LEAK_MARKERS = [
  "password_hash", "token_hash", "code_hash", "ntra_encrypted", "nida_encrypted",
  "phone_encrypted", "totp_secret", "revoked_reason", "destination_search",
  "syntax error at or near", "duplicate key value violates", "Postgres",
  "ERRORE:", "node_modules", "at Object.<anonymous>", "FastifyError"
];

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

interface Res { status: number; json: any; text: string; headers: Headers }
const transcript: Res[] = [];

async function call(path: string, token: string | null, init: RequestInit = {}): Promise<Res> {
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
  const r = { status: res.status, json, text, headers: res.headers };
  transcript.push(r);
  return r;
}

async function mint(sub: string, tid: string, roles: string[], opts: {
  typ?: string; secret?: Uint8Array; exp?: string; header?: any;
} = {}) {
  const claims: any = { tid, sid: "00000000-0000-7000-8000-0000000000aa", typ: opts.typ ?? roles[0] ?? "director", roles };
  return new SignJWT(claims)
    .setProtectedHeader(opts.header ?? { alg: "HS256" })
    .setSubject(sub).setIssuedAt().setExpirationTime(opts.exp ?? "15m")
    .sign(opts.secret ?? key);
}

/** Unsigned token — the classic "strip the algorithm" attempt. */
function unsignedToken(sub: string, tid: string, roles: string[]) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    tid, sid: "00000000-0000-7000-8000-0000000000aa", typ: roles[0], roles,
    sub, iat: now, exp: now + 900
  })}.`;
}

/** Every object key anywhere in a parsed payload, for allowlist/denylist scans. */
function keysOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const v of node) keysOf(v, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) { out.push(k); keysOf(v, out); }
  }
  return out;
}

const cookieOf = (h: Headers) =>
  (typeof h.getSetCookie === "function" ? h.getSetCookie() : [])
    .find((c) => c.startsWith("waisha_refresh="))?.split(";")[0] ?? "";

async function main() {
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
    "sessions", "otp_codes", "password_resets", "settings", "subscriptions"];
  const wipeTenant = async (tids: string[]) => {
    if (!tids.length) return;
    for (const t of WIPE) await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from alert_reads where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from user_roles where user_id in
             (select id from users where tenant_id = any($1::uuid[]))`, [tids]).catch(() => { });
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from tenants where id = any($1::uuid[])`, [tids]).catch(() => { });
  };

  // Pre-clean a crashed earlier run. Fixtures are unique by TIN, so match on name.
  const stale = (await oi(`select id from tenants where name = $1`, [COMPANY])).rows.map(r => r.id);
  await wipeTenant(stale);
  await clearBuckets("login:", "signup:", "otp:", "forgot:", "reset:", "ip:");

  let tenantId = "";
  let directorId = "";
  let staffId = "";
  let shipperId = "";
  let driverId = "";
  let invoiceId = "";
  let foreignTenantId = "";
  let foreignDirectorId = "";
  let directorToken = "";
  let staffToken = "";
  let shipperToken = "";

  try {
    // ======================================================================
    phase("A · preflight");
    const health = await fetch(`${API}/health`);
    check("API is up", health.status === 200, health.status);

    const anon = await call("/drivers", null);
    check("no token → 401", anon.status === 401 && anon.json?.error?.code === "TOKEN_EXPIRED", anon.status);

    const junk = await call("/drivers", "not.a.jwt");
    check("garbage bearer → 401, not 500", junk.status === 401, junk.status);

    // ======================================================================
    phase("B · real signup + OTP lifecycle");
    const weak = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: COMPANY, tin: TIN, phone: PHONE, email: EMAIL,
        password: "short", confirmPassword: "short", acceptTerms: true
      })
    });
    check("policy-failing password → 400", weak.status === 400, weak.status);

    const mismatch = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: COMPANY, tin: TIN, phone: PHONE, email: EMAIL,
        password: PASSWORD, confirmPassword: PASSWORD2, acceptTerms: true
      })
    });
    check("password mismatch → 400 on confirmPassword", mismatch.status === 400, mismatch.json?.error?.details);

    const badTin = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: COMPANY, tin: "12345", phone: PHONE, email: EMAIL,
        password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true
      })
    });
    check("short TIN → 400", badTin.status === 400, badTin.status);

    const noTerms = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: COMPANY, tin: TIN, phone: PHONE, email: EMAIL,
        password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: false
      })
    });
    check("terms not accepted → 400", noTerms.status === 400, noTerms.status);

    const signup = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: COMPANY, tin: TIN, phone: PHONE, email: EMAIL,
        password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true
      })
    });
    directorId = signup.json?.userId ?? "";
    check("signup → 201 with userId", signup.status === 201 && !!directorId, { s: signup.status, b: signup.json });
    check("signup returns only a masked phone", !signup.text.includes(PHONE) && !!signup.json?.phoneMasked, signup.text.slice(0, 120));

    const dupeTin = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: "Other Smoke Co", tin: TIN, phone: "+255788776655", email: `sec.dupe.${STAMP}@waisha.test`,
        password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true
      })
    });
    check("same TIN again → 409", dupeTin.status === 409 && dupeTin.json?.error?.code === "CONFLICT",
      { s: dupeTin.status, c: dupeTin.json?.error?.code });

    const dupeMail = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: "Other Smoke Co", tin: `8${STAMP}`, phone: "+255788776656", email: EMAIL,
        password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true
      })
    });
    check("same email again → 409", dupeMail.status === 409, dupeMail.status);

    const tRow = await oi(`select tenant_id, status from users where id = $1`, [directorId]);
    tenantId = tRow.rows[0]?.tenant_id ?? "";
    check("signup leaves the account pending verification",
      tRow.rows[0]?.status === "pending_verification" && !!tenantId, tRow.rows[0]);

    // Wrong codes up to the attempt ceiling must lock the code, not the account.
    let lastOtp: Res = { status: 0, json: null, text: "", headers: new Headers() };
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      lastOtp = await call("/auth/otp/verify", null, {
        method: "POST", body: JSON.stringify({ userId: directorId, code: "111111" })
      });
    }
    check(`${OTP_MAX_ATTEMPTS} wrong codes → 423 OTP_LOCKED`,
      lastOtp.status === 423 && lastOtp.json?.error?.code === "OTP_LOCKED",
      { s: lastOtp.status, c: lastOtp.json?.error?.code });

    const earlyResend = await call("/auth/otp/resend", null, {
      method: "POST", body: JSON.stringify({ userId: directorId })
    });
    check("resend inside the 60s window → 429", earlyResend.status === 429, earlyResend.status);

    // The SMS transport only logs in dev, so the code is re-pointed by the
    // fixture the same way a real delivery would have set it.
    await oi(`update otp_codes set attempts = 0, locked_until = null, code_hash = $2
              where user_id = $1 and purpose = 'signup' and expires_at > now()`,
      [directorId, hashOtp(OTP_KNOWN)]);
    const verified = await call("/auth/otp/verify", null, {
      method: "POST", body: JSON.stringify({ userId: directorId, code: OTP_KNOWN })
    });
    check("correct code verifies → 200", verified.status === 200, { s: verified.status, b: verified.json });

    const afterVerify = await oi(
      `select u.status, coalesce(array_agg(r.key), '{}') as roles
       from users u left join user_roles ur on ur.user_id = u.id
       left join roles r on r.id = ur.role_id where u.id = $1 group by u.status`, [directorId]);
    check("verified user is active with the director role",
      afterVerify.rows[0]?.status === "active" && (afterVerify.rows[0].roles as string[]).includes("director"),
      afterVerify.rows[0]);

    const reVerify = await call("/auth/otp/verify", null, {
      method: "POST", body: JSON.stringify({ userId: directorId, code: OTP_KNOWN })
    });
    check("verifying twice → 409, no re-grant", reVerify.status === 409, reVerify.status);

    await oi(`update tenants set status = 'trial', trial_started_at = now(),
              trial_ends_at = now() + interval '48 hours' where id = $1`, [tenantId]);

    directorToken = await mint(directorId, tenantId, ["director"]);

    // Two staff-side accounts, created with the same Argon2id path the app uses.
    const staffHash = await hashPassword(PASSWORD);
    const shipperHash = await hashPassword(PASSWORD);
    const insStaff = await oi(
      `insert into users (id, tenant_id, user_type, email, email_normalized_search, phone_encrypted,
         phone_search, password_hash, status, full_name)
       values (gen_random_uuid(), $1, 'staff', $2, $3, $4, $5, $6, 'active', 'Smoke Limited Staff')
       returning id`,
      [tenantId, STAFF_EMAIL, searchHash(STAFF_EMAIL), encryptField(PHONE), searchHash(PHONE), staffHash]);
    staffId = insStaff.rows[0].id;
    await oi(`insert into user_roles (user_id, role_id)
              select $1, id from roles where tenant_id is null and key = 'hr_officer'`, [staffId]);
    const insShipper = await oi(
      `insert into users (id, tenant_id, user_type, email, email_normalized_search, phone_encrypted,
         phone_search, nida_encrypted, nida_search, password_hash, status, full_name)
       values (gen_random_uuid(), $1, 'shipper', $2, $3, $4, $5, $6, $7, $8, 'active', 'Smoke Portal Shipper')
       returning id`,
      [tenantId, SHIPPER_EMAIL, searchHash(SHIPPER_EMAIL), encryptField(PHONE), searchHash(PHONE),
       encryptField(NIDA), searchHash(NIDA), shipperHash]);
    shipperId = insShipper.rows[0].id;
    await oi(`insert into user_roles (user_id, role_id)
              select $1, id from roles where tenant_id is null and key = 'shipper_portal'`, [shipperId]);

    const staffRoleCount = await oi(
      `select count(*)::int as n from role_permissions rp
       join user_roles ur on ur.role_id = rp.role_id where ur.user_id = $1`, [staffId]);
    console.log(`(hr_officer grants: ${staffRoleCount.rows[0].n} permissions)`);

    staffToken = await mint(staffId, tenantId, ["hr_officer"]);

    // A real second tenant to aim forged tokens at, read-only.
    const foreign = await oi(
      `select t.id as tenant, u.id as director from tenants t
       join users u on u.tenant_id = t.id and u.user_type = 'director' and u.status = 'active'
       where t.id <> $1 and t.type = 'transporter' and t.deleted_at is null limit 1`, [tenantId]);
    foreignTenantId = foreign.rows[0]?.tenant ?? "";
    foreignDirectorId = foreign.rows[0]?.director ?? "";

    // Money + PII fixtures the gates are supposed to hide.
    const drv = await oi(
      `insert into drivers (id, tenant_id, full_name, nida_encrypted, nida_search,
         phone_encrypted, phone_search, licence_class, licence_number, status, created_by)
       values (gen_random_uuid(), $1, 'Smoke Pii Driver', $2, $3, $4, $5, 'C', 'LIC-SEC-1', 'available', $6)
       returning id`,
      [tenantId, encryptField(NIDA), searchHash(NIDA), encryptField(PHONE), searchHash(PHONE), directorId]);
    driverId = drv.rows[0].id;

    const inv = await oi(
      `insert into freight_invoices (id, tenant_id, invoice_number, customer_name, issue_date,
         due_date, currency, vat_rate, subtotal, vat_amount, total, amount_paid, status, created_by)
       values (gen_random_uuid(), $1, $2, 'Smoke Debtor Co', current_date - 40, current_date - 12,
         'TZS', 18, 1111111, 199999, 1311110, 0, 'sent', $3) returning id`,
      [tenantId, INVOICE_NO, directorId]);
    invoiceId = inv.rows[0].id;
    await oi(`insert into office_costs (tenant_id, cost_date, category, description, amount, status)
              values ($1, current_date, 'rent', 'Smoke pending rent', 250000, 'pending')`, [tenantId]);
    // Budget alerts compare against approved spend only, so the overshoot needs
    // an approved row on top of the pending one above.
    await oi(`insert into office_costs (tenant_id, cost_date, category, description, amount, status)
              values ($1, current_date, 'utilities', 'Smoke approved power bill', 480000, 'approved')`, [tenantId]);
    await oi(`insert into office_budgets (tenant_id, period, category, amount)
              values ($1, date_trunc('month', current_date)::date, 'rent', 100000)`, [tenantId]);
    await oi(`insert into office_budgets (tenant_id, period, category, amount)
              values ($1, date_trunc('month', current_date)::date, 'utilities', 200000)`, [tenantId]);

    // ======================================================================
    phase("C · forged and tampered tokens");
    const okProfile = await call("/profile", directorToken);
    check("valid director token reads its own profile", okProfile.status === 200, okProfile.status);

    const wrongSecret = await mint(directorId, tenantId, ["director"], { secret: WRONG_KEY });
    const rejectedSecret = await call("/profile", wrongSecret);
    check("token signed with another secret → 401", rejectedSecret.status === 401, rejectedSecret.status);

    const algNone = unsignedToken(directorId, tenantId, ["director"]);
    const rejectedNone = await call("/profile", algNone);
    check("alg:none token → 401", rejectedNone.status === 401, rejectedNone.status);

    const expired = await mint(directorId, tenantId, ["director"], { exp: "-1m" });
    const rejectedExp = await call("/profile", expired);
    check("expired token → 401", rejectedExp.status === 401, rejectedExp.status);

    if (foreignTenantId) {
      const forgedTid = await mint(directorId, foreignTenantId, ["director"]);
      const listForeign = await call("/drivers", forgedTid);
      check("token with a foreign tid sees no rows from that tenant",
        listForeign.status === 200 && (listForeign.json ?? []).length === 0,
        { s: listForeign.status, n: (listForeign.json ?? []).length });
      const detailForeign = await call(`/drivers/${driverId}`, forgedTid);
      check("foreign tid cannot read this tenant's driver by id → 404",
        detailForeign.status === 404, detailForeign.status);
      const alertsForeign = await call("/notifications", forgedTid);
      check("foreign tid gets no invoice alert for our invoice",
        alertsForeign.status === 200 &&
        !(alertsForeign.json?.items ?? []).some((i: any) => String(i.key).includes(invoiceId)),
        alertsForeign.json?.counts);
    } else {
      check("a foreign transporter tenant exists to probe", false, "none found");
    }

    // ======================================================================
    phase("D · permission gates on writes");
    const gateCases: [string, string, string][] = [
      ["POST /drivers", "/drivers", "POST"],
      ["POST /vessels", "/vessels", "POST"],
      ["POST /routes", "/routes", "POST"],
      ["POST /trips", "/trips", "POST"],
      ["PUT /profile", "/profile", "PUT"],
      ["POST /branches", "/branches", "POST"],
      ["GET /reports/cargo", "/reports/cargo", "GET"],
      ["POST /payments/intent", "/payments/intent", "POST"]
    ];
    let denied = 0;
    for (const [label, path, method] of gateCases) {
      const r = await call(path, staffToken, method === "GET" ? {} : { method, body: "{}" });
      const good = r.status === 403 && r.json?.error?.code === "FORBIDDEN";
      if (good) denied++;
      else console.log(`   ${label} → ${r.status} ${r.text.slice(0, 90)}`);
    }
    check(`${gateCases.length} gated routes refuse a role with no grants`,
      denied === gateCases.length, `${denied}/${gateCases.length}`);

    const ghostToken = await mint("99999999-9999-7999-8999-999999999999", tenantId, ["staff"]);
    const ghost = await call("/drivers", ghostToken, { method: "POST", body: "{}" });
    check("unknown user id cannot create a driver → 403", ghost.status === 403, ghost.status);

    const dirGate = await call("/reports/cargo", directorToken);
    check("positive control: director still reads cargo report", dirGate.status === 200, dirGate.status);

    const dirShip = await call("/trips", directorToken, { method: "POST", body: "{}" });
    check("positive control: director passes the trips gate (validation, not 403)",
      dirShip.status !== 403, dirShip.status);

    const staffBoard = await call("/board", staffToken);
    check("role without board.view is refused the board → 403", staffBoard.status === 403, staffBoard.status);

    const controlNoCookie = await call("/control/plans", null);
    check("plans editor without a control cookie → 401", controlNoCookie.status === 401, controlNoCookie.status);
    const controlBadCookie = await call("/control/plans", null, {
      headers: { Cookie: "waisha_control=forged-value" }
    });
    check("plans editor with a forged control cookie → 401", controlBadCookie.status === 401, controlBadCookie.status);
    const controlPublic = await call("/control/plans-public", null);
    check("positive control: public plan listing still works", controlPublic.status === 200, controlPublic.status);

    // ======================================================================
    phase("E · portal accounts kept off the staff surface");
    await clearBuckets("login:");
    const shipperLogin = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "shipper", email: SHIPPER_EMAIL, password: PASSWORD })
    });
    check("shipper logs in for real → 200 with portal role",
      shipperLogin.status === 200 && (shipperLogin.json?.roles ?? []).includes("shipper_portal"),
      { s: shipperLogin.status, r: shipperLogin.json?.roles });
    shipperToken = shipperLogin.json?.accessToken ?? "";

    const portalSurfaces: [string, string, string?][] = [
      ["GET /drivers", "/drivers", "GET"],
      ["GET /vessels", "/vessels", "GET"],
      ["GET /notifications", "/notifications", "GET"],
      ["GET /reports/cargo", "/reports/cargo", "GET"],
      ["GET /ledger/receivables", "/ledger/receivables", "GET"],
      ["POST /payments/intent", "/payments/intent", "POST"],
      ["POST /trips", "/trips", "POST"],
      ["GET /users", "/users", "GET"]
    ];
    let blocked = 0;
    for (const [label, path, method] of portalSurfaces) {
      const r = await call(path, shipperToken, method === "GET" ? {} : { method, body: "{}" });
      const hit = r.status === 403 && r.text.includes("not available to portal accounts");
      if (hit) blocked++;
      else console.log(`   ${label} → ${r.status} ${r.text.slice(0, 90)}`);
    }
    check(`shipper token blocked from all ${portalSurfaces.length} staff surfaces`,
      blocked === portalSurfaces.length, `${blocked}/${portalSurfaces.length}`);

    const portalOpen = await call("/portal/overview", shipperToken);
    check("positive control: the portal itself is not audience-blocked",
      !portalOpen.text.includes("not available to portal accounts"),
      { s: portalOpen.status, m: portalOpen.json?.error?.message });
    const meAsShipper = await call("/auth/me", shipperToken);
    check("positive control: /auth/me stays reachable", meAsShipper.status === 200, meAsShipper.status);
    const staffStillWorks = await call("/drivers", directorToken);
    check("positive control: staff token unaffected", staffStillWorks.status === 200, staffStillWorks.status);

    const typForge = await mint(shipperId, tenantId, ["shipper_portal"], { typ: "director" });
    const typBlocked = await call("/drivers", typForge);
    check("a forged typ claim does not open the staff surface",
      typBlocked.status === 403 && typBlocked.text.includes("not available to portal accounts"),
      typBlocked.status);

    // ======================================================================
    phase("F · finance alerts follow the role check");
    const dirAlerts = await call("/notifications", directorToken);
    const dirItems = dirAlerts.json?.items ?? [];
    check("director sees the overdue-invoice alert",
      dirAlerts.status === 200 && dirItems.some((i: any) => i.type === "invoice_overdue" && String(i.key).includes(invoiceId)),
      dirItems.map((i: any) => i.type));
    check("director sees pending office costs and the exceeded budget",
      dirItems.some((i: any) => i.type === "office_cost_pending") &&
      dirItems.some((i: any) => i.type === "office_budget_over"),
      dirItems.map((i: any) => i.type));

    const staffAlerts = await call("/notifications", staffToken);
    const staffItems = staffAlerts.json?.items ?? [];
    const moneyTypes = staffItems.filter((i: any) =>
      /^(invoice_|expense_|office_cost|office_budget)/.test(String(i.type)));
    check("role without finance permissions gets no money-bearing alerts",
      staffAlerts.status === 200 && moneyTypes.length === 0,
      moneyTypes.map((i: any) => `${i.type}:${i.detail}`));
    check("and its totals are strictly smaller than the director's",
      staffItems.length < dirItems.length, { staff: staffItems.length, director: dirItems.length });
    check("no balance figure from the seeded invoice leaks into that feed",
      !staffAlerts.text.includes("1 311 110") && !staffAlerts.text.includes("1311110"),
      staffAlerts.text.slice(0, 120));

    // ======================================================================
    phase("G · session lifecycle: rotate, replay, revoke");
    // Transporter login is keyed on (TIN, email) — the tenant's TIN, not the
    // person's, so every call below has to carry it.
    await clearBuckets("login:");
    const login1 = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN, email: EMAIL, password: PASSWORD })
    });
    check("director login → 200 with access token + cookie",
      login1.status === 200 && !!login1.json?.accessToken && !!cookieOf(login1.headers),
      login1.status);
    const rc1 = cookieOf(login1.headers);

    const refresh1 = await call("/auth/refresh", null, { method: "POST", headers: { Cookie: rc1 } });
    check("refresh → 200 and a different refresh token",
      refresh1.status === 200 && !!refresh1.json?.accessToken && cookieOf(refresh1.headers) !== rc1,
      refresh1.status);

    const replay = await call("/auth/refresh", null, { method: "POST", headers: { Cookie: rc1 } });
    check("replaying the retired token → 401 TOKEN_REUSE",
      replay.status === 401 && replay.json?.error?.code === "TOKEN_REUSE",
      { s: replay.status, c: replay.json?.error?.code });
    const family = await oi(
      `select count(*)::int as total,
              count(*) filter (where revoked_at is null)::int as still_live,
              count(*) filter (where revoked_reason = 'family_reuse')::int as reuse
       from sessions where user_id = $1`, [directorId]);
    check("reuse detection left no live session in that family",
      family.rows[0].total >= 2 && family.rows[0].still_live === 0 && family.rows[0].reuse >= 1,
      family.rows[0]);

    const loginBody = { mode: "transporter", tin: TIN, email: EMAIL, password: PASSWORD };
    await clearBuckets("login:");
    const login2 = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify(loginBody)
    });
    check("a fresh login still works after the family was cut", login2.status === 200, login2.status);
    const rcNew = cookieOf(login2.headers);
    const token2 = login2.json?.accessToken;

    // A second sign-in gives a second live session, so the revoke path has
    // something to remove that is not the caller's own session.
    await clearBuckets("login:");
    const login3 = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify(loginBody)
    });
    check("a parallel sign-in creates a second session", login3.status === 200, login3.status);

    const sessions = await call("/auth/sessions", token2);
    const rows: any[] = Array.isArray(sessions.json) ? sessions.json : [];
    check("sessions lists both, marks the current one, and hides the token material",
      rows.length >= 2 && rows.some((s) => s.current === true) &&
      !rows.some((s) => "refresh_token_hash" in s || "token_hash" in s),
      rows.length ? rows.map((s) => Object.keys(s)) : sessions.text.slice(0, 120));

    const other = rows.find((s) => !s.current);
    if (other) {
      const revoke = await call(`/auth/sessions/${other.id}`, token2, { method: "DELETE" });
      check("revoking another session → 200", revoke.status === 200, revoke.status);
      const again = await call(`/auth/sessions/${other.id}`, token2, { method: "DELETE" });
      check("revoking it twice → 404", again.status === 404, again.status);
    } else {
      check("revoking another session → 200", false, "no second session was listed");
    }

    if (foreignDirectorId) {
      const crossRevoke = await call(`/auth/sessions/${crypto.randomUUID()}`, token2, { method: "DELETE" });
      check("revoking a foreign session id → 404", crossRevoke.status === 404, crossRevoke.status);
    }

    const logout = await call("/auth/logout", token2, { method: "POST", headers: { Cookie: rcNew } });
    check("logout → 200", logout.status === 200, logout.status);
    const afterLogout = await call("/auth/refresh", null, { method: "POST", headers: { Cookie: rcNew } });
    check("refresh after logout → 401", afterLogout.status === 401, afterLogout.status);
    const anonRefresh = await call("/auth/refresh", null, { method: "POST" });
    check("refresh with no cookie → 401", anonRefresh.status === 401, anonRefresh.status);

    // ======================================================================
    phase("H · brute force, enumeration, reset");
    await clearBuckets("login:");
    const staffLogin = (password: string) => call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN, email: STAFF_EMAIL, password })
    });
    for (let i = 0; i < 5; i++) await staffLogin("Wrong-Passw0rd!");
    // The per-user throttle (5 per 15 min) would otherwise answer before the
    // lockout does; clear it so this probe measures the lockout, not the bucket.
    await clearBuckets("login:");
    const rightAfterWrong = await staffLogin(PASSWORD);
    check("the correct password is refused once the account is locked → 423",
      rightAfterWrong.status === 423 && rightAfterWrong.json?.error?.code === "ACCOUNT_LOCKED",
      { s: rightAfterWrong.status, c: rightAfterWrong.json?.error?.code });
    const lockRow = await oi(`select locked_until > now() as locked, failed_login_count as n
                              from users where id = $1`, [staffId]);
    check("lockout is stored with an escalating count",
      lockRow.rows[0]?.locked === true && lockRow.rows[0]?.n >= 5, lockRow.rows[0]);
    await oi(`update users set locked_until = null, failed_login_count = 0 where id = $1`, [staffId]);

    await clearBuckets("login:");
    const unknown = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({
        mode: "transporter", tin: TIN, email: `nobody.${STAMP}@waisha.test`, password: PASSWORD
      })
    });
    const wrongPw = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN, email: EMAIL, password: "Wrong-Passw0rd!" })
    });
    check("unknown identity and wrong password answer identically (no enumeration)",
      unknown.status === 401 && unknown.status === wrongPw.status &&
      unknown.json?.error?.code === wrongPw.json?.error?.code,
      { unknown: unknown.json?.error?.code, wrongPw: wrongPw.json?.error?.code });

    await clearBuckets("forgot:");
    const forgotUnknown = await call("/auth/forgot-password", null, {
      method: "POST", body: JSON.stringify({ email: `nobody.${STAMP}@waisha.test` })
    });
    const forgotReal = await call("/auth/forgot-password", null, {
      method: "POST", body: JSON.stringify({ email: EMAIL })
    });
    check("forgot-password gives one neutral answer for both",
      forgotUnknown.status === 200 && forgotUnknown.text === forgotReal.text, forgotReal.text.slice(0, 90));

    // Mail is console-only in dev, so the fixture sets the token hash the same
    // way a real send would have.
    await oi(`update password_resets set token_hash = $2 where user_id = $1`, [directorId, sha256(RESET_TOKEN)]);
    const reset = await call("/auth/reset-password", null, {
      method: "POST", body: JSON.stringify({ token: RESET_TOKEN, password: PASSWORD2 })
    });
    check("reset with the delivered token → 200", reset.status === 200, { s: reset.status, b: reset.json });
    const sessionsLeft = await oi(
      `select count(*)::int as n from sessions where user_id = $1 and revoked_at is null`, [directorId]);
    check("every session was revoked by the reset", sessionsLeft.rows[0].n === 0, sessionsLeft.rows[0]);

    const resetReplay = await call("/auth/reset-password", null, {
      method: "POST", body: JSON.stringify({ token: RESET_TOKEN, password: PASSWORD })
    });
    check("the same reset token cannot be used twice → 400", resetReplay.status === 400, resetReplay.status);

    await clearBuckets("login:");
    const oldPw = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN, email: EMAIL, password: PASSWORD })
    });
    const newPw = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN, email: EMAIL, password: PASSWORD2 })
    });
    check("old password rejected after reset", oldPw.status === 401, oldPw.status);
    check("new password accepted", newPw.status === 200, newPw.status);
    directorToken = newPw.json?.accessToken ?? directorToken;

    // ======================================================================
    phase("I · PII in transit and at rest");
    const drivers = await call("/drivers", directorToken);
    check("driver list never carries the raw NIDA number",
      !drivers.text.includes(NIDA), drivers.text.slice(0, 120));
    check("driver list never carries the raw phone",
      !drivers.text.includes(PHONE), drivers.text.slice(0, 120));
    check("driver list carries no ciphertext column either",
      !drivers.text.includes("nida") && !drivers.text.includes("encrypted"),
      drivers.text.slice(0, 120));

    const atRest = await oi(`select nida_encrypted, nida_search, phone_encrypted from drivers where id = $1`, [driverId]);
    const blob = atRest.rows[0].nida_encrypted;
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(String(blob).replace(/^\\x/, ""), "hex");
    check("NIDA is stored as ciphertext, not plaintext",
      !buf.toString("latin1").includes(NIDA), buf.subarray(0, 16).toString("hex"));
    check("and decrypts back to the same value", decryptField(buf) === NIDA);
    check("lookup uses only the keyed hash",
      atRest.rows[0].nida_search === searchHash(NIDA) && !String(atRest.rows[0].nida_search).includes(NIDA));

    const tenantRow = await oi(`select tin_encrypted, tin_search from tenants where id = $1`, [tenantId]);
    // validateTin() canonicalises to NNN-NNN-NNN before encrypting/hashing, so
    // that — not the typed digits — is what must (never) appear at rest.
    const tinFormatted = formatTin(TIN);
    const tinBuf: Buffer = tenantRow.rows[0].tin_encrypted;
    const tinClear = tinBuf.toString("latin1");
    check("TIN ciphertext holds neither the typed digits nor the canonical form",
      !tinClear.includes(TIN) && !tinClear.includes(tinFormatted), tinBuf.subarray(0, 12).toString("hex"));
    check("TIN lookup column is the keyed hash of the canonical TIN",
      tenantRow.rows[0].tin_search === searchHash(tinFormatted) &&
      !tenantRow.rows[0].tin_search.includes(TIN),
      { hash_len: String(tenantRow.rows[0].tin_search ?? "").length });

    // ======================================================================
    phase("J · injection-shaped input and error hygiene");
    const injCases: [string, string, RequestInit][] = [
      ["quote in a login identifier", "/auth/login", {
        method: "POST", body: JSON.stringify({ mode: "transporter", email: `a' or '1'='1'--@waisha.test`, password: PASSWORD })
      }],
      ["SQL comment in a query string", "/drivers?search=" + encodeURIComponent("'; DROP TABLE users; --"), {}],
      ["path traversal in an id", "/drivers/..%2F..%2Fetc%2Fpasswd", {}],
      ["array where a string is expected", "/drivers", {
        method: "POST", body: JSON.stringify({ fullName: ["a", "b"], licenceClass: { x: 1 } })
      }],
      ["oversized payload field", "/profile", { method: "PUT", body: JSON.stringify({ companyName: "A".repeat(20000) }) }],
      ["html in a text field", "/branches", {
        method: "POST", body: JSON.stringify({ name: "<script>alert(1)</script>", region_id: crypto.randomUUID() })
      }]
    ];
    for (const [label, path, init] of injCases) {
      const r = await call(path, directorToken, init as any);
      const clean = r.status < 500 &&
        !/syntax error at or near|unrecognized|does not exist|violates foreign key/i.test(r.text) &&
        !r.text.includes("node_modules");
      check(`${label} → ${r.status} without an engine error`, clean, r.text.slice(0, 140));
    }
    const usersStill = await oi(`select to_regclass('public.users') as t`);
    check("the users table survived every injection attempt", usersStill.rows[0].t === "users");

    const board = await call("/board", directorToken);
    const boardKeys = keysOf(board.json);
    const boardBad = boardKeys.filter((k) => BOARD_FORBIDDEN_KEYS.includes(k));
    check("board payload carries none of the denylisted keys",
      board.status === 200 && boardBad.length === 0, { bad: boardBad, n: (board.json?.items ?? board.json ?? []).length });
    check("no seeded money or NIDA value appears anywhere on the board",
      !board.text.includes(NIDA) && !board.text.includes("1311110") && !board.text.includes(PHONE),
      board.text.slice(0, 100));

    const leaked = transcript.filter((r) => LEAK_MARKERS.some((m) => r.text.includes(m)));
    check(`${transcript.length} responses, none carrying a credential column or stack frame`,
      leaked.length === 0, leaked.map((r) => `${r.status} ${r.text.slice(0, 80)}`));
    const fives = transcript.filter((r) => r.status >= 500);
    check("no 5xx from the whole suite", fives.length === 0, fives.map((r) => r.status));

    const audit = await oi(
      `select count(*)::int as n,
              count(*) filter (where action = 'login_failed')::int as bad_password,
              position($2::text in coalesce(string_agg(after::text, ' '), '')) > 0
                 or position($3::text in coalesce(string_agg(after::text, ' '), '')) > 0 as carries_secret
       from audit_logs where tenant_id = $1`, [tenantId, PASSWORD, NIDA]);
    check("this tenant's writes and failed logins were audited",
      audit.rows[0].n > 0 && audit.rows[0].bad_password > 0, audit.rows[0]);
    check("audit payloads never carry the password or the NIDA number",
      audit.rows[0].carries_secret === false, audit.rows[0]);
    // An unknown identity belongs to no tenant, so its anomaly row is written
    // with tenant_id null on purpose — it is the platform-wide feed, not a
    // company record. Proved separately from the tenant-scoped count above.
    const anomaly = await oi(
      `select count(*)::int as n from audit_logs
       where action = 'login_failed.unknown' and tenant_id is null
         and ts > now() - interval '15 minutes'`);
    check("every attempt against an unknown identity is recorded", anomaly.rows[0].n > 0, anomaly.rows[0]);
    const auditMutation = await call("/audit-logs", directorToken, { method: "DELETE" });
    check("there is no audit-mutating endpoint", auditMutation.status === 404, auditMutation.status);

    // ======================================================================
    phase("K · login throttle");
    await clearBuckets("login:");
    let got429 = 0;
    for (let i = 0; i < 14; i++) {
      const r = await call("/auth/login", null, {
        method: "POST", body: JSON.stringify({
          // A well-formed transporter login (tin + email + password) so the
          // server actually reaches the credential check and answers 401 for
          // an unknown identity — a 400 would never fill the login bucket.
          mode: "transporter", tin: TIN,
          email: `probe${i}.${STAMP}@waisha.test`, password: PASSWORD
        })
      });
      if (r.status === 429) got429++;
    }
    check("sustained login probing is throttled with 429", got429 > 0, { got429 });
  } finally {
    console.log("\n--- teardown ---");
    const tids = [tenantId].filter(Boolean);
    await wipeTenant(tids);
    await clearBuckets("login:", "signup:", "otp:", "forgot:", "reset:", "control:", "ip:");

    const residue = await oi(
      `select (select count(*) from users where tenant_id = any($1::uuid[]))::int as users,
              (select count(*) from tenants where id = any($1::uuid[]))::int as tenants,
              (select count(*) from sessions where user_id = any($1::uuid[]))::int as sessions,
              (select count(*) from otp_codes where user_id = any($1::uuid[]))::int as otps,
              (select count(*) from password_resets where user_id = any($1::uuid[]))::int as resets,
              (select count(*) from rate_limits) as buckets_left,
              (select count(*) from audit_logs where tenant_id = any($1::uuid[]))::int as audit_rows`,
      [tids.length ? tids : ["00000000-0000-0000-0000-000000000000"]]);
    const R = residue.rows[0];
    console.log(`residue: users=${R.users} tenants=${R.tenants} sessions=${R.sessions} otp=${R.otps} ` +
      `resets=${R.resets} | audit rows kept=${R.audit_rows} | rate_limit rows=${R.buckets_left}`);
    check("fixture teardown left nothing behind",
      R.users === 0 && R.tenants === 0 && R.sessions === 0 && R.otps === 0 && R.resets === 0, R);
    await owner.end();
  }

  console.log(failures ? `${failures} FAILED` : "all breach-attempt checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
