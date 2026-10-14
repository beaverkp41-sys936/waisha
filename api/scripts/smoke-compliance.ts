/**
 * End-to-end smoke test for Compliance & Screening against a running API (port 4000).
 * Forges access tokens exactly like the other module smoke tests: real director
 * for the flow, random user for the 403 gate, fake tenant for scoping.
 * Cleans up everything it creates (soft deletes; screening_checks are hard-deleted
 * as pure test artifacts since the log is immutable for tenants).
 *
 * Run: npx tsx scripts/smoke-compliance.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const SMOKE_ENTRY = "Kilicorp Trading Company Limited";
const SMOKE_LICENCE = "Smoke TRA Bond Permit";
const SMOKE_FILE = "9SMOKE-002-2026";

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
  return { status: res.status, json };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const DAY = 24 * 3600 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const soon = iso(new Date(Date.now() + 12 * DAY));
const past = iso(new Date(Date.now() - DAY));

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

  // Deterministic test subjects: a cargo file + client whose name matches the
  // watchlist entry "Kilicorp Trading Company Limited" (token-subset match),
  // plus a consignor that must NOT match anything.
  await owner.query(
    `update cargo_shipments set deleted_at = now()
     where tenant_id = $1 and file_number = $2 and deleted_at is null`, [tenant_id, SMOKE_FILE]);
  const file = await owner.query(
    `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year, shipment_type,
       container_type, consignee_name, consignor_name, status, created_by)
     values (gen_random_uuid(), $1, $2, 9101, date_part('year', now())::int, 'import',
       '20ft', 'Kilicorp Trading Ltd', 'Uhuru Logistics Ltd', 'open', $3)
     returning id, file_number`, [tenant_id, SMOKE_FILE, user_id]);
  const fileId: string = file.rows[0].id;
  const fileNumber: string = file.rows[0].file_number;

  const client = await owner.query(
    `insert into clients (id, tenant_id, name, created_by, updated_by)
     values (gen_random_uuid(), $1, 'Kilicorp Trading Ltd', $2, $2)
     returning id`, [tenant_id, user_id]);
  const clientId: string = client.rows[0].id;

  const token = await mint(user_id, tenant_id);
  const bogusUserToken = await mint("99999999-9999-7999-8999-999999999999", tenant_id, ["staff"]);
  const fakeTenantToken = await mint(user_id, "00000000-0000-7000-8000-000000000000");

  let entryId: string | null = null;
  let licenceId: string | null = null;
  let docId: string | null = null;
  const checkIds: string[] = [];

  try {
    // ---- gates ----
    const noAuth = await call("/screening/entries", null);
    check("entries without auth → 401", noAuth.status === 401, noAuth.status);

    const noPerm = await call("/screening/entries", bogusUserToken);
    check("entries with no granted role → 403", noPerm.status === 403, noPerm.status);

    const noPermLic = await call("/licences", bogusUserToken);
    check("licences with no granted role → 403", noPermLic.status === 403, noPermLic.status);

    const fakeTenant = await call("/screening/entries", fakeTenantToken);
    check("foreign tenant → no data (403, or empty view)",
      fakeTenant.status === 403 || (fakeTenant.status === 200 && (fakeTenant.json ?? []).length === 0),
      { status: fakeTenant.status, rows: fakeTenant.json?.length });

    // ---- watchlist entry ----
    const created = await call("/screening/entries", token, {
      method: "POST",
      body: JSON.stringify({
        partyName: SMOKE_ENTRY, tin: "123456789",
        reason: "Smoke: watchlist screening test", source: "tra", severity: "high"
      })
    });
    check("create watchlist entry → 201", created.status === 201, created.status + " " + JSON.stringify(created.json));
    entryId = created.json?.id ?? null;

    const list1 = await call("/screening/entries", token);
    const mine = (list1.json ?? []).find((e: any) => e.id === entryId);
    check("entry listed with severity/source",
      mine?.severity === "high" && mine?.source === "tra" && mine?.status === "active", mine);

    const badEntry = await call("/screening/entries", token, {
      method: "POST", body: JSON.stringify({ partyName: "x", reason: "no" })
    });
    check("short partyName → 400", badEntry.status === 400, badEntry.status);

    const foreignEdit = await call(`/screening/entries/${entryId}`, fakeTenantToken, {
      method: "PUT", body: JSON.stringify({ status: "lifted" })
    });
    check("foreign tenant cannot edit entry → 404", foreignEdit.status === 404, foreignEdit.status);

    // ---- live match sweep ----
    const sweep1 = await call("/screening/matches", token);
    const sweepFile = (sweep1.json?.files ?? []).find((f: any) => f.subjectId === fileId);
    const sweepClient = (sweep1.json?.clients ?? []).find((cl: any) => cl.subjectId === clientId);
    check("live sweep flags the open file", sweepFile?.matches?.[0]?.field === "consignee", sweepFile);
    check("live sweep flags the client", sweepClient?.matches?.[0]?.field === "name", sweepClient);
    check("matched entry name surfaced", sweepFile?.matches?.[0]?.entryName === SMOKE_ENTRY, sweepFile?.matches);

    // ---- screening run (hit, then clear after lifting) ----
    const runFile = await call("/screening/run", token, {
      method: "POST", body: JSON.stringify({ shipmentId: fileId })
    });
    check("screen file → 201 hit", runFile.status === 201 && runFile.json?.result === "hit",
      { status: runFile.status, result: runFile.json?.result });
    if (runFile.json?.id) checkIds.push(runFile.json.id);

    const runClient = await call("/screening/run", token, {
      method: "POST", body: JSON.stringify({ clientId })
    });
    check("screen client → 201 hit", runClient.status === 201 && runClient.json?.result === "hit",
      runClient.json?.result);
    if (runClient.json?.id) checkIds.push(runClient.json.id);

    const runBoth = await call("/screening/run", token, {
      method: "POST", body: JSON.stringify({ shipmentId: fileId, clientId })
    });
    check("both ids → 400", runBoth.status === 400, runBoth.status);
    const runNone = await call("/screening/run", token, { method: "POST", body: JSON.stringify({}) });
    check("neither id → 400", runNone.status === 400, runNone.status);
    const runGhost = await call("/screening/run", token, {
      method: "POST", body: JSON.stringify({ shipmentId: crypto.randomUUID() })
    });
    check("unknown shipment → 404", runGhost.status === 404, runGhost.status);

    const lift = await call(`/screening/entries/${entryId}`, token, {
      method: "PUT", body: JSON.stringify({ status: "lifted" })
    });
    check("lift entry → 200", lift.status === 200, lift.status);

    const sweep2 = await call("/screening/matches", token);
    check("lifted entry leaves the sweep",
      !(sweep2.json?.files ?? []).some((f: any) => f.subjectId === fileId) &&
      !(sweep2.json?.clients ?? []).some((cl: any) => cl.subjectId === clientId));

    const runClear = await call("/screening/run", token, {
      method: "POST", body: JSON.stringify({ shipmentId: fileId })
    });
    check("screen file after lift → clear", runClear.json?.result === "clear", runClear.json?.result);
    if (runClear.json?.id) checkIds.push(runClear.json.id);

    const reinstate = await call(`/screening/entries/${entryId}`, token, {
      method: "PUT", body: JSON.stringify({ status: "active" })
    });
    check("reinstate entry → 200", reinstate.status === 200, reinstate.status);

    // ---- screening log ----
    const log = await call("/screening/checks", token);
    const rows = log.json ?? [];
    check("log top row is the clear run", rows[0]?.result === "clear" && rows[0]?.subject_label === fileNumber,
      rows[0]);
    check("log names the checker", rows[0]?.checked_by_name === full_name, rows[0]?.checked_by_name);
    const hitRow = rows.find((r: any) => r.result === "hit" && r.subject_label === fileNumber);
    check("log keeps the earlier hit with matches", (hitRow?.matches ?? []).length > 0, hitRow?.matches);

    // ---- notifications pick up the screening hit ----
    const notif1 = await call("/notifications", token);
    const hitNotif = (notif1.json?.items ?? []).find((i: any) =>
      i.type === "screening_hit" && i.title.includes(fileNumber));
    check("notification: screening hit on open file",
      !!hitNotif && hitNotif.title.includes(fileNumber) && hitNotif.href === "/app/cfa/compliance", hitNotif);

    // ---- licence register ----
    const lic = await call("/licences", token, {
      method: "POST",
      body: JSON.stringify({ authority: "tra", title: SMOKE_LICENCE, licenceNumber: "TRA/SMOKE/01", expiryDate: soon })
    });
    check("create licence → 201", lic.status === 201, lic.status + " " + JSON.stringify(lic.json));
    licenceId = lic.json?.id ?? null;

    const licList1 = await call("/licences", token);
    const l1 = (licList1.json ?? []).find((x: any) => x.id === licenceId);
    check("licence shows expiring status", l1?.status === "expiring" && l1?.days >= 11 && l1?.days <= 12, l1);
    check("licence dates are plain YYYY-MM-DD", l1?.expiry_date === soon, l1?.expiry_date);

    const licBad = await call("/licences", token, {
      method: "POST", body: JSON.stringify({ title: "Bad", expiryDate: "14-10-2026" })
    });
    check("bad date format → 400", licBad.status === 400, licBad.status);

    const notif2 = await call("/notifications", token);
    check("notification: licence expiring",
      (notif2.json?.items ?? []).some((i: any) => i.type === "licence_expiring" &&
        i.title.includes(SMOKE_LICENCE) && i.href === "/app/cfa/compliance"));

    const licPast = await call(`/licences/${licenceId}`, token, {
      method: "PUT", body: JSON.stringify({ expiryDate: past })
    });
    check("renew to a past date → 200", licPast.status === 200, licPast.status);
    const licList2 = await call("/licences", token);
    const l2 = (licList2.json ?? []).find((x: any) => x.id === licenceId);
    check("licence shows expired status", l2?.status === "expired" && l2?.days === -1, l2);

    const notif3 = await call("/notifications", token);
    check("notification: licence expired",
      (notif3.json?.items ?? []).some((i: any) => i.type === "licence_expired" && i.title.includes(SMOKE_LICENCE)));

    const cal = await call(`/calendar/events?month=${past.slice(0, 7)}`, token);
    check("calendar: licence expiry event on its date",
      (cal.json?.events ?? []).some((e: any) => e.type === "doc_expiry" && e.label.includes(SMOKE_LICENCE) && e.date === past),
      { month: past.slice(0, 7) });

    // ---- attachment rides the vault ----
    const fd = new FormData();
    fd.append("entityType", "licence");
    fd.append("entityId", licenceId!);
    fd.append("kind", "licence");
    fd.append("file", new Blob([PNG_1PX], { type: "image/png" }), "smoke-licence.png");
    const up = await call("/documents", token, { method: "POST", body: fd });
    check("licence scan upload → 201", up.status === 201, up.status + " " + JSON.stringify(up.json));
    docId = up.json?.id ?? null;

    const licList3 = await call("/licences", token);
    const l3 = (licList3.json ?? []).find((x: any) => x.id === licenceId);
    check("licence shows its document", l3?.document_count === 1 && l3?.latest_document_id === docId, l3);

    const docs = await call(`/documents?entityType=licence&entityId=${licenceId}`, token);
    check("documents list for the licence", (docs.json ?? []).length === 1 && docs.json[0].id === docId);

    const url = await call(`/documents/${docId}/url`, token);
    check("signed URL for the scan", url.status === 200 && typeof url.json?.url === "string", url.status);

    const vault = await call("/documents/vault?entityType=licence", token);
    const vaultRow = (vault.json ?? []).find((d: any) => d.id === docId);
    check("vault labels the licence row", vaultRow?.entity_label === SMOKE_LICENCE, vaultRow?.entity_label);

    const foreignDel = await call(`/licences/${licenceId}`, fakeTenantToken, { method: "DELETE" });
    check("foreign tenant cannot delete licence → 404", foreignDel.status === 404, foreignDel.status);

    // ---- delete paths ----
    const delEntry = await call(`/screening/entries/${entryId}`, token, { method: "DELETE" });
    check("delete watchlist entry → 200", delEntry.status === 200, delEntry.status);
    const list2 = await call("/screening/entries", token);
    check("deleted entry gone", !(list2.json ?? []).some((e: any) => e.id === entryId));

    const delLic = await call(`/licences/${licenceId}`, token, { method: "DELETE" });
    check("delete licence → 200", delLic.status === 200, delLic.status);
    const licList4 = await call("/licences", token);
    check("deleted licence gone", !(licList4.json ?? []).some((x: any) => x.id === licenceId));
    const docLeft = await owner.query(
      "select count(*)::int as n from documents where id = $1 and deleted_at is null", [docId]);
    check("licence scan soft-deleted with the licence", docLeft.rows[0].n === 0, docLeft.rows[0].n);
  } finally {
    // Cleanup. API deletes exercise the real soft-delete path (and drop the
    // storage object); owner sweeps handle rows already deleted above and the
    // hard delete of screening_checks rows this run created (log is immutable
    // for tenants, but smoke artifacts must not pollute the demo UI).
    if (docId) await call(`/documents/${docId}`, token, { method: "DELETE" }).catch(() => { });
    if (licenceId) await call(`/licences/${licenceId}`, token, { method: "DELETE" }).catch(() => { });
    if (entryId) await call(`/screening/entries/${entryId}`, token, { method: "DELETE" }).catch(() => { });
    if (checkIds.length) {
      await owner.query("delete from screening_checks where id = any($1::uuid[])", [checkIds]).catch(() => { });
    }
    await owner.query(
      `update cargo_shipments set deleted_at = now()
       where tenant_id = $1 and file_number = $2 and deleted_at is null`, [tenant_id, SMOKE_FILE]).catch(() => { });
    await owner.query(
      "update clients set deleted_at = now() where id = $1 and deleted_at is null", [clientId]).catch(() => { });
    await owner.query(
      `update screening_entries set deleted_at = now()
       where tenant_id = $1 and party_name = $2 and deleted_at is null`, [tenant_id, SMOKE_ENTRY]).catch(() => { });
    await owner.query(
      `update regulatory_licences set deleted_at = now()
       where tenant_id = $1 and title = $2 and deleted_at is null`, [tenant_id, SMOKE_LICENCE]).catch(() => { });
    await owner.query(
      `update documents set deleted_at = now()
       where tenant_id = $1 and entity_id = $2 and deleted_at is null`, [tenant_id, licenceId ?? "00000000-0000-7000-8000-000000000000"]).catch(() => { });

    const left = await owner.query(
      `select
         (select count(*) from screening_entries where tenant_id = $1 and party_name = $2 and deleted_at is null)::int as entries,
         (select count(*) from regulatory_licences where tenant_id = $1 and title = $3 and deleted_at is null)::int as licences,
         (select count(*) from cargo_shipments where tenant_id = $1 and file_number = $4 and deleted_at is null)::int as files,
         (select count(*) from screening_checks where id = any($5::uuid[]))::int as checks`,
      [tenant_id, SMOKE_ENTRY, SMOKE_LICENCE, SMOKE_FILE, checkIds.length ? checkIds : ["00000000-0000-7000-8000-000000000000"]]);
    const L = left.rows[0];
    console.log(`cleanup: entries=${L.entries} licences=${L.licences} files=${L.files} checks=${L.checks} remaining`);
    await owner.end();
  }

  console.log(failures ? `${failures} FAILED` : "all compliance smoke checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
