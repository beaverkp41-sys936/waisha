/**
 * The invoice dates on the wire, checked end to end.
 *
 * A `date` column travels through pg as a Date built at local midnight, so the JSON
 * form is the previous day whenever the server sits east of Greenwich and the next day
 * for a viewer west of it. On a bill that is not a rounding problem: the clerk opens a
 * draft to correct it, the date inputs come back prefilled with the day before the one
 * they filed, and the QR on the printed copy reads whatever `String(date)` happens to
 * begin with ("DUE:Sat Oct 17" for a bill due on the 18th).
 *
 * So every date this module sends must be the plain calendar day, and the day the clerk
 * chose must survive the create → list → detail → edit → detail loop unchanged.
 *
 * Run against a booted API on port 4000: npx tsx scripts/verify-invoice-dates.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);
const STAMP = Date.now().toString(36);
const COMPANY = `Invoice Date Smoke ${STAMP} Ltd`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

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

  const T = randomUUID();
  const uDirector = randomUUID();
  const directorRole = (await oi(`select id from roles where tenant_id is null and key = 'director'`)).rows[0].id;

  const wipe = async () => {
    const uids = (await oi(`select id from users where tenant_id = $1`, [T])).rows.map(r => r.id);
    await oi(`delete from freight_invoice_items where tenant_id = $1`, [T]).catch(() => { });
    await oi(`delete from freight_invoice_payments where tenant_id = $1`, [T]).catch(() => { });
    await oi(`delete from freight_invoices where tenant_id = $1`, [T]).catch(() => { });
    await oi(`delete from company_profiles where tenant_id = $1`, [T]).catch(() => { });
    await oi(`delete from audit_logs where tenant_id = $1`, [T]).catch(() => { });
    if (uids.length) await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from users where tenant_id = $1`, [T]);
    await oi(`delete from tenants where id = $1`, [T]);
  };
  await wipe();

  try {
    await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')`, [T, COMPANY]);
    await oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled)
              values ($1,$2,'director',$3,$4,'active',false)`,
      [uDirector, T, `Date Smoke Director ${STAMP}`, `date.smoke.${STAMP}@waisha.test`]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uDirector, directorRole]);

    const token = await new SignJWT({ tid: T, sid: randomUUID(), typ: "director", roles: ["director"] })
      .setProtectedHeader({ alg: "HS256" }).setSubject(uDirector)
      .setIssuedAt().setExpirationTime("15m").sign(key);

    const call = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {})
        }
      });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      return { status: res.status, json };
    };

    // ---- create a draft dated on two days that a shifting serialisation cannot hide ----
    const ISSUED = "2026-02-28";      // a February end: a shift shows as 27 or 29/01-03
    const DUE = "2026-03-31";         // a month end: a shift shows as 30 or 01-04
    const made = await call("/invoices", {
      method: "POST",
      body: JSON.stringify({
        customerName: "Baraka Mkwawa", customerPhone: "+255710000444",
        issueDate: ISSUED, dueDate: DUE, vatRate: 18, currency: "TZS",
        items: [{ description: "Clearing Dar es Salaam port", quantity: 1, unitPrice: 900000 }]
      })
    });
    const id = made.json?.id as string;
    check("a draft invoice is created", made.status === 201 && !!id, { s: made.status, e: made.json?.error?.code });

    const stored = await oi(`select issue_date::text as i, due_date::text as d,
                                    to_char(issue_date, 'YYYY-MM-DD') as i2
                             from freight_invoices where id = $1 and tenant_id = $2`, [id, T]);
    check("the database holds the two days the clerk typed",
      stored.rows[0]?.i === ISSUED && stored.rows[0]?.d === DUE, stored.rows[0]);

    // ---- the register ----
    const list = await call("/invoices");
    const row = (list.json?.invoices ?? []).find((r: any) => r.id === id);
    check("the register answers", list.status === 200 && !!row, { s: list.status });
    check("the register sends the issue day as a plain calendar day",
      DAY.test(String(row?.issue_date)), { issue_date: row?.issue_date });
    check("the register sends the due day as a plain calendar day",
      DAY.test(String(row?.due_date)), { due_date: row?.due_date });
    check("and sends the days the clerk chose, not the day before them",
      row?.issue_date === ISSUED && row?.due_date === DUE,
      { got: [row?.issue_date, row?.due_date], wanted: [ISSUED, DUE] });

    // ---- the detail, which is what the print layout and the edit form read ----
    const detail = await call(`/invoices/${id}`);
    check("the detail answers", detail.status === 200, { s: detail.status });
    check("the detail keeps both days",
      detail.json?.issue_date === ISSUED && detail.json?.due_date === DUE,
      { got: [detail.json?.issue_date, detail.json?.due_date] });
    check("the detail still carries a scannable code",
      String(detail.json?.qr_data_url ?? "").startsWith("data:image/"),
      { head: String(detail.json?.qr_data_url ?? "").slice(0, 24) });
    // The QR's DUE: line is built from the same day string this check reads, so the
    // printed copy cannot disagree with it while this passes.

    // ---- the edit round trip: the form prefills from exactly these fields ----
    const moved = await call(`/invoices/${id}`, {
      method: "PUT", body: JSON.stringify({ dueDate: "2026-04-30" })
    });
    check("a draft accepts a new due day", moved.status === 200, { s: moved.status, e: moved.json?.error?.code });
    const after = await call(`/invoices/${id}`);
    check("the new due day comes back as the day it was sent",
      after.json?.due_date === "2026-04-30", { due_date: after.json?.due_date });
    check("and the issue day was not dragged along by the edit",
      after.json?.issue_date === ISSUED, { issue_date: after.json?.issue_date });

    // ---- a bill with no due date at all must read null, not the epoch or today ----
    const blank = await call("/invoices", {
      method: "POST",
      body: JSON.stringify({
        customerName: "Neema Juma", customerPhone: "+255710000445",
        issueDate: ISSUED, vatRate: 18, currency: "TZS",
        items: [{ description: "Transport Dar — Morogoro", quantity: 1, unitPrice: 450000 }]
      })
    });
    const blankDetail = await call(`/invoices/${blank.json?.id}`);
    check("an invoice filed without a due date answers null, not a string",
      blankDetail.json?.due_date === null, { due_date: blankDetail.json?.due_date });

    // ---- the derived state that reads these dates in SQL must still agree ----
    await oi(`update freight_invoices set status = 'sent', due_date = current_date - 3
              where id = $1 and tenant_id = $2`, [id, T]);
    const late = await call(`/invoices/${id}`);
    check("a bill three days past its due date is still read as overdue",
      late.json?.effective_status === "overdue", { s: late.json?.effective_status });
  } finally {
    await wipe();
    const residue = await oi(`select count(*)::int as n from freight_invoices where tenant_id = $1`, [T]);
    const companies = await oi(`select count(*)::int as n from tenants where id = $1`, [T]);
    console.log(`teardown residue: ${residue.rows[0].n} invoice(s), ${companies.rows[0].n} company(ies)`);
    await owner.end();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall invoice date checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
