/**
 * End-to-end smoke test for the Shipper portal against a running API (port 4000).
 * A director creates a client + shipper account; the shipper logs in through the
 * real /auth/login shipper mode and exercises the portal: visibility scoping
 * (name-match + explicit share), invoices, uploads and the suspension gate.
 * Cleans up everything it creates.
 *
 * Run: npx tsx scripts/smoke-shipper.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const CLIENT_NAME = "Kilian Smoke Shipper Ltd";
const SHIPPER_NAME = "Kilian Smoke Shipper Contact";
const SHIPPER_EMAIL = `smoke.shipper.${STAMP}@waisha.test`;
const SHIPPER_PHONE = `+2557${STAMP.padStart(9, "0")}`;
const PASSWORD = "Smoke-Passw0rd!";
const PASSWORD2 = "Smoke-Passw0rd-2!";
const FILE_MATCHED = `9SMK1-940-${new Date().getFullYear()}`;
const FILE_OTHER = `9SMK2-941-${new Date().getFullYear()}`;
const INV_MATCHED = `SMK-INV-${STAMP}-1`;
const INV_OTHER = `SMK-INV-${STAMP}-2`;

async function mint(sub: string, tid: string, roles: string[] = ["director"]) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000aa", typ: roles[0], roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("15m").sign(key);
}

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
  return { status: res.status, json, headers: res.headers };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

async function main() {
  const owner = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await owner.connect();

  const who = await owner.query(
    `select u.id as user_id, u.tenant_id, u.full_name from users u
     where u.user_type = 'director' and u.status = 'active' and u.deleted_at is null
     order by (select count(*) from cargo_shipments s where s.tenant_id = u.tenant_id and s.deleted_at is null) desc,
              u.created_at limit 1`);
  if (!who.rowCount) throw new Error("No active director found");
  const { user_id, tenant_id, full_name } = who.rows[0];
  console.log(`probe tenant ${tenant_id} as "${full_name}"`);

  // ---- pre-clean any stale smoke rows ----
  // This suite signs in for real about seven times, and the login bucket is
  // 10 per 300s per IP, so a previous suite's logins can throttle it on their
  // own. The buckets are clock-aligned windows, not history — clear them.
  await owner.query(`delete from rate_limits where bucket like 'login:%' or bucket like 'ip:%'`);
  await owner.query(
    `update shipper_accounts sa set deleted_at = now()
     from clients c where sa.client_id = c.id and c.tenant_id = $1
       and c.name = $2 and sa.deleted_at is null`, [tenant_id, CLIENT_NAME]);
  await owner.query(
    `update clients set deleted_at = now()
     where tenant_id = $1 and name = $2 and deleted_at is null`, [tenant_id, CLIENT_NAME]);
  await owner.query(
    `update users set deleted_at = now()
     where email like 'smoke.shipper.%@waisha.test' and deleted_at is null`);
  await owner.query(
    `update cargo_shipments set deleted_at = now()
     where tenant_id = $1 and file_number in ($2,$3) and deleted_at is null`,
    [tenant_id, FILE_MATCHED, FILE_OTHER]);
  await owner.query(
    `delete from freight_invoice_items where invoice_id in
       (select id from freight_invoices where tenant_id = $1 and invoice_number like 'SMK-INV-%')`, [tenant_id]);
  await owner.query(
    `delete from freight_invoice_payments where invoice_id in
       (select id from freight_invoices where tenant_id = $1 and invoice_number like 'SMOK-INV-%' or invoice_number like 'SMK-INV-%')`, [tenant_id]);
  await owner.query(
    `update freight_invoices set deleted_at = now()
     where tenant_id = $1 and invoice_number like 'SMK-INV-%' and deleted_at is null`, [tenant_id]);

  // ---- fixtures: one matched cargo file, one unrelated, two invoices ----
  const fileM = await owner.query(
    `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year, shipment_type,
       container_type, consignee_name, consignor_name, status, stage, eta,
       payment_amount, processing_cost, created_by)
     values (gen_random_uuid(), $1, $2, 9410, date_part('year', now())::int, 'import',
       '40ft', $3, 'Smoke Origin Ltd', 'open', 'customs', current_date + 3,
       500000, 200000, $4)
     returning id`,
    [tenant_id, FILE_MATCHED, CLIENT_NAME, user_id]);
  const fileMId: string = fileM.rows[0].id;

  const fileU = await owner.query(
    `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year, shipment_type,
       container_type, consignee_name, consignor_name, status, stage, eta,
       payment_amount, processing_cost, created_by)
     values (gen_random_uuid(), $1, $2, 9411, date_part('year', now())::int, 'export',
       '20ft', 'Smoke Unrelated Party', 'Smoke Origin Ltd', 'open', 'arrival', current_date + 10,
       300000, 100000, $3)
     returning id`,
    [tenant_id, FILE_OTHER, user_id]);
  const fileUId: string = fileU.rows[0].id;

  const invM = await owner.query(
    `insert into freight_invoices (id, tenant_id, invoice_number, customer_name,
       issue_date, due_date, currency, vat_rate, subtotal, vat_amount, total,
       amount_paid, status, payment_instructions, created_by)
     values (gen_random_uuid(), $1, $2, $3, current_date, current_date - 5, 'TZS', 18,
       1000000, 180000, 1180000, 500000, 'sent', 'Pay to CRDB account 0123-456-789', $4)
     returning id`,
    [tenant_id, INV_MATCHED, CLIENT_NAME, user_id]);
  const invMId: string = invM.rows[0].id;
  await owner.query(
    `insert into freight_invoice_items (tenant_id, invoice_id, seq, description, quantity, unit, unit_price, amount)
     values ($1,$2,1,'Clearing and forwarding',1,'file',1000000,1000000),
            ($1,$2,2,'Port handling',1,'file',0,0)`,
    [tenant_id, invMId]);
  await owner.query(
    `insert into freight_invoice_payments (tenant_id, invoice_id, amount, method, reference, paid_at)
     values ($1,$2,500000,'bank','TRF-90121',now())`,
    [tenant_id, invMId]);

  const invO = await owner.query(
    `insert into freight_invoices (id, tenant_id, invoice_number, customer_name,
       issue_date, due_date, currency, vat_rate, subtotal, vat_amount, total,
       amount_paid, status, created_by)
     values (gen_random_uuid(), $1, $2, 'Smoke Unrelated Party', current_date, current_date + 30,
       'TZS', 18, 200000, 36000, 236000, 0, 'sent', $3)
     returning id`,
    [tenant_id, INV_OTHER, user_id]);
  const invOId: string = invO.rows[0].id;

  const token = await mint(user_id, tenant_id);
  const bogusUserToken = await mint("99999999-9999-7999-8999-999999999999", tenant_id, ["staff"]);

  let clientId: string | null = null;
  let accountId: string | null = null;
  let smokeUserId: string | null = null;
  let portalDocId: string | null = null;
  let otherDocId: string | null = null;

  try {
    // ---- gates ----
    const noAuth = await call("/shipper-accounts", null);
    check("accounts without auth → 401", noAuth.status === 401, noAuth.status);

    const noPerm = await call("/shipper-accounts", bogusUserToken);
    check("accounts with no granted role → 403", noPerm.status === 403, noPerm.status);

    const noPermPortal = await call("/portal/overview", bogusUserToken);
    check("portal with no granted role → 403", noPermPortal.status === 403, noPermPortal.status);

    const directorPortal = await call("/portal/overview", token);
    check("director has portal keys but no account → 403",
      directorPortal.status === 403 && directorPortal.json?.error?.message?.includes("No transporter has granted"),
      { status: directorPortal.status, msg: directorPortal.json?.error?.message });

    // ---- client + account creation ----
    const client = await call("/clients", token, {
      method: "POST", body: JSON.stringify({ name: CLIENT_NAME, notes: "Smoke shipper portal client" })
    });
    check("create smoke client → 201", client.status === 201, client.status + " " + JSON.stringify(client.json));
    clientId = client.json?.id ?? null;

    const weak = await call("/shipper-accounts", token, {
      method: "POST",
      body: JSON.stringify({ clientId, fullName: SHIPPER_NAME, email: `x.${STAMP}@waisha.test`, password: "short" })
    });
    check("weak password → 400", weak.status === 400, weak.status);

    const ghostClient = await call("/shipper-accounts", token, {
      method: "POST",
      body: JSON.stringify({ clientId: crypto.randomUUID(), fullName: SHIPPER_NAME, email: `y.${STAMP}@waisha.test`, password: PASSWORD })
    });
    check("unknown client → 404", ghostClient.status === 404, ghostClient.status);

    const created = await call("/shipper-accounts", token, {
      method: "POST",
      body: JSON.stringify({
        clientId, fullName: SHIPPER_NAME, email: SHIPPER_EMAIL,
        phone: SHIPPER_PHONE, password: PASSWORD, notes: "Smoke portal account"
      })
    });
    check("create shipper account → 201", created.status === 201, created.status + " " + JSON.stringify(created.json));
    accountId = created.json?.id ?? null;

    const dupe = await call("/shipper-accounts", token, {
      method: "POST",
      body: JSON.stringify({ clientId, fullName: "Second Contact", email: SHIPPER_EMAIL, password: PASSWORD })
    });
    check("duplicate email → 409 CONFLICT", dupe.status === 409 && dupe.json?.error?.code === "CONFLICT",
      { status: dupe.status, code: dupe.json?.error?.code });

    const accounts = await call("/shipper-accounts", token);
    const row = (accounts.json ?? []).find((a: any) => a.id === accountId);
    smokeUserId = row?.user_id ?? null;
    check("account listed: contact, status, phone flag, counts",
      row?.full_name === SHIPPER_NAME && row?.email === SHIPPER_EMAIL && row?.status === "active" &&
      row?.has_phone === true && row?.matched_files === 1 && row?.shared_files === 0 && row?.invoice_count === 1 &&
      row?.invited_by_name === full_name,
      row && { n: row.full_name, s: row.status, ph: row.has_phone, m: row.matched_files, i: row.invoice_count, by: row.invited_by_name });

    const detail = await call(`/shipper-accounts/${accountId}`, token);
    check("detail: matched file only, no shares",
      detail.json?.matchedFiles?.length === 1 && detail.json?.matchedFiles[0]?.file_number === FILE_MATCHED &&
      detail.json?.sharedFiles?.length === 0,
      { m: detail.json?.matchedFiles?.map((f: any) => f.file_number), s: detail.json?.sharedFiles?.length });

    // ---- real shipper login ----
    const badLogin = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "shipper", email: SHIPPER_EMAIL, password: "Wrong-Pass1!" })
    });
    check("shipper login with wrong password → 401", badLogin.status === 401, badLogin.status);

    const login = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "shipper", email: SHIPPER_EMAIL, password: PASSWORD })
    });
    check("shipper login via email → 200 with portal role",
      login.status === 200 && (login.json?.roles ?? []).includes("shipper_portal"),
      { status: login.status, roles: login.json?.roles });
    const shipperToken = login.json?.accessToken;

    const loginPhone = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "shipper", phone: SHIPPER_PHONE, password: PASSWORD })
    });
    check("shipper login via phone → 200", loginPhone.status === 200, loginPhone.status);

    // ---- portal visibility ----
    const overview = await call("/portal/overview", shipperToken);
    const ov = overview.json;
    check("overview: client identity", ov?.client?.name === CLIENT_NAME && ov?.client?.fullName === SHIPPER_NAME, ov?.client);
    check("overview: counts see only the matched file",
      ov?.counts?.total === 1 && ov?.counts?.open === 1 && ov?.counts?.in_customs === 1 &&
      ov?.counts?.arriving_soon === 1 && ov?.counts?.completed === 0, ov?.counts);
    check("overview: outstanding invoice balance 680000",
      ov?.outstanding?.count === 1 && ov?.outstanding?.amount === 680000, ov?.outstanding);
    check("overview: recent files = matched only",
      ov?.recentFiles?.length === 1 && ov?.recentFiles[0]?.file_number === FILE_MATCHED, ov?.recentFiles);

    const files = await call("/portal/files", shipperToken);
    check("files list: matched only",
      (files.json ?? []).length === 1 && files.json[0]?.id === fileMId && files.json[0]?.consignee_name === CLIENT_NAME,
      files.json?.map((f: any) => f.file_number));

    const fileDetail = await call(`/portal/files/${fileMId}`, shipperToken);
    check("file detail visible, internal fields withheld",
      fileDetail.status === 200 && fileDetail.json?.file?.file_number === FILE_MATCHED &&
      fileDetail.json?.file?.processing_cost === undefined && fileDetail.json?.file?.notes === undefined,
      { s: fileDetail.status, hasCost: "processing_cost" in (fileDetail.json?.file ?? {}) });

    const fileHidden = await call(`/portal/files/${fileUId}`, shipperToken);
    check("unmatched file detail → 404", fileHidden.status === 404, fileHidden.status);

    const invoices = await call("/portal/invoices", shipperToken);
    check("invoices: only the client's invoice, partial status",
      (invoices.json ?? []).length === 1 && invoices.json[0]?.invoice_number === INV_MATCHED &&
      invoices.json[0]?.effective_status === "partial" && invoices.json[0]?.total === 1180000,
      invoices.json?.map((i: any) => `${i.invoice_number}:${i.effective_status}`));

    const invDetail = await call(`/portal/invoices/${invMId}`, shipperToken);
    check("invoice detail: items, payments, instructions",
      invDetail.status === 200 && invDetail.json?.items?.length === 2 &&
      invDetail.json?.payments?.length === 1 && invDetail.json?.payments[0]?.amount === 500000 &&
      invDetail.json?.invoice?.payment_instructions?.includes("CRDB"),
      { s: invDetail.status, items: invDetail.json?.items?.length, pay: invDetail.json?.payments?.length });

    const invHidden = await call(`/portal/invoices/${invOId}`, shipperToken);
    check("foreign invoice detail → 404", invHidden.status === 404, invHidden.status);

    // ---- uploads ----
    const fd = new FormData();
    fd.append("shipmentId", fileMId);
    fd.append("file", new Blob([PNG_1PX], { type: "image/png" }), "smoke-shipper-upload.png");
    const up = await call("/portal/documents", shipperToken, { method: "POST", body: fd });
    check("shipper upload on matched file → 201", up.status === 201, up.status + " " + JSON.stringify(up.json));
    portalDocId = up.json?.id ?? null;

    const upHidden = await call("/portal/documents", shipperToken, {
      method: "POST",
      body: (() => { const f = new FormData(); f.append("shipmentId", fileUId);
        f.append("file", new Blob([PNG_1PX], { type: "image/png" }), "nope.png"); return f; })()
    });
    check("shipper upload on unmatched file → 404", upHidden.status === 404, upHidden.status);

    const portalDocs = await call("/portal/documents", shipperToken);
    check("portal documents list shows the upload",
      (portalDocs.json ?? []).some((d: any) => d.id === portalDocId && d.kind === "shipper_upload"),
      portalDocs.json?.map((d: any) => `${d.kind}:${d.file_name}`));

    const docUrl = await call(`/portal/documents/${portalDocId}/url`, shipperToken);
    check("signed URL for own upload", docUrl.status === 200 && typeof docUrl.json?.url === "string", docUrl.status);

    // a document the shipper cannot see (on the unmatched file, uploaded by staff)
    const fd2 = new FormData();
    fd2.append("entityType", "shipment");
    fd2.append("entityId", fileUId);
    fd2.append("kind", "bill_of_lading");
    fd2.append("file", new Blob([PNG_1PX], { type: "image/png" }), "smoke-staff-doc.png");
    const upStaff = await call("/documents", token, { method: "POST", body: fd2 });
    otherDocId = upStaff.json?.id ?? null;
    const otherUrl = await call(`/portal/documents/${otherDocId}/url`, shipperToken);
    check("signed URL for a document on an invisible file → 404", otherUrl.status === 404, otherUrl.status);

    // ---- explicit share widens visibility ----
    const share = await call(`/shipper-accounts/${accountId}/shares`, token, {
      method: "POST", body: JSON.stringify({ shipmentId: fileUId })
    });
    check("share the unmatched file → 201", share.status === 201, share.status + " " + JSON.stringify(share.json));

    const files2 = await call("/portal/files", shipperToken);
    check("after share: both files visible",
      (files2.json ?? []).length === 2 && files2.json.some((f: any) => f.id === fileUId),
      files2.json?.map((f: any) => f.file_number));
    const fileUDetail = await call(`/portal/files/${fileUId}`, shipperToken);
    check("shared file detail now open", fileUDetail.status === 200, fileUDetail.status);
    const detail2 = await call(`/shipper-accounts/${accountId}`, token);
    check("director detail: one shared file",
      detail2.json?.sharedFiles?.length === 1 && detail2.json?.sharedFiles[0]?.file_number === FILE_OTHER,
      detail2.json?.sharedFiles?.map((f: any) => f.file_number));

    const unshare = await call(`/shipper-accounts/${accountId}/shares/${fileUId}`, token, { method: "DELETE" });
    check("unshare → 200", unshare.status === 200, unshare.status);
    const files3 = await call("/portal/files", shipperToken);
    check("after unshare: back to matched only", (files3.json ?? []).length === 1, files3.json?.length);

    const ghostShare = await call(`/shipper-accounts/${accountId}/shares`, token, {
      method: "POST", body: JSON.stringify({ shipmentId: crypto.randomUUID() })
    });
    check("sharing a ghost file → 404", ghostShare.status === 404, ghostShare.status);

    // ---- suspension gate ----
    const suspend = await call(`/shipper-accounts/${accountId}`, token, {
      method: "PUT", body: JSON.stringify({ status: "suspended" })
    });
    check("suspend account → 200", suspend.status === 200, suspend.status);
    const portalSuspended = await call("/portal/overview", shipperToken);
    check("suspended shipper blocked from portal → 403",
      portalSuspended.status === 403 && portalSuspended.json?.error?.message?.includes("No transporter has granted"),
      { status: portalSuspended.status, msg: portalSuspended.json?.error?.message });
    const reactivate = await call(`/shipper-accounts/${accountId}`, token, {
      method: "PUT", body: JSON.stringify({ status: "active" })
    });
    check("reactivate account → 200", reactivate.status === 200, reactivate.status);
    const portalBack = await call("/portal/overview", shipperToken);
    check("reactivated shipper sees the portal again", portalBack.status === 200, portalBack.status);

    // ---- foreign tenant scoping ----
    const fakeTenantShipper = await mint(smokeUserId ?? crypto.randomUUID(), "00000000-0000-7000-8000-000000000000", ["shipper_portal"]);
    const foreignPortal = await call("/portal/overview", fakeTenantShipper);
    check("same shipper in a foreign tenant → 403", foreignPortal.status === 403, foreignPortal.status);
    const fakeTenantDirector = await mint(user_id, "00000000-0000-7000-8000-000000000000", ["director"]);
    const foreignEdit = await call(`/shipper-accounts/${accountId}`, fakeTenantDirector, {
      method: "PUT", body: JSON.stringify({ status: "suspended" })
    });
    check("foreign tenant cannot manage accounts → 404", foreignEdit.status === 404, foreignEdit.status);

    // ---- password rotation ----
    const pwChange = await call(`/shipper-accounts/${accountId}`, token, {
      method: "PUT", body: JSON.stringify({ password: PASSWORD2 })
    });
    check("password change → 200", pwChange.status === 200, pwChange.status);
    const oldLogin = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "shipper", email: SHIPPER_EMAIL, password: PASSWORD })
    });
    check("old password rejected", oldLogin.status === 401, oldLogin.status);
    const newLogin = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "shipper", email: SHIPPER_EMAIL, password: PASSWORD2 })
    });
    check("new password accepted", newLogin.status === 200, newLogin.status);

    // ---- refresh rotation ----
    // 002 declared rotate_refresh's ip as text and coalesced it into sessions.ip
    // (inet). Postgres found no common type, so every refresh aborted with 42804
    // and no session could outlive its 15-minute access token. 045 fixed it.
    const cookieOf = (h: Headers) =>
      (typeof h.getSetCookie === "function" ? h.getSetCookie() : [])
        .find((c) => c.startsWith("waisha_refresh="))?.split(";")[0] ?? "";
    const rc1 = cookieOf(newLogin.headers);
    const withCookie = (value: string) =>
      call("/auth/refresh", null, { method: "POST", headers: { Cookie: value } });
    const refresh1 = await withCookie(rc1);
    check("refresh rotates the session → 200 with a new access token",
      !!rc1 && refresh1.status === 200 && !!refresh1.json?.accessToken,
      { cookie: !!rc1, status: refresh1.status, body: refresh1.json });
    const rc2 = cookieOf(refresh1.headers);
    check("rotation hands back a different refresh token", !!rc2 && rc2 !== rc1);
    const refresh2 = await withCookie(rc2);
    check("the rotated token refreshes again — chain stays alive",
      refresh2.status === 200, refresh2.status);
    const reuse = await withCookie(rc1);
    check("replaying the retired token is refused and kills the family",
      reuse.status === 401 && reuse.json?.error?.code === "TOKEN_REUSE",
      { status: reuse.status, code: reuse.json?.error?.code });
    const rot = await owner.query(
      `select count(*)::int as n, count(*) filter (where ip is not null)::int as with_ip
         from sessions where user_id = $1 and revoked_reason = 'rotated'`, [smokeUserId]);
    check("rotated sessions stored their ip as inet",
      rot.rows[0].n >= 2 && rot.rows[0].with_ip === rot.rows[0].n, rot.rows[0]);

    // ---- removal kills the login ----
    const remove = await call(`/shipper-accounts/${accountId}`, token, { method: "DELETE" });
    check("remove account → 200", remove.status === 200, remove.status);
    const deadLogin = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "shipper", email: SHIPPER_EMAIL, password: PASSWORD2 })
    });
    check("removed shipper cannot log in → 401", deadLogin.status === 401, deadLogin.status);
    const accountsAfter = await call("/shipper-accounts", token);
    check("account gone from the list",
      !((accountsAfter.json ?? []).some((a: any) => a.id === accountId)), accountsAfter.json?.length);

  } finally {
    // Cleanup: API paths already removed the account; sweep the rest.
    if (otherDocId) await call(`/documents/${otherDocId}`, token, { method: "DELETE" }).catch(() => { });
    if (portalDocId) await owner.query(
      `update documents set deleted_at = now() where id = $1 and deleted_at is null`, [portalDocId]).catch(() => { });

    await owner.query(
      `update shipper_file_shares sfs set deleted_at = now()
       from shipper_accounts sa join clients c on c.id = sa.client_id
       where sfs.shipper_account_id = sa.id and sfs.tenant_id = $1
         and c.tenant_id = $1 and c.name = $2 and sfs.deleted_at is null`,
      [tenant_id, CLIENT_NAME]).catch(() => { });
    await owner.query(
      `update shipper_accounts sa set deleted_at = now()
       from clients c where sa.client_id = c.id and c.tenant_id = $1
         and c.name = $2 and sa.deleted_at is null`, [tenant_id, CLIENT_NAME]).catch(() => { });
    await owner.query(
      `update users set deleted_at = now()
       where email like 'smoke.shipper.%@waisha.test' and deleted_at is null`).catch(() => { });
    await owner.query(
      `delete from sessions where user_id in
         (select id from users where email like 'smoke.shipper.%@waisha.test')`).catch(() => { });
    await owner.query(
      `update clients set deleted_at = now()
       where tenant_id = $1 and name = $2 and deleted_at is null`, [tenant_id, CLIENT_NAME]).catch(() => { });
    await owner.query(
      `update cargo_shipments set deleted_at = now()
       where tenant_id = $1 and file_number in ($2,$3) and deleted_at is null`,
      [tenant_id, FILE_MATCHED, FILE_OTHER]).catch(() => { });
    await owner.query(
      `update documents set deleted_at = now()
       where tenant_id = $1 and entity_type = 'shipment' and entity_id in
         (select id from cargo_shipments where tenant_id = $1 and file_number in ($2,$3))
         and deleted_at is null`,
      [tenant_id, FILE_MATCHED, FILE_OTHER]).catch(() => { });
    await owner.query(
      `delete from freight_invoice_items where invoice_id in
         (select id from freight_invoices where tenant_id = $1 and invoice_number like 'SMK-INV-%')`,
      [tenant_id]).catch(() => { });
    await owner.query(
      `delete from freight_invoice_payments where invoice_id in
         (select id from freight_invoices where tenant_id = $1 and invoice_number like 'SMK-INV-%')`,
      [tenant_id]).catch(() => { });
    await owner.query(
      `update freight_invoices set deleted_at = now()
       where tenant_id = $1 and invoice_number like 'SMK-INV-%' and deleted_at is null`,
      [tenant_id]).catch(() => { });

    const left = await owner.query(
      `select
         (select count(*) from clients where tenant_id = $1 and name = $2 and deleted_at is null)::int as clients,
         (select count(*) from cargo_shipments where tenant_id = $1 and file_number in ($3,$4) and deleted_at is null)::int as files,
         (select count(*) from freight_invoices where tenant_id = $1 and invoice_number like 'SMK-INV-%' and deleted_at is null)::int as invoices,
         (select count(*) from shipper_accounts sa join clients c on c.id = sa.client_id
            where sa.tenant_id = $1 and c.name = $2 and sa.deleted_at is null)::int as accounts,
         (select count(*) from users where email like 'smoke.shipper.%@waisha.test' and deleted_at is null)::int as users,
         (select count(*) from documents d join cargo_shipments cs on cs.id = d.entity_id
            where d.tenant_id = $1 and d.entity_type = 'shipment'
              and cs.file_number in ($3,$4) and d.deleted_at is null)::int as documents`,
      [tenant_id, CLIENT_NAME, FILE_MATCHED, FILE_OTHER]);
    const L = left.rows[0];
    console.log(`cleanup: clients=${L.clients} files=${L.files} invoices=${L.invoices} accounts=${L.accounts} users=${L.users} documents=${L.documents} remaining`);
    await owner.end();
  }

  console.log(failures ? `${failures} FAILED` : "all shipper portal smoke checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
