/**
 * Control analytics, the cost ledger and the forensic audit reader — smoke (066).
 *
 * Drives the routes added for #102 against a running API (port 4000) with three
 * platform fixtures whose only difference is their duty: a super_admin, a
 * customer_service_agent (analytics and nothing else) and a director who holds no
 * control key at all. That trio is the point of the script — get_control_session
 * returns roles only, so until these routes asked role_permissions for permission
 * keys, hasLicenceRole was the whole of the control panel's authorisation and an
 * analyst could not be stopped from the money by anything.
 *
 * What it proves:
 *  - the door is a cookie, not a bearer token (a staff JWT alone gets 401);
 *  - the numbers are the DATABASE's numbers. Every aggregate here is cross-tenant, so
 *    it has to come out of a SECURITY DEFINER function; a bare pool query would have
 *    RLS answer zero rows and the panel would look healthy and empty. The overview is
 *    therefore compared against the same count taken straight off the owner
 *    connection, and the chart fields are checked to be JSON numbers, because pg hands
 *    bigint and numeric back as strings and a chart given "7" draws nothing;
 *  - the cost ledger feeds the profit line through HTTP: the P&L is read before and
 *    after a write, and the month's costs must move by exactly the amount recorded;
 *  - the (period, category) key replaces instead of appending, so a month reported
 *    twice keeps one figure, and the correction lands in the trail as
 *    control.costs.corrected with the old amount in `before`;
 *  - the audit reader resolves the actor but redacts the payload: NIDA, TIN, phone,
 *    email, password and OTP values are blanked at every depth and inside arrays,
 *    while the safe keys survive so the screen still says what changed.
 *
 * The probe trail row is inserted directly, with values that are obviously synthetic:
 * audit_logs is append-only, so nothing here can remove it again — which is also why
 * the fake sentinels are on the leak list rather than checked away.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-control-analytics.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const EMAIL_SWEEP = `smoke.ctl.%@waisha.test`;
const TENANT_SWEEP = 'Ctl Smoke %';
const SA_NAME = "Ctl Smoke Super Admin";
const CS_NAME = "Ctl Smoke Service Agent";
const DIR_NAME = "Ctl Smoke Director";

/** Values the redactor must never let reach a browser. */
const SENTINELS = ["NIDA-FAKE-DO-NOT-READ-99999", "75FAKE12345", "FAKE-PHONE-1111",
  "hunter2", "probe.secret.do.not.read", "NESTED-FAKE-42"];

const pad = (n: number) => String(n).padStart(2, "0");
const monthKeyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const P_NOW = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
const P_LAST = monthKeyOf(new Date(now.getFullYear(), now.getMonth() - 1, 1));

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

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

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const clearBuckets = async (...prefixes: string[]) => {
    for (const p of prefixes) await oi(`delete from rate_limits where bucket like $1`, [`${p}%`]);
  };

  const roleOf = async (k: string) => (await oi(
    `select id from roles where key = $1 and tenant_id is null`, [k])).rows[0]?.id;
  const superAdminRole = await roleOf("super_admin");
  const csRole = await roleOf("customer_service_agent");
  const directorRole = await roleOf("director");
  if (!superAdminRole || !csRole || !directorRole) {
    throw new Error("global super_admin / customer_service_agent / director role missing");
  }

  const TC = randomUUID();
  const uSA = randomUUID(), uCS = randomUUID(), uDIR = randomUUID();
  const TOK_SA = `ctl-smoke-sa-${STAMP}`;
  const TOK_CS = `ctl-smoke-cs-${STAMP}`;
  const TOK_DIR = `ctl-smoke-dir-${STAMP}`;
  const cookieSA = { Cookie: `waisha_control=${TOK_SA}` };
  const cookieCS = { Cookie: `waisha_control=${TOK_CS}` };
  const cookieDIR = { Cookie: `waisha_control=${TOK_DIR}` };
  const ourTenants = [TC];

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
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    }
    await oi(`delete from platform_costs where created_by = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await clearBuckets("analytics:", "costs:", "audit:");

  // ---------------- fixtures ----------------
  await oi(`insert into tenants (id, type, name, status) values ($1,'platform',$2,'active')`,
    [TC, `Ctl Smoke Platform ${STAMP}`]);
  const ctlUser = async (id: string, name: string, email: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, status, email, totp_enabled)
        values ($1,$2,'platform',$3,'active',$4,true)`, [id, TC, name, email]);
  await ctlUser(uSA, SA_NAME, `smoke.ctl.sa.${STAMP}@waisha.test`);
  await ctlUser(uCS, CS_NAME, `smoke.ctl.cs.${STAMP}@waisha.test`);
  await ctlUser(uDIR, DIR_NAME, `smoke.ctl.dir.${STAMP}@waisha.test`);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uSA, superAdminRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uCS, csRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uDIR, directorRole]);
  const openSession = async (uid: string, token: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-control-analytics',$6,
          now() + interval '2 hours')`,
      [randomUUID(), uid, TC, randomUUID(), sha256(token), "127.0.0.1"]);
  await openSession(uSA, TOK_SA);
  await openSession(uCS, TOK_CS);
  await openSession(uDIR, TOK_DIR);

  // A staff token for the same company: the control surface must not accept it.
  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);
  const tokDirector = await mint(uDIR, TC, ["director"]);

  // A trail row that carries PII, written the way the app writes real ones.
  const PROBE_AFTER = {
    status: "paid", amount: 42, note: "cleared at the ward office",
    nida_number: SENTINELS[0], tin: SENTINELS[1], phone: SENTINELS[2],
    password: SENTINELS[3], otp_code: SENTINELS[4], phone_encrypted: SENTINELS[5],
    items: [{ tin: SENTINELS[1], line: "bond" }, "plain string"],
    nested: { secret: SENTINELS[5], visible: "still here" }
  };
  await oi(`insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity,
             action, before, after)
           values ($1,$2,$3,'super_admin','127.0.0.1','smoke_control_probe',
             'smoke.control.pii_probe', '{}'::jsonb, $4::jsonb)`,
    [randomUUID(), TC, uSA, JSON.stringify(PROBE_AFTER)]);

  try {
    // ---------------- the door ----------------
    phase("authentication");
    const anon = await call("/control/analytics/overview", null);
    check("an anonymous request is turned away before any aggregate is computed",
      anon.status === 401 && anon.json?.error?.code === "TOKEN_EXPIRED",
      { s: anon.status, e: anon.json?.error?.code });

    const forged = await call("/control/analytics/overview", null, {
      headers: { Cookie: `waisha_control=ctl-smoke-forged-${STAMP}` }
    });
    check("a cookie with no session row behind it is refused",
      forged.status === 401, { s: forged.status });

    const bearerOnly = await call("/control/analytics/overview", tokDirector);
    check("a staff bearer token does not open the control surface — the cookie does",
      bearerOnly.status === 401, { s: bearerOnly.status });

    const anonWrite = await call("/control/costs", null, {
      method: "POST", body: JSON.stringify({ period: P_NOW, category: "support", amount: 1 })
    });
    check("the ledger cannot be written anonymously", anonWrite.status === 401, { s: anonWrite.status });

    const anonAudit = await call("/control/audit?limit=5", null);
    check("the forensic trail cannot be read anonymously", anonAudit.status === 401, { s: anonAudit.status });

    // ---------------- whose duty is it ----------------
    phase("permission gate");
    const pSA = await call("/control/auth/permissions", null, { headers: cookieSA });
    const heldSA: string[] = pSA.json?.permissions ?? [];
    check("the super admin's permissions come from role_permissions, not the session roles",
      pSA.status === 200 && (pSA.json?.roles ?? []).includes("super_admin") &&
      ["control.analytics.view", "control.costs.manage", "control.audit.view",
        "control.tenants.manage"].every((k) => heldSA.includes(k)),
      { s: pSA.status, roles: pSA.json?.roles, n: heldSA.length });

    const pCS = await call("/control/auth/permissions", null, { headers: cookieCS });
    const heldCS: string[] = pCS.json?.permissions ?? [];
    check("customer service sees the counts and nothing else",
      pCS.status === 200 && heldCS.includes("control.analytics.view") &&
      !heldCS.includes("control.costs.manage") && !heldCS.includes("control.audit.view"),
      { perms: heldCS });

    const pDIR = await call("/control/auth/permissions", null, { headers: cookieDIR });
    check("a company role signed into the control shell holds no control key",
      pDIR.status === 200 && (pDIR.json?.permissions ?? []).length === 0,
      { perms: pDIR.json?.permissions });

    const csOverview = await call("/control/analytics/overview", null, { headers: cookieCS });
    check("the analyst duty really is a duty: overview answers 200 for customer service",
      csOverview.status === 200, { s: csOverview.status });

    const csAudit = await call("/control/audit?limit=5", null, { headers: cookieCS });
    check("…and the same token is refused the forensic trail",
      csAudit.status === 403 && csAudit.json?.error?.code === "FORBIDDEN",
      { s: csAudit.status, m: csAudit.json?.error?.message });

    const csWrite = await call("/control/costs", null, {
      method: "POST", headers: cookieCS,
      body: JSON.stringify({ period: P_NOW, category: "support", amount: 1 })
    });
    check("…and cannot put a figure into the platform's own books",
      csWrite.status === 403, { s: csWrite.status });

    const dirOverview = await call("/control/analytics/overview", null, { headers: cookieDIR });
    check("a valid control session with no analytics permission is 403, not 200-and-empty",
      dirOverview.status === 403, { s: dirOverview.status });

    const dirLedger = await call("/control/costs", null, { headers: cookieDIR });
    check("the ledger is closed to the same role", dirLedger.status === 403, { s: dirLedger.status });

    // ---------------- the landing numbers are the database's numbers ----------------
    phase("overview");
    const ov = await call("/control/analytics/overview", null, { headers: cookieSA });
    const o = ov.json ?? {};
    check("every block the landing screen reads is present",
      ov.status === 200 && ["companies", "seekers", "users", "subscriptions", "recurring",
        "money", "passes", "costs", "marketplace", "activity"].every((b) => o[b]) &&
      o.currency === "TZS" && !!o.generated_at,
      { s: ov.status, keys: Object.keys(o) });

    const live = (await oi(
      `select (select count(*) from tenants where type='transporter' and deleted_at is null)::int as tr,
              (select count(*) from invoices where status='paid' and deleted_at is null)::int as paid,
              (select count(*) from users where user_type<>'platform' and deleted_at is null)::int as staff`)).rows[0];
    check("the cross-tenant counts match the database, so RLS is not quietly returning zero",
      o.companies?.transporters === live.tr && o.money?.invoices_paid_all_time === live.paid &&
      o.users?.total === live.staff && live.tr > 0,
      { api: [o.companies?.transporters, o.money?.invoices_paid_all_time, o.users?.total],
        db: [live.tr, live.paid, live.staff] });

    check("a platform shell is not counted as a customer",
      o.companies?.total === (o.companies?.transporters ?? 0) + (o.companies?.shippers ?? 0),
      { companies: o.companies?.total, split: [o.companies?.transporters, o.companies?.shippers] });

    check("the money blocks arrive as numbers, not as pg's strings",
      [o.money?.collected_30d, o.money?.outstanding, o.recurring?.mrr, o.recurring?.arr,
        o.costs?.month, o.seekers?.total].every((v: any) => typeof v === "number"),
      { money: typeof o.money?.collected_30d, mrr: typeof o.recurring?.mrr });

    check("active versus non-active is answered by status and by sign-in both",
      typeof o.users?.active === "number" && typeof o.users?.dormant_30d === "number" &&
      typeof o.users?.logged_in_today === "number" &&
      (o.users?.active ?? -1) + (o.users?.suspended ?? 0) + (o.users?.deactivated ?? 0) +
        (o.users?.pending_verification ?? 0) <= (o.users?.total ?? 0),
      o.users);

    // ---------------- growth ----------------
    phase("growth");
    const gr = await call("/control/analytics/growth?months=12", null, { headers: cookieSA });
    const g = gr.json ?? [];
    const monthsOk = (rows: any[]) => rows.every((r) => /^\d{4}-\d{2}-01$/.test(r.month)) &&
      rows.every((r, i) => i === 0 || r.month > rows[i - 1].month);
    check("twelve closed-to-running months, ascending, each keyed to the first of its month",
      gr.status === 200 && g.length === 12 && monthsOk(g),
      { s: gr.status, n: g.length, first: g[0]?.month, last: g[g.length - 1]?.month });

    check("the axis ends on the running month and the counts are JSON numbers",
      g[g.length - 1]?.month === P_NOW &&
      g.every((r: any) => ["new_companies", "new_seekers", "new_users", "activated",
        "lapsed", "searches"].every((k) => typeof r[k] === "number")),
      { last: g[g.length - 1]?.month, types: Object.keys(g[0] ?? {}).map((k) => `${k}:${typeof (g[0] as any)[k]}`) });

    const grShort = await call("/control/analytics/growth?months=3", null, { headers: cookieSA });
    check("the window is honoured rather than ignored",
      grShort.status === 200 && (grShort.json ?? []).length === 3 &&
      grShort.json[2].month === P_NOW,
      { n: grShort.json?.length });

    const grBad = await call("/control/analytics/growth?months=1", null, { headers: cookieSA });
    check("a one-month window is refused: a growth line needs a history",
      grBad.status === 400, { s: grBad.status });

    // ---------------- the P&L ----------------
    phase("revenue and the cost ledger");
    const rvBefore = await call("/control/analytics/revenue?months=6", null, { headers: cookieSA });
    const r6 = rvBefore.json ?? [];
    const thisMonth = r6[r6.length - 1];
    check("six months of P&L with every line a number and the arithmetic its own",
      rvBefore.status === 200 && r6.length === 6 && r6.every((r: any) =>
        ["subscription_income", "pass_income", "gross", "vat", "net", "costs", "profit",
          "paid_invoices", "paid_passes"].every((k) => typeof r[k] === "number") &&
        Math.abs(r.gross - (r.subscription_income + r.pass_income)) < 0.011 &&
        Math.abs(r.net - (r.gross - r.vat)) < 0.011 &&
        Math.abs(r.profit - (r.net - r.costs)) < 0.011),
      { s: rvBefore.status, n: r6.length, row: r6[0] });

    const A1 = 1234567.5;
    const w1 = await call("/control/costs", null, {
      method: "POST", headers: cookieSA,
      body: JSON.stringify({ period: P_NOW, category: "support", amount: A1, note: `ctl smoke ${STAMP}` })
    });
    check("a cost lands on its own month with the currency the table insists on",
      w1.status === 200 && w1.json?.period === P_NOW && w1.json?.category === "support" &&
      w1.json?.currency === "TZS" && Math.abs(Number(w1.json?.amount) - A1) < 0.001,
      { s: w1.status, b: w1.json });

    const rvAfter = await call("/control/analytics/revenue?months=6", null, { headers: cookieSA });
    const afterWrite = (rvAfter.json ?? [])[rvAfter.json.length - 1];
    check("the profit line moves by exactly what was just recorded — the ledger is really joined",
      Math.abs(afterWrite.costs - (thisMonth.costs + A1)) < 0.001 &&
      Math.abs(afterWrite.profit - (thisMonth.profit - A1)) < 0.001,
      { before: [thisMonth.costs, thisMonth.profit], after: [afterWrite.costs, afterWrite.profit] });

    const A2 = 500000;
    const w2 = await call("/control/costs", null, {
      method: "POST", headers: cookieSA,
      body: JSON.stringify({ period: P_NOW, category: "support", amount: A2, note: `corrected ${STAMP}` })
    });
    const ledger = await call(`/control/costs?from=${P_NOW}`, null, { headers: cookieSA });
    const mine = (ledger.json ?? []).filter((r: any) => r.period === P_NOW && r.category === "support");
    check("re-recording a month replaces the figure instead of sitting next to it",
      w2.status === 200 && mine.length === 1 && Math.abs(mine[0].amount - A2) < 0.001,
      { s: w2.status, rows: mine });

    const rvFixed = await call("/control/analytics/revenue?months=6", null, { headers: cookieSA });
    const afterFix = (rvFixed.json ?? [])[rvFixed.json.length - 1];
    check("and the corrected number is the one the P&L reports",
      Math.abs(afterFix.costs - A2) < 0.001 && Math.abs(afterFix.profit - (afterFix.net - A2)) < 0.001,
      { costs: afterFix.costs, profit: afterFix.profit });

    const w3 = await call("/control/costs", null, {
      method: "POST", headers: cookieSA,
      body: JSON.stringify({ period: P_LAST, category: "marketing", amount: 999.99 })
    });
    const ovCosts = await call("/control/analytics/overview", null, { headers: cookieSA });
    check("the overview's own cost block reads the same ledger",
      w3.status === 200 && Math.abs(ovCosts.json?.costs?.month - A2) < 0.001 &&
      ovCosts.json?.costs?.months_recorded >= 2,
      { costs: ovCosts.json?.costs, month: ovCosts.json?.costs?.month });

    const badPeriod = await call("/control/costs", null, {
      method: "POST", headers: cookieSA,
      body: JSON.stringify({ period: P_NOW.slice(0, 8) + "15", category: "support", amount: 10 })
    });
    check("a cost that is not keyed to a month is refused", badPeriod.status === 400,
      { s: badPeriod.status, e: badPeriod.json?.error?.code });

    const badAmount = await call("/control/costs", null, {
      method: "POST", headers: cookieSA,
      body: JSON.stringify({ period: P_NOW, category: "support", amount: -5 })
    });
    check("a negative cost is refused at the door, not by a CHECK six seconds later",
      badAmount.status === 400, { s: badAmount.status });

    const badCategory = await call("/control/costs", null, {
      method: "POST", headers: cookieSA,
      body: JSON.stringify({ period: P_NOW, category: "petrol", amount: 5 })
    });
    check("an invented category is refused, so the ledger stays summable",
      badCategory.status === 400, { s: badCategory.status });

    const usd = await call("/control/costs", null, {
      method: "POST", headers: cookieSA,
      body: JSON.stringify({ period: P_NOW, category: "support", amount: 5, currency: "USD" })
    });
    check("a caller cannot smuggle another currency into a TZS ledger",
      usd.status === 400, { s: usd.status });

    // ---------------- forecast ----------------
    phase("forecast");
    const fc = await call("/control/analytics/forecast?months=12&horizon=3", null, { headers: cookieSA });
    const fm = fc.json?.metrics ?? {};
    const names = Object.keys(fm);
    check("every line the board charts is fitted, not just the money",
      fc.status === 200 && fc.json?.currency === "TZS" && names.length === 7 &&
      ["subscription_income", "pass_income", "net_income", "costs", "profit",
        "new_companies", "new_seekers"].every((k) => names.includes(k)),
      { s: fc.status, names });

    const perMetric = names.map((k) => {
      const s = fm[k].series as any[];
      const actuals = s.filter((p) => p.actual !== null);
      const projected = s.filter((p => p.projected !== null));
      return {
        k,
        twelve: actuals.length === 12,
        closedOnly: actuals[actuals.length - 1]?.month === P_LAST,
        threeAhead: projected.length === 3,
        noOverlap: projected.every((p) => p.actual === null) &&
          actuals.every((a) => a.projected === null),
        afterLast: projected.every((p) => p.month > P_LAST),
        ordered: s.every((p, i) => i === 0 || p.month > s[i - 1].month),
        numbers: s.every((p) => (p.actual === null || typeof p.actual === "number") &&
          (p.projected === null || typeof p.projected === "number")),
        bounded: fm[k].fit_r2 === null || (fm[k].fit_r2 >= 0 && fm[k].fit_r2 <= 1),
        neverNegative: projected.every((p) => p.projected >= 0)
      };
    });
    check("a fit is anchored on the last CLOSED month, projects the horizon, and never claims " +
      "a month is both actual and projected",
      perMetric.every((m) => m.twelve && m.closedOnly && m.threeAhead && m.noOverlap &&
        m.afterLast && m.ordered && m.numbers && m.bounded && m.neverNegative),
      perMetric.filter((m) => Object.entries(m).slice(1).some(([, v]) => v === false)));

    check("the cost line's slope is a number the panel can describe, and the fit is a fraction",
      typeof fm.costs?.slope === "number" && typeof fm.costs?.fit_r2 === "number",
      { slope: fm.costs?.slope, r2: fm.costs?.fit_r2 });

    const fcBad = await call("/control/analytics/forecast?months=12&horizon=99", null, { headers: cookieSA });
    check("a horizon past two years is refused — a forecast that long is a wish",
      fcBad.status === 400, { s: fcBad.status });

    // ---------------- the forensic trail ----------------
    phase("audit reader");
    const costsTrail = await call("/control/audit?action=control.costs&limit=50", null, { headers: cookieSA });
    const cw = (costsTrail.json ?? []).filter((r: any) => r.entity === "platform_costs");
    const corrected = cw.find((r: any) => r.action === "control.costs.corrected");
    const recorded = cw.find((r: any) => r.action === "control.costs.recorded");
    check("both writes are in the trail, attributed to the person who signed in",
      costsTrail.status === 200 && cw.length >= 3 && !!recorded && !!corrected &&
      corrected.actor_name === SA_NAME && corrected.actor_email === `smoke.ctl.sa.${STAMP}@waisha.test` &&
      corrected.tenant_name === `Ctl Smoke Platform ${STAMP}` && corrected.actor_role === "super_admin",
      { n: cw.length, who: corrected?.actor_name, tenant: corrected?.tenant_name });

    check("the correction carries the figure it replaced, so a mistake is auditable",
      Math.abs(Number(corrected?.before?.amount) - A1) < 0.001 &&
      Math.abs(Number(corrected?.after?.amount) - A2) < 0.001 &&
      corrected?.after?.period === P_NOW,
      { before: corrected?.before, after: corrected?.after });

    const probe = await call("/control/audit?entity=smoke_control_probe", null, { headers: cookieSA });
    const pr = (probe.json ?? [])[0];
    const after = pr?.after ?? {};
    check("PII values are blanked at the top level, in a nested object and inside an array",
      probe.status === 200 && after.nida_number === "[redacted]" && after.tin === "[redacted]" &&
      after.phone === "[redacted]" && after.password === "[redacted]" &&
      after.otp_code === "[redacted]" && after.phone_encrypted === "[redacted]" &&
      after.nested?.secret === "[redacted]" && after.items?.[0]?.tin === "[redacted]",
      { after });

    check("the keys and the safe values survive, so the screen still says what changed",
      after.status === "paid" && after.amount === 42 &&
      after.note === "cleared at the ward office" && after.nested?.visible === "still here" &&
      after.items?.[0]?.line === "bond" && after.items?.[1] === "plain string" &&
      after.items.length === 2,
      { after });

    const byActor = await call(`/control/audit?actorUserId=${uSA}&limit=20`, null, { headers: cookieSA });
    check("the trail filters to one person and every row is theirs",
      byActor.status === 200 && (byActor.json ?? []).length >= 4 &&
      byActor.json.every((r: any) => r.actor_user_id === uSA),
      { n: byActor.json?.length });

    const byQ = await call(`/control/audit?q=${encodeURIComponent(SA_NAME)}`, null, { headers: cookieSA });
    check("searching the trail by a person's name finds that person and nobody else",
      byQ.status === 200 && (byQ.json ?? []).length >= 3 &&
      byQ.json.every((r: any) => r.actor_name === SA_NAME),
      { n: byQ.json?.length, names: [...new Set((byQ.json ?? []).map((r: any) => r.actor_name))] });

    const window = await call(`/control/audit?from=${monthKeyOf(new Date(now.getTime() + 86400000))}`,
      null, { headers: cookieSA });
    check("a window that has not happened yet returns nothing rather than everything",
      window.status === 200 && (window.json ?? []).length === 0, { n: window.json?.length });

    const capped = await call("/control/audit?limit=500", null, { headers: cookieSA });
    const greedy = await call("/control/audit?limit=5000", null, { headers: cookieSA });
    check("the reader caps the page and refuses to be asked for more than the cap",
      capped.status === 200 && (capped.json ?? []).length <= 500 && greedy.status === 400,
      { n: capped.json?.length, greedy: greedy.status });

    const badUuid = await call(`/control/audit?actorUserId=not-a-uuid`, null, { headers: cookieSA });
    check("a malformed filter is a 400, not a query that silently returns the whole log",
      badUuid.status === 400, { s: badUuid.status });

    const acts = await call("/control/audit/actions?days=2", null, { headers: cookieSA });
    const costAction = (acts.json ?? []).find((r: any) => r.action === "control.costs.recorded");
    check("the filter pick-list is built from the log itself, newest first",
      acts.status === 200 && (acts.json ?? []).length > 1 && !!costAction &&
      /^\d{4}-\d{2}-\d{2}T/.test(String(costAction.last_seen)) &&
      typeof costAction.events === "number" &&
      acts.json.every((r: any, i: number) => i === 0 || r.events <= acts.json[i - 1].events),
      { n: acts.json?.length, costAction });

    const dirAudit = await call("/control/audit?limit=5", null, { headers: cookieDIR });
    check("a valid session with no audit permission cannot read anybody's trail",
      dirAudit.status === 403, { s: dirAudit.status });

    // ---------------- nothing leaks ----------------
    // The reader keeps a payload's KEY names and blanks its values, because the
    // forensic screen has to say which field changed — so the invariant is about
    // values, and it is asserted over every row the biggest page returned rather than
    // only over the probe.
    phase("leak scan");
    const PII_KEY = /(encrypted|_search$|^tin$|nida|password|passwd|secret|token|otp|pin$|phone|mobile|email|address|passport|visa|national_id|licence_no|license_no)/i;
    const unredacted = (v: any, out: string[] = []): string[] => {
      if (Array.isArray(v)) v.forEach((e) => unredacted(e, out));
      else if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          if (PII_KEY.test(k) && val !== "[redacted]") out.push(`${k}=${JSON.stringify(val)}`);
          unredacted(val, out);
        }
      }
      return out;
    };
    const dirty = (capped.json ?? []).flatMap((r: any) =>
      [...unredacted(r.before), ...unredacted(r.after)]);
    check("across a whole page of real payloads, every PII-named field carries the marker",
      dirty.length === 0, dirty.slice(0, 6));

    const LEAKS = [...SENTINELS, "syntax error at or near", "duplicate key value violates",
      "node_modules", "Postgres"];
    const hit = LEAKS.filter((m) => bodies.some((b) => b.includes(m)));
    check("no PII value and no engine string ever reached a client", hit.length === 0, hit);
  } finally {
    // ---------------- teardown ----------------
    phase("teardown");
    await oi(`delete from platform_costs where created_by = any($1::uuid[])`, [[uSA, uCS, uDIR]])
      .catch(() => { });
    await oi(`delete from user_roles where user_id = any($1::uuid[])`, [[uSA, uCS, uDIR]]).catch(() => { });
    await oi(`delete from sessions where user_id = any($1::uuid[])`, [[uSA, uCS, uDIR]]).catch(() => { });
    await clearBuckets("analytics:", "costs:", "audit:");
    await oi(`delete from users where id = any($1::uuid[])`, [[uSA, uCS, uDIR]]).catch(() => { });
    await oi(`delete from tenants where id = any($1::uuid[])`, [ourTenants]).catch(() => { });
    await sweep();

    const residue = await oi(
      `select (select count(*) from platform_costs where created_by = any($1::uuid[])) as costs,
              (select count(*) from sessions where user_id = any($1::uuid[])) as sessions,
              (select count(*) from user_roles where user_id = any($1::uuid[])) as roles,
              (select count(*) from users where id = any($1::uuid[])) as users,
              (select count(*) from tenants where id = any($1::uuid[])) as tenants,
              (select count(*) from tenants where name like $2) as smoke_tenants,
              (select count(*) from users where email like $3) as smoke_users,
              (select count(*) from rate_limits where bucket like 'analytics:%'
                or bucket like 'costs:%' or bucket like 'audit:%') as buckets`,
      [[uSA, uCS, uDIR], TENANT_SWEEP, EMAIL_SWEEP]);
    check("cleanup: no fixture rows left (the probe trail entry stays — audit_logs is append-only)",
      Object.values(residue.rows[0]).every((n: any) => Number(n) === 0), residue.rows[0]);
    await owner.end();
  }

  console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILURE(S)`} — smoke-control-analytics`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
