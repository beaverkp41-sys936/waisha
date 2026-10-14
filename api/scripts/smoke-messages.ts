/**
 * End-to-end smoke test for Internal Messages against a running API (port 4000).
 * Forges access tokens exactly like the previous module smoke tests: real
 * director for the flow, random user for the 403 gate, fake tenant for scoping.
 * Cleans up everything it creates (soft deletes); audit rows remain by design.
 *
 * Run: npx tsx scripts/smoke-messages.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

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

async function main() {
  const owner = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await owner.connect();

  const who = await owner.query(
    `select u.id as user_id, u.tenant_id, u.full_name,
            (select count(*) from cargo_shipments s where s.tenant_id = u.tenant_id and s.deleted_at is null)::int as files
     from users u
     where u.user_type = 'director' and u.status = 'active' and u.deleted_at is null
     order by files desc, u.created_at limit 1`);
  if (!who.rowCount) throw new Error("No active director found");
  const { user_id, tenant_id, full_name, files } = who.rows[0];
  console.log(`probe tenant ${tenant_id} as "${full_name}" (${files} cargo files)`);

  const file = await owner.query(
    `select id, file_number from cargo_shipments
     where tenant_id = $1 and deleted_at is null order by created_at desc limit 1`, [tenant_id]);

  // The demo tenant may have no cargo files — mint a clearly-labelled one so
  // the per-file conversation path is exercised, then soft-delete it in cleanup.
  let testFile: { id: string; file_number: string } | null = null;
  if (!file.rowCount) {
    const row = await owner.query(
      `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year, shipment_type,
         container_type, consignee_name, consignor_name, status, created_by)
       values (gen_random_uuid(), $1, '9SMOKE-001-2026', 9001, date_part('year', now())::int, 'import',
         '20ft', 'Smoke Consignee', 'Smoke Consignor', 'open', $2)
       returning id, file_number`, [tenant_id, user_id]);
    testFile = row.rows[0];
    console.log(`created smoke cargo file ${testFile!.file_number}`);
  }
  const fileId: string | null = file.rowCount ? file.rows[0].id : testFile?.id ?? null;
  const fileNumber: string | null = file.rowCount ? file.rows[0].file_number : testFile?.file_number ?? null;

  const token = await mint(user_id, tenant_id);
  const bogusUserToken = await mint("99999999-9999-7999-8999-999999999999", tenant_id, ["staff"]);
  const fakeTenantToken = await mint(user_id, "00000000-0000-7000-8000-000000000000");

  const injected: string[] = [];
  let smokeMessageId: string | null = null;

  try {
    // ---- gates ----
    const noAuth = await call("/messages/threads", null);
    check("threads without auth → 401", noAuth.status === 401, noAuth.status);

    const noPerm = await call("/messages/threads", bogusUserToken);
    check("threads with no granted role → 403", noPerm.status === 403, noPerm.status);

    const fakeTenant = await call("/messages/threads", fakeTenantToken);
    const ftThreads: any[] = fakeTenant.json?.threads ?? [];
    const isolated = fakeTenant.status === 403 ||
      (fakeTenant.status === 200 && ftThreads.every((t: any) =>
        t.scope === "general" ? (!t.lastMessage && t.unread === 0) : false));
    check("foreign tenant → no data (403, or empty view)", isolated,
      { status: fakeTenant.status, threads: ftThreads.length });

    // ---- threads ----
    const threads1 = await call("/messages/threads", token);
    check("threads → 200", threads1.status === 200, threads1.status);
    const th = threads1.json?.threads ?? [];
    const general = th.find((t: any) => t.scope === "general");
    check("general thread present and first", th[0]?.scope === "general" && !!general);
    check("cargo files listed", files === 0 ? true : th.some((t: any) => t.scope === "shipment"));

    // ---- unread flow: a message from someone else ----
    const unreadBefore = general.unread;
    const injectedId = crypto.randomUUID();
    await owner.query(
      `insert into messages (id, tenant_id, shipment_id, body, created_by)
       values ($1, $2, null, 'smoke: unread probe', $3)`,
      [injectedId, tenant_id, "55555555-5555-7555-8555-555555555555"]);
    injected.push(injectedId);

    const threads2 = await call("/messages/threads", token);
    const unreadAfter = threads2.json?.threads?.[0]?.unread;
    check(`unread ${unreadBefore} → ${unreadBefore + 1}`, unreadAfter === unreadBefore + 1, unreadAfter);

    const conv1 = await call("/messages", token);
    check("general conversation → 200", conv1.status === 200, conv1.status);
    check("injected message visible", (conv1.json?.messages ?? []).some((m: any) => m.id === injectedId));

    const threads3 = await call("/messages/threads", token);
    check("opening clears unread", threads3.json?.threads?.[0]?.unread === 0, threads3.json?.threads?.[0]?.unread);

    // ---- post + attachment round trip ----
    const post = await call("/messages", token, { method: "POST", body: JSON.stringify({ body: "smoke: hello team" }) });
    check("post → 201", post.status === 201, post.status);
    smokeMessageId = post.json?.id ?? null;

    const fd = new FormData();
    fd.append("entityType", "message");
    fd.append("entityId", smokeMessageId!);
    fd.append("kind", "attachment");
    fd.append("file", new Blob([PNG_1PX], { type: "image/png" }), "smoke.png");
    const up = await call("/documents", token, { method: "POST", body: fd });
    check("attachment upload → 201", up.status === 201, up.status + " " + JSON.stringify(up.json));

    const conv2 = await call("/messages", token);
    const mine = (conv2.json?.messages ?? []).find((m: any) => m.id === smokeMessageId);
    check("message carries sender name", mine?.senderName === full_name, mine?.senderName);
    check("attachment listed on message", mine?.attachments?.[0]?.fileName === "smoke.png", mine?.attachments);

    const url = await call(`/documents/${up.json?.id}/url`, token);
    check("attachment signed URL", url.status === 200 && typeof url.json?.url === "string", url.status);

    // ---- cargo-file conversation ----
    if (fileId) {
      const fpost = await call("/messages", token, { method: "POST", body: JSON.stringify({ shipmentId: fileId, body: "smoke: file note" }) });
      check("post to cargo file → 201", fpost.status === 201, fpost.status);
      if (fpost.json?.id) injected.push(fpost.json.id);

      const fconv = await call(`/messages?shipmentId=${fileId}`, token);
      check("file conversation header", fconv.json?.shipment?.fileNumber === fileNumber, fconv.json?.shipment);

      const fthreads = await call("/messages/threads", token);
      const fentry = (fthreads.json?.threads ?? []).find((t: any) => t.shipmentId === fileId);
      check("file thread carries last message", !!fentry?.lastMessage && fentry.unread === 0, fentry);

      const bad = await call("/messages?shipmentId=00000000-0000-7000-8000-000000000001", token);
      check("unknown cargo file → 404", bad.status === 404, bad.status);
    }

    // ---- validation + delete ----
    const tooLong = await call("/messages", token, { method: "POST", body: JSON.stringify({ body: "x".repeat(4001) }) });
    check("body > 4000 chars → 400", tooLong.status === 400, tooLong.status);

    const del = await call(`/messages/${smokeMessageId}`, token, { method: "DELETE" });
    check("delete → 200", del.status === 200, del.status);

    const conv3 = await call("/messages", token);
    check("deleted message gone", !(conv3.json?.messages ?? []).some((m: any) => m.id === smokeMessageId));
    const docLeft = await owner.query(
      "select count(*)::int as n from documents where entity_id = $1 and deleted_at is null", [smokeMessageId]);
    check("its attachment soft-deleted with it", docLeft.rows[0].n === 0, docLeft.rows[0].n);

    const delOther = await call(`/messages/${injectedId}`, token, { method: "DELETE" });
    check("delete someone else's message → 403 (director passes via messages.delete → 200)",
      delOther.status === 200 || delOther.status === 403, delOther.status);
  } finally {
    // Cleanup: soft-delete everything this smoke created (module rows never hard-delete).
    const leftovers = [...injected.filter(id => id !== smokeMessageId)];
    if (smokeMessageId) leftovers.push(smokeMessageId);
    for (const id of leftovers) {
      await owner.query("update messages set deleted_at = now() where id = $1 and deleted_at is null", [id]).catch(() => { });
    }
    // Sweep any smoke cargo file (this run's or a leftover from an aborted run).
    await owner.query(
      `update cargo_shipments set deleted_at = now()
       where tenant_id = $1 and file_number = '9SMOKE-001-2026' and deleted_at is null`, [tenant_id]).catch(() => { });
    const remaining = await owner.query(
      "select count(*)::int as n from messages where id = any($1::uuid[]) and deleted_at is null", [leftovers]);
    console.log(`cleanup: ${remaining.rows[0].n} live smoke messages remaining`);
    await owner.end();
  }

  console.log(failures ? `${failures} FAILED` : "all messages smoke checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
