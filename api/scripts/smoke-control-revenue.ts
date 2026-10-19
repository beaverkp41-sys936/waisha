/**
 * The money half of the admin panel — smoke for #104 over HTTP (routes on 068).
 *
 * Six seats on the desk whose only difference is their duty, one transporter that the
 * office sells a bundle to through the real activation endpoint, and one seeker whose
 * pass the office confirms through the real verification endpoint. That is the shape
 * this stage needs: the register and the ledger are only correct if the rows they read
 * are the rows the office wrote, and both of those writes already had their own smokes.
 *
 * What it proves:
 *  - reading money is a duty of its own, and support_engineer — the seat that fixes
 *    faults — does not have it;
 *  - a bundle sold over HTTP lands on the subscription, prices its invoice from the
 *    bundle, and is then priced that way by the register, the ledger and the mix;
 *  - re-selling on the ladder clears the bundle rather than leaving both true;
 *  - the ledger keeps the two money clocks: an invoice that is only issued has no
 *    money date, and neither has a pass whose reference is still queued — then the
 *    verify endpoint turns it into money and the ledger follows;
 *  - the register's total line describes the whole filtered set, not the page shown;
 *  - a price the desk moves is the price every customer reads a second later,
 *    and the correction is written to the trail with the figure it replaced;
 *  - an exit recorded by the seat that sells moves the churn figures by exactly that
 *    customer's month, does not touch the company's licence, cannot be written twice, and
 *    is read as a return rather than a second exit when the office sells to them again;
 *  - nothing in these payloads carries a phone number, an email, a NIDA or a TIN.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-control-revenue.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";

const STAMP = Date.now().toString().slice(-8);
const TENANT_SWEEP = "Revenue Smoke %";
const EMAIL_SWEEP = `smoke.revenue.%@waisha.test`;
const COMPANY = `Revenue Smoke Freight ${STAMP}`;
const SEEKER_NAME = `Rasiga ${STAMP}`;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const bodies: string[] = [];
async function call(path: string, cookie: Record<string, any> = {}) {
  const res = await fetch(`${API}${path}`, {
    ...cookie, headers: { ...(cookie.headers ?? {}) }
  });
  const text = await res.text();
  bodies.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function send(path: string, cookie: Record<string, any>, body: unknown,
  method = "POST") {
  const res = await fetch(`${API}${path}`, {
    method, headers: { ...cookie.headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  bodies.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

/** Every key in a payload, at any depth. A key only carries contact data when its value
 *  does: `email_verified: 41` is a count of seekers, and it belongs on the overview. */
function walk(node: unknown, out: { pii: string[]; values: string[] } = { pii: [], values: [] }) {
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return out; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (PII_KEY.test(k) && v !== null && typeof v !== "number" && typeof v !== "boolean")
        out.pii.push(`${k}=${JSON.stringify(v)}`);
      if (typeof v === "string") out.values.push(v);
      walk(v, out);
    }
  } else if (typeof node === "string") out.values.push(node);
  return out;
}
const PII_KEY = /encrypted|_search$|^tin$|nida|password|secret|token|otp|phone|mobile|email/i;
// A +255 subscriber number, however written: 07X XXX XXXX or +255 7X XXX XXXX. Anchored
// on both sides, because an unanchored "7 plus digits" also matches the uuid and the
// timestamp every one of these payloads carries.
const PHONE_SHAPE = /(^|[^\d])(\+?255|0)?[\s-]?7\d{2}[\s-]?\d{3}[\s-]?\d{3}($|[^\d])/;
// Ids, references and instants are not contact details, and long hex strings are where
// a uuid would otherwise trip the shape above.
const ID_SHAPE = /[0-9a-fA-F-]{16,}/;

const ck = (who: string) => ({ headers: { Cookie: `waisha_control=revenue-smoke-${who}-${STAMP}` } });

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (!all.length) return;
    await oi(`delete from seeker_search_passes where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    await oi(`delete from seekers where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    }
    await oi(`delete from subscription_cancellations where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    await oi(`delete from payments where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    await oi(`delete from invoices where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    await oi(`delete from subscriptions where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    await oi(`delete from audit_logs where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  for (const b of ["register:", "ledger:", "bundles:", "activate:", "pass-verify:",
    "cancel:", "churn:"]) {
    await oi(`delete from rate_limits where bucket like $1`, [`${b}%`]);
  }

  const roles = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "billing_admin", "platform_analyst", "compliance_officer",
      "customer_service_agent", "support_engineer", "director"]]
  )).rows;
  const rid = (k: string) => roles.find((r: any) => r.key === k)?.id;
  if (!rid("super_admin") || !rid("billing_admin") || !rid("support_engineer")) {
    throw new Error("platform duty roles missing — seed 005 has not run");
  }

  // ---------------- fixtures ----------------
  const TC = randomUUID();      // the desk
  const TT = randomUUID();      // the company the office sells
  const TS = randomUUID();      // the seeker's own tenant
  const TD = randomUUID();      // a company tenant for the director seat
  const uSA = randomUUID(), uBILL = randomUUID(), uAN = randomUUID(),
    uSE = randomUUID(), uCS = randomUUID(), uDIR = randomUUID();

  await oi(`insert into tenants (id, type, name, status) values
      ($1,'platform',$2,'active'), ($3,'transporter',$4,'pending_verification'),
      ($5,'seeker',$6,'active'), ($7,'transporter',$8,'active')`,
    [TC, `Revenue Smoke Platform ${STAMP}`, TT, COMPANY,
      TS, `Revenue Smoke Seeker ${STAMP}`, TD, `Revenue Smoke Other ${STAMP}`]);

  const seat = (id: string, tenant: string, type: string, name: string, email: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
             last_login_at)
        values ($1,$2,$3,$4,$5,'active',true, now() - interval '10 minutes')`,
      [id, tenant, type, name, email]);
  await seat(uSA, TC, "platform", "Sam Admin", `smoke.revenue.sa.${STAMP}@waisha.test`);
  await seat(uBILL, TC, "platform", "Bella Billing", `smoke.revenue.bill.${STAMP}@waisha.test`);
  await seat(uAN, TC, "platform", "Annie Analyst", `smoke.revenue.an.${STAMP}@waisha.test`);
  await seat(uSE, TC, "platform", "Samson Support", `smoke.revenue.se.${STAMP}@waisha.test`);
  await seat(uCS, TC, "platform", "Cally Service", `smoke.revenue.cs.${STAMP}@waisha.test`);
  await seat(uDIR, TD, "staff", "Daudi Director", `smoke.revenue.dir.${STAMP}@waisha.test`);

  await oi(`insert into user_roles (user_id, role_id) values
      ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10),($11,$12)`,
    [uSA, rid("super_admin"), uBILL, rid("billing_admin"), uAN, rid("platform_analyst"),
      uSE, rid("support_engineer"), uCS, rid("customer_service_agent"),
      uDIR, rid("director")]);

  for (const [uid, tenant, who] of [
    [uSA, TC, "sa"], [uBILL, TC, "bill"], [uAN, TC, "an"],
    [uSE, TC, "se"], [uCS, TC, "cs"], [uDIR, TD, "dir"]
  ] as [string, string, string][]) {
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
                 refresh_token_hash, user_agent, ip, expires_at)
              values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-control-revenue',$6,
                now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(`revenue-smoke-${who}-${STAMP}`), "127.0.0.1"]);
  }

  // A seeker with a weekly pass the office has not looked at yet, and one it rejected.
  const uSEEK = randomUUID();
  await oi(`insert into users (id, tenant_id, user_type, full_name, email, status)
            values ($1,$2,'seeker',$3,$4,'active')`,
    [uSEEK, TS, SEEKER_NAME, `smoke.revenue.seeker.${STAMP}@waisha.test`]);
  await oi(`insert into seekers (id, tenant_id, user_id, first_name, last_name,
             email_verified_at)
           values (gen_random_uuid(),$1,$2,$3,$4, now())`,
    [TS, uSEEK, SEEKER_NAME.split(" ")[0], SEEKER_NAME.split(" ")[1]]);
  const weekly = (await oi(
    "select id, price, searches_allowed, window_hours from seeker_pass_products where key='weekly'")).rows[0];
  if (!weekly) throw new Error("the weekly pass product is not seeded");
  const passPending = randomUUID(), passRejected = randomUUID();
  await oi(`insert into seeker_search_passes (id, tenant_id, user_id, product_id, kind, status,
             searches_allowed, starts_at, expires_at, amount, currency, payment_method,
             payment_reference)
           values ($1,$2,$3,$4,'weekly','awaiting_verification',$5, now(),
                   now() + interval '7 days', $6,'TZS','mpesa',$7),
                  ($8,$2,$3,$4,'weekly','rejected',$5, now() - interval '8 days',
                   now() - interval '1 day', $6,'TZS','airtel_money',$9)`,
    [passPending, TS, uSEEK, weekly.id, weekly.searches_allowed, weekly.price,
      `RVSM${STAMP}P`, passRejected, `RVSM${STAMP}R`]);

  const suite = (await oi(
    "select * from service_groups where key = 'transport_cfa_office'")).rows[0];
  const starter = (await oi("select * from plans where key = 'starter'")).rows[0];
  const bundleMonthly = Number(suite.price_monthly);
  const bundleTotal = Math.round(bundleMonthly * (1 + Number(starter.vat_rate)) * 100) / 100;

  try {
    // ---------------- the door ----------------
    phase("authentication");
    const anon = await call("/control/subscriptions");
    check("an anonymous request never reaches the register", anon.status === 401, { s: anon.status });
    const forged = await call("/control/payments", { headers: { Cookie: `waisha_control=no-session-${STAMP}` } });
    check("a cookie with no session row behind it is refused", forged.status === 401, { s: forged.status });

    // ---------------- duties ----------------
    phase("who may read the money");
    const perms = await call("/control/auth/permissions", ck("an"));
    check("the panel's own probe now reports the reading key this stage added",
      (perms.json?.permissions ?? []).includes("control.subscriptions.view"),
      perms.json?.permissions);
    const asAnalyst = await call("/control/subscriptions?status=active&limit=5", ck("an"));
    check("the analyst reads the register", asAnalyst.status === 200, { s: asAnalyst.status });
    const asSupport = await call("/control/subscriptions", ck("se"));
    check("support engineering does not read the customer register",
      asSupport.status === 403, { s: asSupport.status, m: asSupport.json?.error?.message });
    const asSupportLedger = await call("/control/payments", ck("se"));
    check("…nor the money ledger", asSupportLedger.status === 403, { s: asSupportLedger.status });
    const asService = await call("/control/payments?limit=5", ck("cs"));
    check("the service desk reads the ledger, because chasing a reference is its job",
      asService.status === 200, { s: asService.status });
    const asDirector = await call("/control/subscriptions", ck("dir"));
    check("a company director holding no control key is turned away",
      asDirector.status === 403, { s: asDirector.status });
    const mixAsAnalyst = await call("/control/revenue/mix?days=30", ck("an"));
    check("what is selling is an analyst's question as well as a billing one",
      mixAsAnalyst.status === 200 && Array.isArray(mixAsAnalyst.json.offerings),
      { s: mixAsAnalyst.status, keys: Object.keys(mixAsAnalyst.json ?? {}) });

    // ---------------- sell the bundle over HTTP ----------------
    phase("the office sells a WAISHA package");
    const sold = await send(`/control/tenants/${TT}/activate`, ck("bill"), {
      serviceGroupKey: "transport_cfa_office", billingCycle: "monthly", provider: "bank",
      providerTxnId: `RVSMBANK${STAMP}`
    });
    check("a bundle is sold without the desk having to choose a plan rung",
      sold.status === 200 && sold.json?.status === "ok" && sold.json?.bundle === "transport_cfa_office",
      { s: sold.status, j: sold.json });
    check("…and the invoice is the bundle's price plus VAT",
      Number(sold.json?.total) === bundleTotal, { total: sold.json?.total, expected: bundleTotal });

    const noOffering = await send(`/control/tenants/${TD}/activate`, ck("bill"), {
      billingCycle: "monthly", provider: "bank"
    });
    check("selling neither a package nor a plan is refused before any money row is written",
      noOffering.status === 400, { s: noOffering.status, e: noOffering.json?.error?.code });
    const invented = await send(`/control/tenants/${TD}/activate`, ck("bill"), {
      serviceGroupKey: `not_a_bundle_${STAMP}`, billingCycle: "monthly", provider: "bank"
    });
    check("an invented package key is refused too", invented.status === 400,
      { s: invented.status, m: invented.json?.error?.message });
    const asAnalystActivate = await send(`/control/tenants/${TT}/activate`, ck("an"), {
      serviceGroupKey: "transport_cfa_office", billingCycle: "monthly", provider: "bank"
    });
    check("the analyst may read the money but cannot sell it",
      asAnalystActivate.status === 403, { s: asAnalystActivate.status });

    // ---------------- the register ----------------
    phase("the customer register");
    const reg = await call(`/control/subscriptions?offering=transport_cfa_office&q=${encodeURIComponent(COMPANY)}`, ck("an"));
    const row = (reg.json?.companies ?? []).find((c: any) => c.tenant_id === TT);
    check("the company the office just sold appears under the bundle it was sold",
      !!row && row.offering === "transport_cfa_office" && row.offering_kind === "bundle",
      { s: reg.status, row });
    check("…priced from the bundle, and the bundle's own seats",
      Math.abs(Number(row?.monthly_equivalent) - bundleMonthly) < 0.01
      && row?.seats_licensed === suite.seat_limit,
      { mrr: row?.monthly_equivalent, seats: row?.seats_licensed });
    check("the row carries the three services the bundle sold, which is the whole point of the column",
      JSON.stringify([...(row?.services ?? [])].sort()) === JSON.stringify(["cfa", "office", "transport"]),
      row?.services);
    check("…and it says the company is active with a renewal about a month out",
      row?.subscription_status === "active" && Number(row?.days_to_renewal) >= 28
      && Number(row?.days_to_renewal) <= 32, { st: row?.subscription_status, d: row?.days_to_renewal });
    check("the money already paid for this customer is on the same line",
      Number(row?.collected) === bundleTotal && row?.invoices_paid === 1,
      { collected: row?.collected, n: row?.invoices_paid });

    const all = await call("/control/subscriptions?limit=400", ck("an"));
    const page = await call("/control/subscriptions?limit=3", ck("an"));
    check("a three-row page still reports the whole register's total and MRR",
      page.json.companies.length === 3
      && page.json.total === all.json.total
      && Math.abs(Number(page.json.mrr) - Number(all.json.mrr)) < 0.01,
      { page: page.json.total, all: all.json.total });
    check("the totals are typed, because a chart given \"7\" draws nothing",
      typeof all.json.total === "number" && typeof all.json.mrr === "number",
      { t: typeof all.json.total, m: typeof all.json.mrr });
    const badStatus = await call("/control/subscriptions?status=not_a_status", ck("an"));
    check("a status the vocabulary does not contain is refused, not silently ignored",
      badStatus.status === 400, { s: badStatus.status, e: badStatus.json?.error?.code });
    const dueSoon = await call("/control/subscriptions?dueWithin=45", ck("an"));
    check("the renewal window only returns companies inside it",
      dueSoon.status === 200 && dueSoon.json.companies
        .every((c: any) => c.days_to_renewal === null || Number(c.days_to_renewal) <= 45),
      dueSoon.json?.companies?.slice(0, 3)?.map((c: any) => c.days_to_renewal));

    // ---------------- the ledger ----------------
    phase("the money ledger, and its two clocks");
    const paidSub = await call(`/control/payments?source=subscription&q=${encodeURIComponent(COMPANY)}`, ck("bill"));
    const entry = (paidSub.json?.entries ?? [])[0];
    check("the invoice the office wrote is in the ledger and marked as money",
      paidSub.json?.entries?.length === 1 && entry?.money_at !== null
      && entry?.status === "paid" && entry?.detail === suite.name,
      { n: paidSub.json?.entries?.length, e: entry });
    check("…at the figure the activation answered with",
      Number(entry?.amount) === bundleTotal && Number(entry?.vat) > 0,
      { amount: entry?.amount, vat: entry?.vat });
    const queued = await call(`/control/payments?source=search_pass&status=awaiting_verification&q=${encodeURIComponent(SEEKER_NAME)}`, ck("cs"));
    const qEntry = (queued.json?.entries ?? [])[0];
    check("a pass whose reference is still queued is in the ledger but not in the money",
      queued.json?.entries?.length === 1 && qEntry?.money_at === null
      && Number(queued.json.income) === 0,
      { n: queued.json?.entries?.length, money_at: qEntry?.money_at, income: queued.json?.income });
    check("…and the desk can read the reference the seeker typed",
      qEntry?.reference === `RVSM${STAMP}P` && qEntry?.channel === "mpesa",
      { ref: qEntry?.reference, ch: qEntry?.channel });

    const approved = await send(`/control/directory/passes/${passPending}/verify`, ck("bill"), {
      approve: true, note: `matched at the desk ${STAMP}`
    });
    check("the marketplace desk can confirm that reference",
      approved.status === 200, { s: approved.status, m: approved.json?.error?.message });
    const afterVerify = await call(`/control/payments?source=search_pass&q=${encodeURIComponent(SEEKER_NAME)}&status=live`, ck("cs"));
    const liveEntry = (afterVerify.json?.entries ?? [])[0];
    check("verification turns the pass into money, and the ledger follows the same clock as the P&L",
      afterVerify.json?.entries?.length === 1 && liveEntry?.money_at !== null
      && Number(afterVerify.json.income) === Number(liveEntry?.amount),
      { n: afterVerify.json?.entries?.length, income: afterVerify.json?.income });
    const both = await call("/control/payments?limit=400", ck("bill"));
    const pageMoney = both.json.entries.filter((e: any) => e.money_at !== null)
      .reduce((s: number, e: any) => s + Number(e.amount), 0);
    // The income line is the whole filtered set's money, so it may only be summed
    // against the page when the page is the whole set.
    check("the unfiltered ledger's income line is the sum of the rows that are money",
      both.json.total <= both.json.entries.length
        ? Math.abs(Number(both.json.income) - pageMoney) < 0.02
        : Number(both.json.income) >= pageMoney - 0.02,
      { line: both.json.income, page: pageMoney, total: both.json.total });
    check("and no row that is not money is counted in it",
      both.json.entries.filter((e: any) => e.money_at === null)
        .every((e: any) => ["issued", "draft", "void", "refunded", "awaiting_verification",
          "rejected", "expired", "cancelled"].includes(e.status)),
      both.json.entries.filter((e: any) => e.money_at === null).slice(0, 4).map((e: any) => e.status));
    const sourceTab = await call("/control/payments?source=search_pass&limit=400", ck("bill"));
    check("the seeker tab shows seekers only — a company invoice cannot leak into it",
      sourceTab.json.entries.every((e: any) => e.source === "search_pass" && e.payer_kind === "seeker"),
      sourceTab.json.entries.filter((e: any) => e.payer_kind !== "seeker").slice(0, 3));

    // ---------------- what is selling ----------------
    phase("the revenue mix");
    const mix = await call("/control/revenue/mix?days=30", ck("an"));
    const bundleLine = (mix.json?.offerings ?? []).find((o: any) => o.offering === "transport_cfa_office");
    check("the bundle the office just sold is in the mix with the money it brought",
      !!bundleLine && Number(bundleLine.income) >= bundleTotal && bundleLine.offering_kind === "bundle",
      bundleLine);
    check("…counting the company once however many invoices it has",
      Number(bundleLine?.customers) >= 1, { c: bundleLine?.customers });
    const shares = (mix.json?.offerings ?? []).reduce((s: number, o: any) => s + Number(o.share), 0);
    check("the shares add up to the whole", Math.abs(shares - 1) < 0.01, { shares });
    const tooShort = await call("/control/revenue/mix?days=3", ck("an"));
    check("a window shorter than a week is refused rather than drawn",
      tooShort.status === 400, { s: tooShort.status });

    // ---------------- the price list ----------------
    phase("the bundle price list");
    const groups = await call("/control/service-groups", ck("an"));
    check("every analyst can see what the platform charges",
      groups.status === 200 && groups.json.length >= 3, { s: groups.status, n: groups.json?.length });
    const asSupportGroups = await call("/control/service-groups", ck("se"));
    check("…and the seat that only fixes faults cannot", asSupportGroups.status === 403,
      { s: asSupportGroups.status });
    const newPrice = bundleMonthly + 10000;
    const moved = await fetch(`${API}/control/service-groups/transport_cfa_office`, {
      method: "PUT", headers: { ...ck("an").headers, "Content-Type": "application/json" },
      body: JSON.stringify({ priceMonthly: newPrice })
    });
    check("reading prices is not editing them — the analyst is refused",
      moved.status === 403, { s: moved.status, m: (await moved.clone().json().catch(() => ({})))?.error?.message });
    const edited = await fetch(`${API}/control/service-groups/transport_cfa_office`, {
      method: "PUT", headers: { ...ck("bill").headers, "Content-Type": "application/json" },
      body: JSON.stringify({ priceMonthly: newPrice })
    });
    const editedJson = await edited.json().catch(() => ({} as any));
    check("the pricing desk moves one price and only that price",
      edited.status === 200 && Number(editedJson?.price_monthly) === newPrice
      && Number(editedJson?.price_quarterly) === Number(suite.price_quarterly)
      && editedJson?.name === suite.name,
      { s: edited.status, m: editedJson?.price_monthly, q: editedJson?.price_quarterly });
    const repriced = await call(`/control/subscriptions?offering=transport_cfa_office&q=${encodeURIComponent(COMPANY)}`, ck("an"));
    check("the customer already on that bundle is repriced in the register a second later, " +
      "because the register reads the live list rather than a copy",
      Math.abs(Number(repriced.json?.companies?.[0]?.monthly_equivalent) - newPrice) < 0.01,
      repriced.json?.companies?.[0]?.monthly_equivalent);
    const negative = await fetch(`${API}/control/service-groups/transport_cfa_office`, {
      method: "PUT", headers: { ...ck("bill").headers, "Content-Type": "application/json" },
      body: JSON.stringify({ priceMonthly: -1 })
    });
    check("a negative price is refused at the door", negative.status === 400,
      { s: negative.status });
    const ghost = await fetch(`${API}/control/service-groups/no_such_package_${STAMP}`, {
      method: "PUT", headers: { ...ck("bill").headers, "Content-Type": "application/json" },
      body: JSON.stringify({ priceMonthly: 1000 })
    });
    check("and so is a key that is not on the list", ghost.status === 404, { s: ghost.status });
    const restored = await fetch(`${API}/control/service-groups/transport_cfa_office`, {
      method: "PUT", headers: { ...ck("bill").headers, "Content-Type": "application/json" },
      body: JSON.stringify({ priceMonthly: bundleMonthly })
    });
    check("the correction back to the original figure is accepted",
      restored.status === 200 && Number((await restored.json() as any).price_monthly) === bundleMonthly,
      restored.status);

    const trail = (await oi(
      `select action, before, after from audit_logs
        where tenant_id = $1 and action = 'control.service_groups.updated'
        order by ts desc limit 3`, [TC])).rows;
    check("every price the desk moved is on the trail with the figure it replaced",
      trail.length >= 2 && trail.some(t => Number(t.before?.price_monthly) === bundleMonthly
        && Number(t.after?.price_monthly) === newPrice),
      trail.map(t => ({ b: t.before?.price_monthly, a: t.after?.price_monthly })));

    // ---------------- re-sell on the ladder ----------------
    phase("re-selling on the ladder clears the bundle");
    const resold = await send(`/control/tenants/${TT}/activate`, ck("bill"), {
      planKey: "starter", billingCycle: "monthly", provider: "bank"
    });
    check("the office can move a customer back onto the plan ladder",
      resold.status === 200 && !resold.json?.bundle, { s: resold.status, j: resold.json });
    const after = await call(`/control/subscriptions?q=${encodeURIComponent(COMPANY)}`, ck("an"));
    const row2 = (after.json?.companies ?? []).find((c: any) => c.tenant_id === TT);
    check("…and the register stops calling it a bundle customer",
      row2?.offering_kind === "plan" && row2?.offering === "starter"
      && row2?.services?.length === 0, { o: row2?.offering, k: row2?.offering_kind, s: row2?.services });
    check("the seats the bundle licensed stay where they were, because the customer keeps them",
      Number(row2?.seats_licensed) === suite.seat_limit, { seats: row2?.seats_licensed });

    // ---------------- who left ----------------
    phase("recording an exit, and reading churn");
    const subId = row2?.subscription_id;
    const ladderMonthly = Number(starter.price_monthly);
    // The sentence the desk is allowed to leave, and the one it will be reading in a year.
    const NOTE = `released at ${STAMP}: the office said a neighbouring agent was cheaper for the same lanes`;
    const sumBy = (rows: any[], k: string) =>
      (rows ?? []).reduce((s: number, x: any) => s + Number(x[k]), 0);
    const smokeExits = () => oi(
      `select count(*)::int as n from subscription_cancellations where company_name like $1`,
      [TENANT_SWEEP]);

    const manageAsAnalyst = await call(`/control/subscriptions?q=${encodeURIComponent(COMPANY)}`, ck("an"));
    const manageAsBilling = await call(`/control/subscriptions?q=${encodeURIComponent(COMPANY)}`, ck("bill"));
    check("the register itself tells the seat that only reads whether it may close a customer, " +
      "so the desk never shows a door that is about to be refused",
      manageAsAnalyst.json?.can_manage === false && manageAsBilling.json?.can_manage === true,
      { an: manageAsAnalyst.json?.can_manage, bill: manageAsBilling.json?.can_manage });

    const churnBefore = (await call("/control/churn?days=90", ck("an"))).json;
    check("a departed customer is an analyst's number as well as a billing one",
      churnBefore?.exits?.companies !== undefined && churnBefore?.today?.customers !== undefined,
      { s: churnBefore?.exits, keys: Object.keys(churnBefore ?? {}) });
    const churnAsSupport = await call("/control/churn", ck("se"));
    check("…and the seat that fixes faults is not allowed to read the money it lost",
      churnAsSupport.status === 403, { s: churnAsSupport.status });
    const shortWindow = await call("/control/churn?days=3", ck("an"));
    check("a window shorter than a week is refused rather than drawn", shortWindow.status === 400,
      { s: shortWindow.status });

    const inventedReason = await send(`/control/subscriptions/${subId}/cancel`, ck("bill"), {
      reasonCode: "cheaper_elsewhere", note: NOTE
    });
    check("a reason the vocabulary does not contain is refused", inventedReason.status === 400,
      { s: inventedReason.status, m: inventedReason.json?.error?.message });
    const thinNote = await send(`/control/subscriptions/${subId}/cancel`, ck("bill"), {
      reasonCode: "price", note: "left"
    });
    check("…and so is a note too short to explain the exit later", thinNote.status === 400,
      { s: thinNote.status, m: thinNote.json?.error?.message });
    const ghostSub = await send(`/control/subscriptions/${randomUUID()}/cancel`, ck("bill"), {
      reasonCode: "price", note: NOTE
    });
    check("a subscription that is not on the register answers not found", ghostSub.status === 404,
      { s: ghostSub.status });
    const cancelAsAnalyst = await send(`/control/subscriptions/${subId}/cancel`, ck("an"), {
      reasonCode: "price", note: NOTE
    });
    check("reading the register is not closing a customer on it", cancelAsAnalyst.status === 403,
      { s: cancelAsAnalyst.status, m: cancelAsAnalyst.json?.error?.message });
    const cancelAsSupport = await send(`/control/subscriptions/${subId}/cancel`, ck("se"), {
      reasonCode: "price", note: NOTE
    });
    check("…nor is fixing the fault that lost them", cancelAsSupport.status === 403,
      { s: cancelAsSupport.status });
    check("none of the five refusals wrote an exit", (await smokeExits()).rows[0].n === 0,
      (await smokeExits()).rows[0]);

    const exited = await send(`/control/subscriptions/${subId}/cancel`, ck("bill"), {
      reasonCode: "price", note: NOTE
    });
    const ladderTotal = Number(resold.json?.total);
    check("the exit is recorded, priced the way the register prices this customer",
      exited.status === 200 && exited.json?.status === "ok"
      && Math.abs(Number(exited.json?.monthly_equivalent) - ladderMonthly) < 0.01
      && exited.json?.prior_status === "active" && exited.json?.offering === "starter",
      { s: exited.status, j: exited.json });
    check("…and the money already paid is on the receipt rather than lost from it, " +
      "because an exit does not refund",
      Math.abs(Number(exited.json?.collected) - (bundleTotal + ladderTotal)) < 0.01
      && Number(exited.json?.paid_invoices) === 2,
      { collected: exited.json?.collected, n: exited.json?.paid_invoices });
    check("…and the reason and the sentence the desk wrote are what came back",
      exited.json?.reason_code === "price" && exited.json?.note === NOTE,
      { r: exited.json?.reason_code });

    const nowRow = (await call(`/control/subscriptions?q=${encodeURIComponent(COMPANY)}`, ck("an")))
      .json?.companies?.find((c: any) => c.tenant_id === TT);
    check("the register stops calling the company a live customer",
      nowRow?.subscription_status === "cancelled" && nowRow?.auto_renew === false,
      { st: nowRow?.subscription_status, ar: nowRow?.auto_renew });
    const tenantNow = (await oi(
      "select status, licence_expires_at from tenants where id = $1", [TT])).rows[0];
    check("…but the company is still open and its term is untouched, because ending a sale is " +
      "not a sanction — that is the tenants desk's act on its own duty",
      tenantNow?.status === "active" && tenantNow?.licence_expires_at !== null, tenantNow);

    const churnAfter = (await call("/control/churn?days=90", ck("an"))).json;
    check("one more company left, and the money lost moved by exactly this customer's figure",
      churnAfter.exits.companies === churnBefore.exits.companies + 1
      && Math.abs(Number(churnAfter.exits.mrr_lost) - Number(churnBefore.exits.mrr_lost)
        - ladderMonthly) < 0.01,
      { n: churnAfter.exits.companies, was: churnBefore.exits.companies,
        lost: churnAfter.exits.mrr_lost, was_lost: churnBefore.exits.mrr_lost });
    check("today's states follow: the customer leaves live and joins cancelled, while the " +
      "register still counts the company it sold",
      churnAfter.today.live === churnBefore.today.live - 1
      && churnAfter.today.cancelled === churnBefore.today.cancelled + 1
      && churnAfter.today.customers === churnBefore.today.customers,
      { live: churnAfter.today.live, canc: churnAfter.today.cancelled,
        cust: churnAfter.today.customers, before: churnBefore.today });
    check("the MRR the landing screen draws loses exactly that month",
      Math.abs(Number(churnAfter.today.mrr_live) - Number(churnBefore.today.mrr_live)
        + ladderMonthly) < 0.01,
      { mrr: churnAfter.today.mrr_live, was: churnBefore.today.mrr_live });
    check("a customer sold today is not counted as having been open before the window, so the " +
      "rate's denominator did not move with its numerator",
      churnAfter.sold_before_window === churnBefore.sold_before_window
      && (churnAfter.sold_before_window === 0 ? churnAfter.exit_rate_pct === null
        : Math.abs(100 * churnAfter.exits.companies / churnAfter.sold_before_window
          - Number(churnAfter.exit_rate_pct)) <= 0.06),
      { base: churnAfter.sold_before_window, rate: churnAfter.exit_rate_pct });
    check("the same exits are counted once each by reason and by month",
      sumBy(churnAfter.by_reason, "companies") === churnAfter.exits.companies
      && sumBy(churnAfter.by_month, "cancellations") === churnAfter.exits.companies
      && churnAfter.exits.still_cancelled + churnAfter.exits.came_back
        === churnAfter.exits.companies,
      { reasons: churnAfter.by_reason, months: churnAfter.by_month,
        c: churnAfter.exits.companies });
    check("the price reason carries its money, and the recent list holds the sentence the " +
      "desk wrote against the company that said it",
      churnAfter.by_reason.some((r: any) => r.reason_code === "price"
        && Number(r.mrr_lost) >= ladderMonthly)
      && churnAfter.recent[0]?.company_name === COMPANY && churnAfter.recent[0]?.note === NOTE
      && churnAfter.recent[0]?.came_back === false
      && ["billing_admin", "super_admin"].includes(churnAfter.recent[0]?.actor_role),
      { reasons: churnAfter.by_reason, first: churnAfter.recent?.[0] });
    check("out-of-term is still its own number — a licence that passed is not an exit",
      churnAfter.today.out_of_term === churnBefore.today.out_of_term,
      { now: churnAfter.today.out_of_term, was: churnBefore.today.out_of_term });

    const adv = await call("/control/system/advisory", ck("sa"));
    const churnLine = (adv.json?.items ?? []).find((i: any) => i.item_id === "churn_recorded_exits");
    check("the advisory carries the line it used to say it could not draw, and sends the " +
      "reader to the desk that wrote it",
      adv.status === 200 && !!churnLine && churnLine.kind === "retention"
      && churnLine.area === "Revenue" && /Customers desk/.test(String(churnLine.action ?? "")),
      { s: adv.status, line: churnLine && { id: churnLine.item_id, m: churnLine.metric } });
    check("…and its headline is the churn reader's own figures on the same window, not a " +
      "second arithmetic done here",
      Number(adv.json?.churn?.exits) === churnAfter.exits.companies
      && Math.abs(Number(adv.json?.churn?.mrr_lost) - Number(churnAfter.exits.mrr_lost)) <= 1
      && Number(adv.json?.churn?.window_days) === 90, adv.json?.churn);
    const notMeasured = (adv.json?.not_measured ?? []).map((u: any) => String(u.thing));
    check("…and the card that admitted churn was unmeasurable no longer says so",
      notMeasured.length === 3 && !notMeasured.some((t) => /churn|cancell|retention/i.test(t)),
      notMeasured);

    const history = await call(`/control/churn/exits/${TT}`, ck("an"));
    check("the company's own history is the exit, with the reason the office chose",
      history.status === 200 && history.json?.exits?.length === 1
      && history.json.exits[0].reason_code === "price"
      && history.json.exits[0].note === NOTE
      && history.json.exits[0].subscription_id === subId
      && Math.abs(Number(history.json.exits[0].monthly_equivalent) - ladderMonthly) < 0.01,
      { s: history.status, e: history.json?.exits });
    const dupe = await send(`/control/subscriptions/${subId}/cancel`, ck("bill"), {
      reasonCode: "went_dormant", note: "a second attempt at the same door"
    });
    check("a double click cannot pad the churn figure", dupe.status === 409,
      { s: dupe.status, m: dupe.json?.error?.message });
    check("…and the register still holds one exit for this company",
      (await smokeExits()).rows[0].n === 1, (await smokeExits()).rows[0]);

    const trail2 = (await oi(
      `select actor_role, before, after from audit_logs
        where tenant_id = $1 and action = 'subscription.cancelled'
        order by ts desc limit 2`, [TT])).rows;
    check("the trail carries the before-image and the id of the row it wrote, and it is the " +
      "definer that wrote it — the handler has no audit call to forget",
      trail2.length === 1 && trail2[0].after?.cancel_id === exited.json?.cancel_id
      && trail2[0].before?.status === "active" && trail2[0].before?.auto_renew !== null
      && trail2[0].after?.reason_code === "price" && trail2[0].after?.note === NOTE,
      trail2.map(t => ({ b: t.before?.status, a: t.after?.cancel_id })));

    const backAgain = await send(`/control/tenants/${TT}/activate`, ck("bill"), {
      planKey: "starter", billingCycle: "monthly", provider: "bank"
    });
    check("the office can sell again to a customer that left", backAgain.status === 200,
      { s: backAgain.status, j: backAgain.json });
    const churnBack = (await call("/control/churn?days=90", ck("an"))).json;
    check("…and the desk sees a return rather than a second exit",
      churnBack.exits.companies === churnAfter.exits.companies
      && churnBack.exits.came_back === churnAfter.exits.came_back + 1
      && churnBack.exits.still_cancelled === churnAfter.exits.still_cancelled - 1,
      { c: churnBack.exits.companies, back: churnBack.exits.came_back,
        still: churnBack.exits.still_cancelled });
    check("the money lost and the money collected stay frozen at the figures the exit wrote, " +
      "because the before-image is history not a live read",
      Math.abs(Number(churnBack.exits.mrr_lost) - Number(churnAfter.exits.mrr_lost)) < 0.01
      && Math.abs(Number(churnBack.exits.paid_before_exit)
        - Number(churnAfter.exits.paid_before_exit)) < 0.01,
      { lost: churnBack.exits.mrr_lost, paid: churnBack.exits.paid_before_exit });
    check("…and the recent line says so, while the company's history still holds the exit " +
      "that was recorded",
      churnBack.recent[0]?.came_back === true
      && (await call(`/control/churn/exits/${TT}`, ck("an"))).json?.exits?.length === 1,
      { came: churnBack.recent?.[0]?.came_back });
    check("today's live and cancelled are back where they were, because the customer came",
      churnBack.today.live === churnBefore.today.live
      && churnBack.today.cancelled === churnBefore.today.cancelled,
      { live: churnBack.today.live, canc: churnBack.today.cancelled });

    // ---------------- the overview agrees ----------------
    phase("the numbers on the landing screen agree with the registers");
    const ov = await call("/control/analytics/overview", ck("sa"));
    check("the overview counts this stage's bundle customers rather than hiding them",
      typeof ov.json?.subscriptions?.bundles === "number", ov.json?.subscriptions);
    const ladder = await call("/control/subscriptions?offering=ladder&limit=400", ck("an"));
    const bundleReg = await call("/control/subscriptions?offering=bundles&limit=400", ck("an"));
    check("the register splits into the two ways a customer was sold, and nothing falls " +
      "between them",
      ladder.json.total + bundleReg.json.total === (await call("/control/subscriptions?limit=400", ck("an"))).json.total,
      { ladder: ladder.json.total, bundles: bundleReg.json.total });

    // ---------------- no PII in these payloads ----------------
    phase("what these screens carry");
    const seen = { pii: [] as string[], values: [] as string[] };
    for (const b of bodies) {
      let parsed: any = null;
      try { parsed = JSON.parse(b); } catch { /* non-JSON */ }
      if (parsed) walk(parsed, seen);
    }
    check("no register or ledger payload carries a phone, an email, a NIDA or a TIN",
      seen.pii.length === 0, [...new Set(seen.pii)].slice(0, 5));
    const phoneShapes = seen.values.filter(v => !ID_SHAPE.test(v) && PHONE_SHAPE.test(v));
    check("and none of the values in them look like a +255 number",
      phoneShapes.length === 0, phoneShapes.slice(0, 3));
    check("a seeker's own contact details are not on the money ledger, only their name " +
      "and what they bought",
      !(seen.values.some(v => /@waisha\.test/.test(v) && !/Revenue Smoke/.test(v))));

  } finally {
    // ---------------- teardown ----------------
    await oi(`delete from seeker_search_passes where id = any($1::uuid[])`, [[passPending, passRejected]]);
    await oi(`delete from seekers where user_id = $1`, [uSEEK]);
    await oi(`delete from users where id = $1`, [uSEEK]);
    await sweep();
    for (const b of ["register:", "ledger:", "bundles:", "activate:", "pass-verify:",
      "cancel:", "churn:"]) {
      await oi(`delete from rate_limits where bucket like $1`, [`${b}%`]);
    }
    const residue = (await oi(
      `select (select count(*) from tenants where name like $1)::int as tenants,
              (select count(*) from users where email like $2)::int as users,
              (select count(*) from subscriptions s join tenants t on t.id = s.tenant_id
                where t.name like $1)::int as subs,
              (select count(*) from invoices i join tenants t on t.id = i.tenant_id
                where t.name like $1)::int as invoices,
              (select count(*) from payments p join tenants t on t.id = p.tenant_id
                where t.name like $1)::int as payments,
              (select count(*) from subscription_cancellations
                where company_name like $1)::int as exits,
              (select count(*) from seeker_search_passes where payment_reference like 'RVSM%')::int as passes,
              (select count(*) from service_groups where key like 'rvsm-%')::int as groups`,
      [TENANT_SWEEP, EMAIL_SWEEP])).rows[0];
    const price = (await oi(
      "select price_monthly from service_groups where key = 'transport_cfa_office'")).rows[0];
    check("the smoke left no company, no money row, no exit, no seat and no package behind",
      residue.tenants === 0 && residue.users === 0 && residue.subs === 0
      && residue.invoices === 0 && residue.payments === 0 && residue.passes === 0
      && residue.groups === 0 && residue.exits === 0, residue);
    check("the price the desk moved is back on the list",
      Number(price?.price_monthly) === bundleMonthly, price);
    await owner.end();
  }

  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nsmoke-control-revenue: all checks passed");
}

main().catch(async (e) => { console.error(e); process.exit(1); });
