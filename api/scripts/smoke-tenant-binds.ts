/**
 * End-to-end smoke for the tenant bind (the class, not one module).
 *
 * Eight writes compared `tenant_id` to `req.user.sub` — the person's id — so they
 * matched no row. Two of them answered 404 and said so ("Route not found"), and the
 * rest answered `{ ok: true }` while changing nothing: a staff member's name, phone,
 * job title and status never moved, a branch never saved, an invoice never recorded
 * the payment against it and never changed status. Row level security made the
 * statements safe; it did not make them work.
 *
 * Every check here writes through the real HTTP surface and then reads the value
 * back, because a 200 alone was exactly what the bug looked like from the outside.
 *
 * The last section is the other half of the same class: statements that bind the
 * *caller's* tenant at all. Those read another company's row rather than missing it,
 * so they answered 200 too — with someone else's data.
 *
 * Run against a booted API on port 4000: npx tsx scripts/smoke-tenant-binds.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { searchHash } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);
const STAMP = Date.now().toString(36);
const COMPANY = `Bind Smoke Transport ${STAMP} Ltd`;
const OTHER = `Bind Smoke Other ${STAMP} Ltd`;

async function mint(sub: string, tid: string) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000cc", typ: "director", roles: ["director"] })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("15m").sign(key);
}

async function call(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const T = randomUUID(), TO = randomUUID();
  const uDirector = randomUUID(), uStaff = randomUUID(), uOther = randomUUID();
  const directorRole = (await oi(`select id from roles where tenant_id is null and key = 'director'`)).rows[0].id;

  const wipe = async () => {
    for (const t of [T, TO]) {
      const uids = (await oi(`select id from users where tenant_id = $1`, [t])).rows.map(r => r.id);
      await oi(`delete from freight_invoice_items where tenant_id = $1`, [t]);
      await oi(`delete from freight_invoice_payments where tenant_id = $1`, [t]);
      await oi(`delete from freight_invoices where tenant_id = $1`, [t]);
      await oi(`delete from payments where tenant_id = $1`, [t]);
      await oi(`delete from invoices where tenant_id = $1`, [t]);
      await oi(`delete from subscriptions where tenant_id = $1`, [t]);
      await oi(`delete from route_checkpoints where tenant_id = $1`, [t]);
      await oi(`delete from routes where tenant_id = $1`, [t]).catch(() => { });
      await oi(`delete from branches where tenant_id = $1`, [t]);
      await oi(`delete from company_profiles where tenant_id = $1`, [t]);
      if (uids.length) {
        await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
        await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      }
      await oi(`delete from users where tenant_id = $1`, [t]);
      await oi(`delete from tenants where id = $1`, [t]);
    }
  };

  await wipe();

  await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active'),($3,'transporter',$4,'active')`,
    [T, COMPANY, TO, OTHER]);
  await oi(`insert into company_profiles (id, tenant_id, company_name) values ($1,$2,$3),($4,$5,$6)`,
    [randomUUID(), T, COMPANY, randomUUID(), TO, OTHER]);
  for (const [id, type, name, email] of [
    [uDirector, "director", "Bind Smoke Director", `bind.d.${STAMP}@waisha.test`],
    [uStaff, "staff", "Bind Smoke Clerk", `bind.s.${STAMP}@waisha.test`],
    [uOther, "director", "Bind Smoke Other Director", `bind.o.${STAMP}@waisha.test`]
  ] as [string, string, string, string][]) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
              values ($1,$2,$3,$4,'active',$5)`, [id, type === "director" && id === uOther ? TO : T, type, name, email]);
    if (type === "director") {
      await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [id, directorRole]);
    }
  }

  const token = await mint(uDirector, T);
  const otherToken = await mint(uOther, TO);

  // Region ids are read, never guessed — geo_regions is seeded, and an id that has
  // no row there makes the route insert fail on its foreign key before the write
  // under test is ever reached.
  const region = async (code: string) => Number(
    (await oi(`select id from geo_regions where code = $1`, [code])).rows[0]?.id);
  const dsm = await region("TZ-DAR");
  const mtwara = await region("TZ-MTW");
  const lindi = await region("TZ-LIN");

  try {
    // ============================ routes ============================
    const route = await call("/routes", token, post({
      name: `Bind ${STAMP} Dar to Mbamba Bay`, originRegionId: dsm, destRegionId: mtwara,
      originText: "dsm port", destText: "mbamba bay", distanceKm: 1172, expectedDurationHours: 15
    }));
    check("a route is created", route.status === 201 && !!route.json?.id, [route.status, route.json]);
    const routeId = route.json?.id as string;

    const routeEdit = await call(`/routes/${routeId}`, token, put({
      name: `Bind ${STAMP} Dar to Mbamba Bay via Lindi`, originRegionId: dsm, destRegionId: mtwara,
      originText: "dsm port", destText: "mbamba bay", distanceKm: 1204, expectedDurationHours: 16
    }));
    check("the route edit is accepted", routeEdit.status === 200, [routeEdit.status, routeEdit.json]);
    const routeAfter = await call(`/routes/${routeId}`, token);
    check("the route edit actually moved the row (this answered 404 before the fix)",
      routeAfter.json?.name === `Bind ${STAMP} Dar to Mbamba Bay via Lindi`
        && Number(routeAfter.json?.distance_km) === 1204,
      [routeAfter.json?.name, routeAfter.json?.distance_km]);
    const routeForeign = await call(`/routes/${routeId}`, otherToken, put({ name: "stolen name" }));
    check("another tenant cannot edit it", routeForeign.status === 404, routeForeign.status);

    const routeDelete = await call(`/routes/${routeId}`, token, { method: "DELETE" });
    check("the route delete is accepted (this answered 404 before the fix)",
      routeDelete.status === 200, [routeDelete.status, routeDelete.json]);
    const routeGone = await oi(`select deleted_at from routes where id = $1`, [routeId]);
    check("the route is tombstoned, not lost", !!routeGone.rows[0]?.deleted_at, routeGone.rows[0]);

    // ============================ branches ============================
    const branch = await call("/branches", token, post({
      kind: "branch", name: `Bind ${STAMP} Nachingwea Office`, regionId: lindi, street: "Old Road 4"
    }));
    check("a branch is created", branch.status === 201 && !!branch.json?.id, [branch.status, branch.json]);
    const branchId = branch.json?.id as string;

    const branchEdit = await call(`/branches/${branchId}`, token, put({
      kind: "branch", name: `Bind ${STAMP} Nachingwea Depot`, regionId: lindi, street: "New Road 9",
      phone: "+255710000333"
    }));
    check("the branch edit is accepted (this answered 404 before the fix)",
      branchEdit.status === 200, [branchEdit.status, branchEdit.json]);
    const branchRow = (await oi(`select name, street, phone_search from branches where id = $1`, [branchId])).rows[0];
    check("the branch edit moved name, street and the encrypted phone",
      branchRow?.name === `Bind ${STAMP} Nachingwea Depot` && branchRow?.street === "New Road 9"
        && branchRow?.phone_search === searchHash("+255710000333"),
      branchRow);
    // A valid body, so the answer is the tenant check and not the schema rejecting
    // the request before it got there.
    const branchForeign = await call(`/branches/${branchId}`, otherToken, put({
      kind: "branch", name: "not yours", regionId: lindi, street: "Someone elses Road"
    }));
    check("another tenant cannot edit the branch", branchForeign.status === 404, branchForeign.status);
    const branchDelete = await call(`/branches/${branchId}`, token, { method: "DELETE" });
    check("the branch delete is accepted", branchDelete.status === 200, branchDelete.status);

    // ============================ staff ============================
    const staffEdit = await call(`/users/${uStaff}`, token, put({
      fullName: "Bind Smoke Renamed Clerk", jobTitle: "Docs officer", phone: "+255710000444"
    }));
    check("the staff edit is accepted (this returned ok while writing nothing)",
      staffEdit.status === 200, [staffEdit.status, staffEdit.json]);
    const staffRow = (await oi(`select full_name, job_title, phone_search, updated_by
                                from users where id = $1`, [uStaff])).rows[0];
    check("the name, job title and phone all moved",
      staffRow?.full_name === "Bind Smoke Renamed Clerk" && staffRow?.job_title === "Docs officer"
        && staffRow?.phone_search === searchHash("+255710000444"),
      staffRow);
    check("the write recorded who made it", staffRow?.updated_by === uDirector, staffRow?.updated_by);

    const staffStatus = await call(`/users/${uStaff}/status`, token, put({ status: "deactivated" }));
    const staffAfter = (await oi(`select status from users where id = $1`, [uStaff])).rows[0];
    check("deactivating a member changes their status (it used to stay active)",
      staffStatus.status === 200 && staffAfter?.status === "deactivated",
      [staffStatus.status, staffAfter]);

    // ============================ invoices ============================
    const invoice = await call("/invoices", token, post({
      customerName: `Bind Smoke Customer ${STAMP}`, currency: "TZS", vatRate: 18,
      items: [{ description: "Freight Dar to Mbamba Bay", quantity: 1, unit: "trip", unitPrice: 400000 }]
    }));
    check("an invoice is created as a draft", invoice.status === 201 && !!invoice.json?.id,
      [invoice.status, invoice.json]);
    const invoiceId = invoice.json?.id as string;

    const sent = await call(`/invoices/${invoiceId}/status`, token, put({ status: "sent" }));
    const sentRow = (await oi(`select status from freight_invoices where id = $1`, [invoiceId])).rows[0];
    check("issuing the invoice changes its status (this was a silent no-op)",
      sent.status === 200 && sentRow?.status === "sent", [sent.status, sentRow]);

    const paid = await call(`/invoices/${invoiceId}/payments`, token, post({
      amount: 150000, method: "bank", reference: `BIND-${STAMP}`
    }));
    check("a payment is recorded", paid.status === 201 && !!paid.json?.id, [paid.status, paid.json]);
    const paidRow = (await oi(`select amount_paid from freight_invoices where id = $1`, [invoiceId])).rows[0];
    check("the payment moved the paid total on the invoice (it never did)",
      Number(paidRow?.amount_paid) === 150000, paidRow);
    const detail = await call(`/invoices/${invoiceId}`, token);
    check("the desk reads the invoice as partial, not unpaid",
      detail.json?.effective_status === "partial",
      [detail.json?.effective_status, detail.json?.amount_paid]);
    const cancelPaid = await call(`/invoices/${invoiceId}/status`, token, put({ status: "cancelled" }));
    check("an invoice with payments still cannot be cancelled", cancelPaid.status === 409,
      [cancelPaid.status, cancelPaid.json]);

    // 400,000 + 18% VAT = 472,000. The second payment settles the balance; anything
    // more is the guard refusing an over-payment, which the run below also proves.
    const over = await call(`/invoices/${invoiceId}/payments`, token, post({ amount: 497200, method: "cash" }));
    check("a payment larger than the balance is refused", over.status === 409,
      [over.status, over.json?.error?.code]);
    const second = await call(`/invoices/${invoiceId}/payments`, token, post({ amount: 322000, method: "cash" }));
    const secondRow = (await oi(`select amount_paid from freight_invoices where id = $1`, [invoiceId])).rows[0];
    check("payments accumulate on the invoice",
      second.status === 201 && Number(secondRow?.amount_paid) === 472000, [second.status, secondRow]);
    const settled = await call(`/invoices/${invoiceId}`, token);
    check("the invoice now reads as paid", settled.json?.effective_status === "paid",
      settled.json?.effective_status);

    // ============================ licence payments ============================
    // Three statements about a charge took their caller's tenant on faith: the
    // idempotency read matched any company's key, and the status poll — and the lazy
    // expiry that rides with it — matched any company's reference. A reference is in
    // the URL and a key is a header, so both were guessable by design.
    const IDEM = `bind-${STAMP}`;
    const intent = (t: string, key: string) => call("/payments/intent", t, {
      ...post({ planKey: "starter", billingCycle: "monthly", seats: 2, payerPhone: "+255710000555" }),
      headers: { "Idempotency-Key": key }
    });

    const first = await intent(token, IDEM);
    check("a licence intent is created", first.status === 201 && !!first.json?.intentReference,
      [first.status, first.json]);
    const refA = first.json?.intentReference as string;

    const repeat = await intent(token, IDEM);
    check("the same key from the same seat returns the same intent, not a second charge",
      repeat.json?.idempotent === true && repeat.json?.intentReference === refA,
      [repeat.status, repeat.json]);

    const foreignKey = await intent(otherToken, IDEM);
    check("another tenant guessing that key gets its own intent, not this seat's reference",
      foreignKey.status === 201 && !!foreignKey.json?.intentReference
        && foreignKey.json.intentReference !== refA && foreignKey.json.idempotent !== true,
      [foreignKey.status, foreignKey.json]);

    const foreignRead = await call(`/payments/${refA}/status`, otherToken);
    check("another tenant cannot read this tenant's payment by its reference "
      + "(it answered 200 with the amount before the fix)",
      foreignRead.status === 404, [foreignRead.status, foreignRead.json]);

    // Aged past the 10-minute window, so the poll's lazy expiry is a live question
    // rather than a branch the statement never reaches.
    await oi(`update payments set requested_at = now() - interval '31 minutes'
              where intent_reference = $1 and tenant_id = $2`, [refA, T]);
    const strangerPoll = await call(`/payments/${refA}/status`, otherToken);
    const stillPending = (await oi(`select status from payments where intent_reference = $1`, [refA])).rows[0];
    check("a stranger's poll cannot time this tenant's payment off "
      + "(the definer ran over any company's row before the fix)",
      strangerPoll.status === 404 && stillPending?.status === "pending",
      [strangerPoll.status, stillPending]);

    const ownPoll = await call(`/payments/${refA}/status`, token);
    const ownRow = (await oi(`select status from payments where intent_reference = $1`, [refA])).rows[0];
    check("the seat's own poll still expires its own stale payment",
      ownPoll.status === 200 && ownRow?.status === "timed_out", [ownPoll.status, ownRow]);
  } finally {
    await wipe();
    const residue = await oi(`select
      (select count(*) from tenants where id = any($1::uuid[]))::int as tenants,
      (select count(*) from users where tenant_id = any($1::uuid[]))::int as users,
      (select count(*) from routes where tenant_id = any($1::uuid[]))::int as routes,
      (select count(*) from branches where tenant_id = any($1::uuid[]))::int as branches,
      (select count(*) from freight_invoices where tenant_id = any($1::uuid[]))::int as invoices,
      (select count(*) from payments where tenant_id = any($1::uuid[]))::int as payments,
      (select count(*) from invoices where tenant_id = any($1::uuid[]))::int as billing_invoices`, [[T, TO]]);
    console.log("\nresidue:", residue.rows[0]);
    await owner.end();
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch(e => { console.error(e); process.exit(1); });
