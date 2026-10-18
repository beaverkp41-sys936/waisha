/**
 * End-to-end smoke for the CFA debit-note module (074): draft creation with
 * server-side totals, the DN numbering sequence, draft editing, the issue
 * freeze, cancel-with-a-reason, the delete rules, and the tenant/permission
 * gates around all of it. Also proves the trigger itself refuses a direct SQL
 * write to an issued note.
 *
 * Runs against a booted API on port 4000. Cleans up every row it creates
 * through the owner connection, scoped to the customer name it uses.
 *
 * Run: npx tsx scripts/smoke-debitnotes.ts
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const CUSTOMER = "Smoke Debit Consignee Limited";
const PHONE = "+255710000222";

async function mint(sub: string, tid: string, roles: string[] = ["director"]) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000bb", typ: roles[0], roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("15m").sign(key);
}

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
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

const body = (over: Record<string, unknown> = {}) => ({
  customerName: CUSTOMER,
  customerPhone: PHONE,
  customerEmail: "smoke@debit.example",
  customerTin: "123-456-789",
  customerAddress: "Smoke Yard, Dar es Salaam",
  reason: "Demurrage beyond seven free days on the file",
  reference: "BL-SMOKE-DN-1",
  currency: "TZS",
  vatRate: 18,
  items: [
    { description: "Container demurrage, days 8-12", quantity: 5, unit: "day", unitPrice: 18000 },
    { description: "Re-worked entry fee", quantity: 1, unitPrice: 60000 }
  ],
  ...over
});

async function sweep(owner: pg.Client, tid: string) {
  // Drafts go hard, and the cascade takes their charges with them. Anything issued
  // or cancelled is taken off the register by tombstone instead — the gate will not
  // let anyone delete a record, so the fixture leaves the row standing and unread.
  await owner.query(`delete from debit_notes where tenant_id = $1 and customer_name like $2
      and status = 'draft'`, [tid, CUSTOMER + "%"]);
  await owner.query(`update debit_notes set deleted_at = now()
      where tenant_id = $1 and customer_name like $2 and deleted_at is null`,
    [tid, CUSTOMER + "%"]);
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();

  const who = await owner.query(
    `select u.id as user_id, u.tenant_id from users u
     where u.user_type = 'director' and u.status = 'active' and u.deleted_at is null
       and exists (select 1 from company_profiles cp where cp.tenant_id = u.tenant_id)
     order by u.created_at limit 1`);
  if (!who.rowCount) throw new Error("No active director with a company profile found");
  const { user_id, tenant_id } = who.rows[0];
  console.log(`debit-note tenant ${tenant_id} as director ${user_id}`);

  await sweep(owner, tenant_id);

  const token = await mint(user_id, tenant_id);
  const noPermToken = await mint("99999999-9999-7999-8999-999999999999", tenant_id, ["staff"]);
  const otherTenantToken = await mint(user_id, "00000000-0000-7000-8000-000000000000");

  try {
    // ---------- Validation ----------
    const noReason = await call("/debit-notes", token, json(body({ reason: "" })));
    check("a note without a reason is refused", noReason.status === 400, noReason.status);
    const noItems = await call("/debit-notes", token, json(body({ items: [] })));
    check("a note without charges is refused", noItems.status === 400, noItems.status);
    const badPhone = await call("/debit-notes", token, json(body({ customerPhone: "0710000222" })));
    check("a local phone number is refused", badPhone.status === 400, badPhone.status);

    // ---------- Draft ----------
    const made = await call("/debit-notes", token, json(body()));
    check("the note is created as a draft", made.status === 201 && !!made.json?.id,
      [made.status, made.json]);
    const id: string = made.json?.id;

    const detail = await call(`/debit-notes/${id}`, token);
    check("the detail carries a DN number in sequence",
      detail.status === 200 && /^DN-\d{4,}$/.test(detail.json?.debit_note_number ?? ""),
      detail.json?.debit_note_number);
    check("the totals are computed server-side",
      Number(detail.json?.subtotal) === 150000 && Number(detail.json?.vat_amount) === 27000
        && Number(detail.json?.total) === 177000,
      [detail.json?.subtotal, detail.json?.vat_amount, detail.json?.total]);
    check("the phone comes back decrypted on the detail and never on the list",
      detail.json?.customer_phone === PHONE
        && (await call("/debit-notes", token)).json?.notes?.every((n: any) => !("customer_phone" in n)),
      detail.json?.customer_phone);
    check("the reason is stored with the note",
      detail.json?.reason === body().reason, detail.json?.reason);

    // ---------- Edit the draft ----------
    const edited = await call(`/debit-notes/${id}`, token, put({
      items: [
        { description: "Container demurrage, days 8-14", quantity: 7, unit: "day", unitPrice: 18000 },
        { description: "Re-worked entry fee", quantity: 1, unitPrice: 60000 }
      ]
    }));
    check("a draft can be edited and its totals follow", edited.status === 200, edited.status);
    const after = await call(`/debit-notes/${id}`, token);
    check("the recomputed total is right",
      Number(after.json?.subtotal) === 186000 && Number(after.json?.total) === 219480,
      [after.json?.subtotal, after.json?.total]);
    const absentKeeps = await call(`/debit-notes/${id}`, token, put({ reference: "BL-SMOKE-DN-2" }));
    check("an edit that sends only one field keeps the rest",
      absentKeeps.status === 200
        && (await call(`/debit-notes/${id}`, token)).json?.reason === body().reason,
      absentKeeps.status);

    // ---------- Permission and tenant gates ----------
    const staffList = await call("/debit-notes", noPermToken);
    check("a seat without invoices.view cannot read the register", staffList.status === 403, staffList.status);
    const staffMake = await call("/debit-notes", noPermToken, json(body()));
    check("a seat without invoices.create cannot raise a note", staffMake.status === 403, staffMake.status);
    const stranger = await call(`/debit-notes/${id}`, otherTenantToken);
    check("another tenant's token sees no note here", stranger.status === 404, stranger.status);

    // ---------- Issue and the freeze ----------
    const issue = await call(`/debit-notes/${id}/issue`, token, { method: "POST" });
    check("the draft can be issued", issue.status === 200, issue.status);
    const reissue = await call(`/debit-notes/${id}/issue`, token, { method: "POST" });
    check("an issued note cannot be issued again", reissue.status === 409, reissue.status);
    const editIssued = await call(`/debit-notes/${id}`, token, put({ reference: "sneak" }));
    check("an issued note cannot be edited", editIssued.status === 409, editIssued.status);
    const deleteIssued = await call(`/debit-notes/${id}`, token, { method: "DELETE" });
    check("an issued note cannot be deleted", deleteIssued.status === 409, deleteIssued.status);

    // The trigger is the guard, not the route: a direct SQL write is refused too.
    let triggerRefused = false;
    try {
      await owner.query(`update debit_notes set total = 1 where id = $1`, [id]);
    } catch { triggerRefused = true; }
    check("the trigger refuses a direct SQL edit of an issued note", triggerRefused);

    // ---------- Cancel with a reason ----------
    const noReasonCancel = await call(`/debit-notes/${id}/cancel`, token, json({ reason: "" }));
    check("a cancellation without a reason is refused", noReasonCancel.status === 400, noReasonCancel.status);
    const cancelled = await call(`/debit-notes/${id}/cancel`, token,
      json({ reason: "Charges withdrawn by the port after reconciliation" }));
    check("a named cancellation is accepted", cancelled.status === 200, cancelled.status);
    const recancel = await call(`/debit-notes/${id}/cancel`, token,
      json({ reason: "trying twice" }));
    check("a cancelled note cannot be cancelled again", recancel.status === 409, recancel.status);
    const editCancelled = await call(`/debit-notes/${id}`, token, put({ reference: "sneak" }));
    check("a cancelled note cannot be edited", editCancelled.status === 409, editCancelled.status);

    // ---------- A fresh draft is deletable ----------
    const temp = await call("/debit-notes", token, json(body({ customerName: CUSTOMER + " temp" })));
    check("a second note takes the next number", temp.status === 201, temp.status);
    const tempDetail = await call(`/debit-notes/${temp.json.id}`, token);
    const firstNumber = detail.json.debit_note_number as string;
    const secondNumber = tempDetail.json.debit_note_number as string;
    check("the numbering sequence advanced by one",
      Number(secondNumber.replace(/\D/g, "")) === Number(firstNumber.replace(/\D/g, "")) + 1,
      [firstNumber, secondNumber]);
    const removed = await call(`/debit-notes/${temp.json.id}`, token, { method: "DELETE" });
    check("a draft can be deleted", removed.status === 200, removed.status);

    // ---------- KPIs ----------
    const kpis = await call("/debit-notes", token);
    const mine = (kpis.json?.notes ?? []).filter((n: any) => n.customer_name?.startsWith(CUSTOMER));
    check("the register keeps the cancelled record visible",
      mine.length === 1 && mine[0].status === "cancelled", mine.length);
    check("the KPI counts land", kpis.json?.kpis && kpis.json.kpis.cancelled >= 1,
      kpis.json?.kpis);
  } finally {
    await sweep(owner, tenant_id);
    const residue = await owner.query(
      `select count(*) filter (where deleted_at is null)::int as live,
              count(*) filter (where deleted_at is not null)::int as tombstoned
         from debit_notes where tenant_id = $1 and customer_name like $2`,
      [tenant_id, CUSTOMER + "%"]);
    console.log(`residue: ${residue.rows[0].live} live debit notes, ` +
      `${residue.rows[0].tombstoned} tombstoned (issued notes are never hard-deleted)`);
    await owner.end();
  }

  console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
