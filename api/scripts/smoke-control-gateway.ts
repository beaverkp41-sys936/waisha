/**
 * The payment gateway desk over HTTP — smoke for #283 (migration 114, registry.ts, the webhook).
 *
 * verify-gateway-sql.ts can prove the grants and the CHECKs. Only HTTP can prove the four things
 * this stage is actually for:
 *
 *  - that a rail filed at the desk is the rail a charge is pushed through, without a deploy and
 *    without an environment variable (the intent call reaches the address typed on the form, and
 *    fails for the reason that address gives);
 *  - that credentials go in and never come out — the register's own list reader is the desk's only
 *    view, it has no credential column to leak, and the sealed bytes in the row do not contain the
 *    text that was typed;
 *  - that reading the register and writing it are two duties, and that an unadapted rail cannot be
 *    switched on even by the seat that owns the desk;
 *  - that the webhook closes a charge: an unsigned call completes nothing, one delivery seen twice
 *    spends nothing twice, and a refusal is still written to the ledger.
 *
 * SAFETY: `payment_gateways` is platform-global — it has no tenant column, because the platform
 * decides which rail every company is charged through. So this run snapshots every rail row before
 * it touches one and restores all of them, including the switch, in its finally block. A synthetic
 * second rail (`gwsmoke<STAMP>`) is used for the one-rail rule and deleted outright. Nothing here
 * reads or writes a real company: the seats, the charge and the payment are this run's own, found
 * by name prefix at teardown. Audit rows cannot be deleted — `prevent_audit_mutation()` refuses the
 * owner too — so this run's gateway lines stay in the register on purpose, exactly as 084's and
 * 101's smokes leave theirs.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-control-gateway.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { createHmac, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { decryptField, sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const MARK = `gw${STAMP}`;
const TENANT_SWEEP = "GW Smoke %";
const EMAIL_SWEEP = `smoke.gw.%@waisha.test`;
const SYNTH = `gwsmoke${STAMP}`.slice(0, 32);
// The address no network answers. A push that reaches it must fail, and the failure is the proof
// that the register — not PAYMENT_PROVIDER — chose where the money was going.
const DEAD_URL = `https://pay.${MARK}.invalid`;
const APP_ID = `waisha-${MARK}`;
const APP_SECRET = `sekret-${MARK}-9f3c`;
const WH_SECRET = `wh-${MARK}-0f1e2d3c4b5a`;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

async function call(path: string, opts: {
  token?: string; ck?: string; method?: string; body?: any; headers?: Record<string, string>;
  raw?: string;
} = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body === undefined && opts.raw === undefined ? "GET" : "POST"),
    ...(opts.raw !== undefined ? { body: opts.raw }
      : opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    headers: {
      ...(opts.body === undefined && opts.raw === undefined ? {}
        : { "Content-Type": "application/json" }),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.ck ? { Cookie: opts.ck } : {}),
      ...(opts.headers ?? {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const roleRows = (await oi(
    `select id, key from roles where tenant_id is null
      and key = any($1)`, [["super_admin", "support_engineer", "platform_analyst", "director"]]
  )).rows;
  const rid = (k: string) => roleRows.find((r: any) => r.key === k)?.id;
  if (!rid("super_admin") || !rid("support_engineer") || !rid("director"))
    throw new Error("the global roles this desk grants to are missing");

  // ---------------- the register as it was found ----------------
  const RAIL_COLS = `provider_key, label, adapter, base_url, environment, credentials_encrypted,
    webhook_secret_encrypted, credential_hint, config, enabled, updated_by, updated_at, last_check`;
  const before = (await oi(`select ${RAIL_COLS} from payment_gateways`)).rows;
  const ledgerBefore = (await oi("select count(*)::int as n from payment_webhooks")).rows[0].n;
  console.log(`register found: ${before.length} rails, `
    + `${before.filter((r: any) => r.enabled).length} live, ledger ${ledgerBefore} rows`);

  const restoreRails = async () => {
    await oi(`delete from payment_gateways where provider_key = $1`, [SYNTH]);
    for (const r of before) {
      await oi(`update payment_gateways set label=$2, adapter=$3, base_url=$4, environment=$5,
          credentials_encrypted=$6, webhook_secret_encrypted=$7, credential_hint=$8, config=$9,
          enabled=$10, updated_by=$11, updated_at=$12, last_check=$13
         where provider_key = $1`,
        [r.provider_key, r.label, r.adapter, r.base_url, r.environment, r.credentials_encrypted,
         r.webhook_secret_encrypted, r.credential_hint, r.config, r.enabled, r.updated_by,
         r.updated_at, r.last_check]);
    }
  };

  // ---------------- fixtures ----------------
  const TP = randomUUID();     // the platform desk this run signs in at
  const TC = randomUUID();     // a company whose licence this run can open and close
  const uOwner = randomUUID(); // super_admin: the only seat that may write the register
  const uEng = randomUUID();   // support_engineer: reads it, cannot write it
  const uAn = randomUUID();    // platform_analyst: reads it too
  const uDir = randomUUID();   // director: a platform seat with neither duty
  const uBoss = randomUUID();  // the company seat that raises the charge

  const tok = (who: string) => `${MARK}-${who}`;
  const ck = (who: string) => `waisha_control=${tok(who)}`;

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    // Referencing rows first: the charges are this run's, and the ledger rows are the ones this
    // window wrote (the provider key is one of the two rails this run ever switched on).
    await oi(`delete from payment_webhooks where provider = any($1::text[])
              and created_at >= $2`, [[SYNTH, "azampesa", "mpesa", "smoke"], new Date(START)]);
    await oi(`delete from payments where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from invoices where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from subscriptions where tenant_id = any($1::uuid[])`, [all]);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
    await oi(`delete from payment_gateways where provider_key = $1`, [SYNTH]);
    await restoreRails();
    await oi(`delete from rate_limits where bucket like 'gateway%' or bucket like 'pay:uid:%'
              or bucket like 'webhook:ip:%'`);
  };

  const START = Date.now();
  await sweep();

  await oi(`insert into tenants (id, type, name, status, trial_ends_at) values
      ($1,'platform',$2,'active', now() + interval '30 days'),
      ($3,'transporter',$4,'trial', now() + interval '3 days')`,
    [TP, `GW Smoke Platform ${STAMP}`, TC, `GW Smoke Cargo Ltd ${STAMP}`]);

  const seat = (id: string, tenant: string, type: string, name: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,$3,$4,$5,'active',$6, now() - interval '2 hours', now() - interval '200 days')`,
      [id, tenant, type, name, `smoke.gw.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`,
        type === "platform"]);
  await seat(uOwner, TP, "platform", "Gwen Owner");
  await seat(uEng, TP, "platform", "Esther Engineer");
  await seat(uAn, TP, "platform", "Amina Analyst");
  await seat(uDir, TP, "platform", "Daudi Director");
  await seat(uBoss, TC, "staff", "Beatrice Boss");

  await oi(`insert into user_roles (user_id, role_id) values ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10)`,
    [uOwner, rid("super_admin"), uEng, rid("support_engineer"), uAn, rid("platform_analyst"),
      uDir, rid("director"), uBoss, rid("director")]);

  const openSession = (uid: string, tenant: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-gateway',$6,
          now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who)), "127.0.0.1"]);
  for (const [uid, tenant, who] of [
    [uOwner, TP, "owner"], [uEng, TP, "eng"], [uAn, TP, "an"],
    [uDir, TP, "dir"], [uBoss, TC, "boss"]
  ] as [string, string, string][]) await openSession(uid, tenant, who);

  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);

  const rail = async (k: string) =>
    (await oi(`select ${RAIL_COLS} from payment_gateways where provider_key = $1`, [k])).rows[0];

  let bossToken = "";

  try {
    // ---------------- the door ----------------
    phase("the door");
    check("an anonymous request never reads the register",
      (await call("/control/gateway")).status === 401);
    check("a cookie with no session row behind it is refused",
      (await call("/control/gateway", { ck: `${MARK}-nobody` })).status === 401);
    const companyCookie = await call("/control/gateway", { ck: ck("boss") });
    check("099: a company seat cannot open a platform desk at all",
      companyCookie.status === 401, companyCookie.json);

    // ---------------- who may read it ----------------
    phase("the two duties");
    const asOwner = { ck: ck("owner") };
    const read = await call("/control/gateway", asOwner);
    check("a super_admin reads the register", read.status === 200, read.json);
    const rails: any[] = read.json?.rails ?? [];
    check("all five Tanzanian rails are filed", rails.length >= 5, rails.map(r => r.providerKey));
    check("the four rails with no adapter are marked as not adaptable",
      rails.filter(r => !r.adaptable).length >= 4 && rails.find(r => r.providerKey === "azampesa")?.adaptable === true,
      rails.map(r => [r.providerKey, r.adaptable]));
    // The desk's whole view of a rail. Anything that could be a credential has to be absent by
    // name, so the check is the exact list rather than a pattern that a future column could slip
    // past — `hasCredentials` and `credentialHint` are the two deliberate exceptions: a boolean
    // and six characters of the app id.
    const LIST_KEYS = ["adaptable", "adapter", "baseUrl", "config", "credentialHint", "enabled",
      "environment", "hasCredentials", "hasWebhookSecret", "label", "lastCheck", "providerKey",
      "updatedAt"].join(",");
    check("the list hands the desk presence flags and a hint, never a credential",
      Object.keys(rails[0] ?? {}).sort().join(",") === LIST_KEYS, Object.keys(rails[0] ?? {}));
    check("a support engineer reads it", (await call("/control/gateway", { ck: ck("eng") })).status === 200);
    check("a platform analyst reads it", (await call("/control/gateway", { ck: ck("an") })).status === 200);
    const noKey = await call("/control/gateway", { ck: ck("dir") });
    check("a platform seat with neither duty is refused", noKey.status === 403, noKey.json);
    const writeAsReader = await call("/control/gateway/mpesa", {
      ck: ck("eng"), method: "PUT", body: { baseUrl: "https://mpesa.example.tz" }
    });
    check("reading the register does not let you write it",
      writeAsReader.status === 403, writeAsReader.json);

    // ---------------- filing a rail ----------------
    phase("file a rail");
    const badUrl = await call("/control/gateway/azampesa", {
      ck: ck("owner"), method: "PUT",
      body: { baseUrl: "http://pay.example.tz", credentials: { clientId: "a", clientSecret: "b" } }
    });
    check("an http gateway address is refused before it is stored",
      badUrl.status === 400 && badUrl.json?.error?.code === "BAD_BASE_URL", badUrl.json);

    const emptyCreds = await call("/control/gateway/azampesa", {
      ck: ck("owner"), method: "PUT", body: { credentials: {} }
    });
    check("an empty credential set is refused — it would wipe a working key",
      emptyCreds.status === 400, emptyCreds.json);

    const saved = await call("/control/gateway/azampesa", {
      ck: ck("owner"), method: "PUT",
      body: {
        baseUrl: DEAD_URL, environment: "sandbox",
        credentials: { clientId: APP_ID, clientSecret: APP_SECRET },
        webhookSecret: WH_SECRET
      }
    });
    check("the credentials save", saved.status === 200, saved.json);

    const row = await rail("azampesa");
    check("the address the desk typed is the address stored", row?.base_url === DEAD_URL, row?.base_url);
    // A real seal, not an encoding: the bytes must not read as the typed text, and opening them
    // with the field key must give back exactly the set the desk sent. Only the shape is printed —
    // never the plaintext.
    const sealed = row?.credentials_encrypted as Buffer;
    const opened = (() => {
      try { return JSON.parse(decryptField(sealed)); } catch { return null; }
    })();
    check("the credential set is stored sealed, not as text",
      Buffer.isBuffer(sealed) && sealed.length > 28
      && !sealed.toString("latin1").includes(APP_SECRET)
      && opened?.clientId === APP_ID && opened?.clientSecret === APP_SECRET,
      { isBuffer: Buffer.isBuffer(sealed), bytes: sealed?.length, opens: !!opened });
    check("the webhook secret is sealed the same way and never reads back as text",
      Buffer.isBuffer(row?.webhook_secret_encrypted)
      && !row?.webhook_secret_encrypted?.toString("latin1")?.includes(WH_SECRET)
      && decryptField(row.webhook_secret_encrypted) === WH_SECRET,
      { bytes: row?.webhook_secret_encrypted?.length });
    check("the desk is shown a hint and not the key",
      row?.credential_hint === `${APP_ID.slice(0, 6)}***`, row?.credential_hint);
    const reread = await call("/control/gateway", asOwner);
    check("neither secret comes back off the read endpoint",
      !reread.text.includes(APP_SECRET) && !reread.text.includes(WH_SECRET)
      && reread.text.includes(row.credential_hint), reread.text.slice(0, 200));

    const labelOnly = await call("/control/gateway/azampesa", {
      ck: ck("owner"), method: "PUT", body: { label: "AzamPay (smoke)" }
    });
    const afterLabel = await rail("azampesa");
    check("saving a label with the secret blank leaves the secret alone",
      labelOnly.status === 200 && afterLabel?.credentials_encrypted?.toString("hex")
        === row?.credentials_encrypted?.toString("hex"), labelOnly.json);

    // ---------------- press Test ----------------
    //
    // The button the office asked for is the one that answers "is this key right?" before a
    // customer's money is on the line. So it has to work on a rail that is filed but NOT switched
    // on, it has to reach the network rather than pronounce from the database, and whatever it
    // learns has to survive as the line the desk shows tomorrow.
    phase("press test");
    const testAsReader = await call("/control/gateway/azampesa/test", { ck: ck("eng"), body: {} });
    check("reading the register does not let you reach out through it",
      testAsReader.status === 403, testAsReader.json);

    const bareRail = await call("/control/gateway/mpesa/test", { ck: ck("owner"), body: {} });
    check("a rail with no address says so instead of sending nothing in silence",
      bareRail.status === 200 && bareRail.json?.ok === false
      && /no gateway address/i.test(bareRail.json?.detail ?? ""), bareRail.json);

    const unknownKey = await call("/control/gateway/notarail/test", { ck: ck("owner"), body: {} });
    check("a key that is not in the register is answered, not thrown",
      unknownKey.status === 200 && unknownKey.json?.ok === false
      && /not in the register/i.test(unknownKey.json?.detail ?? ""), unknownKey.json);

    const dead = await call("/control/gateway/azampesa/test", { ck: ck("owner"), body: {} });
    check("the filed rail is answered in plain words, not a stack",
      dead.status === 200 && dead.json?.ok === false
      && typeof dead.json?.detail === "string" && dead.json.detail.length > 6, dead.json);
    // `TypeError: fetch failed` is technically an answer and useless to the person at the desk:
    // the reason sits one level down in `cause`, and the thing they can act on is the address they
    // typed. So the verdict has to name the failure, not the promise that rejected.
    check("and the words name what went wrong, not the word `fetch`",
      !/fetch failed/i.test(dead.json?.detail ?? "")
      && /does not resolve|refused|certificate|connection|in time/i.test(dead.json?.detail ?? ""),
      dead.json?.detail);
    check("and nothing was charged — the rail is still switched off",
      (await rail("azampesa"))?.enabled === false);
    const afterTest = await rail("azampesa");
    check("what the network said is kept where the desk can show it",
      afterTest?.last_check?.ok === false
      && afterTest?.last_check?.detail === dead.json?.detail, afterTest?.last_check);

    const noAdapter = await call("/control/gateway/mpesa", {
      ck: ck("owner"), method: "PUT", body: { baseUrl: DEAD_URL }
    });
    const unadapted2 = await call("/control/gateway/mpesa/test", { ck: ck("owner"), body: {} });
    check("a rail with an address but no adapter names that as the reason",
      noAdapter.status === 200 && unadapted2.json?.ok === false
      && /adapter/i.test(unadapted2.json?.detail ?? ""), unadapted2.json);

    // ---------------- the switch ----------------
    phase("the switch");
    const unadapted = await call("/control/gateway/mpesa/enable", {
      ck: ck("owner"), body: { enabled: true }
    });
    check("a rail with no adapter cannot be switched on",
      unadapted.status === 400 && /adapter/i.test(unadapted.json?.error?.message ?? ""),
      unadapted.json);
    check("and it is still off afterwards", (await rail("mpesa"))?.enabled === false);

    const on = await call("/control/gateway/azampesa/enable", {
      ck: ck("owner"), body: { enabled: true }
    });
    check("the filed rail switches on", on.status === 200 && on.json?.enabled === true, on.json);
    check("the register says it is live", (await rail("azampesa"))?.enabled === true);
    const mockShut = await call("/payments/mock/complete", {
      method: "POST", body: { intentReference: "WSH-NOPE-000000", outcome: "approved" }
    });
    check("a live rail shuts the mark-it-paid-without-paying door",
      mockShut.status === 404, mockShut.json);

    // One live rail is a fact of the schema, not a promise: enabling a second names the first.
    await oi(`insert into payment_gateways (provider_key, label, adapter, base_url, environment,
          credentials_encrypted, credential_hint)
        values ($1,$2,'azampay',$3,'sandbox',$4,'synthetic')`,
      [SYNTH, `GW Smoke Synthetic ${STAMP}`, DEAD_URL, row.credentials_encrypted]);
    const second = await call(`/control/gateway/${SYNTH}/enable`, {
      ck: ck("owner"), body: { enabled: true }
    });
    check("the second rail takes over and says which one it displaced",
      second.status === 200 && second.json?.deactivated === "azampesa", second.json);
    check("and exactly one rail is live",
      (await oi("select count(*)::int as n from payment_gateways where enabled")).rows[0].n === 1);

    // ---------------- the charge follows the desk ----------------
    phase("the charge follows the desk");
    bossToken = await mint(uBoss, TC, ["director"]);
    const phone = `+255713${STAMP}`;
    const intent = await call("/payments/intent", {
      token: bossToken,
      body: { planKey: "starter", billingCycle: "monthly", seats: 1, payerPhone: phone },
      headers: { "Idempotency-Key": `${MARK}-intent` }
    });
    check("a live rail that cannot be reached refuses the charge",
      intent.status === 502, { status: intent.status, json: intent.json });
    const charge = (await oi(`select status, provider_txn_id, raw_response, amount
      from payments where tenant_id = $1`, [TC])).rows[0];
    check("and the charge is closed as failed rather than left pending",
      charge?.status === "failed", charge?.status);
    check("the failure reason is recorded where a network answer belongs",
      charge?.raw_response?.push_refused === "GATEWAY_PUSH_REFUSED"
      && typeof charge?.raw_response?.reason === "string", charge?.raw_response);
    check("and the transaction id column stays empty — it is not a place for an error string",
      charge?.provider_txn_id === null, charge?.provider_txn_id);

    // ---------------- the webhook ----------------
    phase("the webhook closes a charge");
    // Switch the platform back onto the rail whose webhook secret this run knows.
    await call(`/control/gateway/${SYNTH}/enable`, { ck: ck("owner"), body: { enabled: false } });
    await call("/control/gateway/azampesa/enable", { ck: ck("owner"), body: { enabled: true } });

    const PENDING_REF = `WSH-${MARK.toUpperCase()}-PEND`;
    await oi(`insert into payments (tenant_id, provider, intent_reference, amount, currency,
          status, idempotency_key)
        values ($1,'azampesa',$2,25000,'TZS','pending',$3)`,
      [TC, PENDING_REF, `${MARK}-planted`]);

    const body = (nonce: string, outcome = "approved", ref = PENDING_REF) =>
      JSON.stringify({ reference: ref, outcome, nonce, event: "charge.settled" });
    const sign = (raw: string) =>
      "sha256=" + createHmac("sha256", WH_SECRET).update(raw).digest("hex");

    const ledgerWindow = async () => (await oi(
      "select count(*)::int as n from payment_webhooks where created_at >= $1",
      [new Date(START)])).rows[0].n;

    check("a call with no signature at all completes nothing",
      (await call("/payments/webhook", {
        raw: body(`${MARK}-nosig`), headers: { "x-waisha-signature": "sha256=" + "0".repeat(64) }
      })).status === 401);
    check("but it is written to the ledger as a rejected delivery",
      (await oi(`select signature_valid, processing_error from payment_webhooks
                  where created_at >= $1 and replay_nonce is null
                  order by created_at desc limit 1`, [new Date(START)])).rows[0]?.processing_error
      === "signature rejected");
    check("the payment is still pending after the forged call",
      (await oi("select status from payments where intent_reference = $1", [PENDING_REF]))
        .rows[0]?.status === "pending");

    const junk = await call("/payments/webhook", { raw: "{}", headers: { "x-waisha-signature": sign("{}") } });
    check("a body that does not describe an outcome is refused", junk.status === 400, junk.json);

    const good = await call("/payments/webhook", {
      raw: body(`${MARK}-n1`), headers: { "x-waisha-signature": sign(body(`${MARK}-n1`)) }
    });
    check("a correctly signed call closes the charge",
      good.status === 200 && good.json?.result?.payment_status === "approved", good.json);
    const paid = (await oi(`select p.status, t.status as tenant_status, t.licence_expires_at
      from payments p join tenants t on t.id = p.tenant_id where p.intent_reference = $1`,
      [PENDING_REF])).rows[0];
    check("the payment row is approved", paid?.status === "approved", paid?.status);
    check("and the licence it pays for actually opened",
      paid?.tenant_status === "active" && new Date(paid.licence_expires_at) > new Date(), paid);
    check("the approval is auditable",
      (await oi(`select count(*)::int as n from audit_logs where action = 'payment.approved.webhook'
                  and tenant_id = $1`, [TC])).rows[0].n === 1);

    const replay = await call("/payments/webhook", {
      raw: body(`${MARK}-n1`), headers: { "x-waisha-signature": sign(body(`${MARK}-n1`)) }
    });
    check("the same delivery twice is acknowledged, not re-run",
      replay.status === 200 && replay.json?.status === "duplicate", replay.json);
    check("and the ledger holds one row for that nonce",
      (await oi("select count(*)::int as n from payment_webhooks where replay_nonce = $1",
        [`${MARK}-n1`])).rows[0].n === 1);

    const late = await call("/payments/webhook", {
      raw: body(`${MARK}-n2`, "failed"), headers: { "x-waisha-signature": sign(body(`${MARK}-n2`, "failed")) }
    });
    check("a second delivery of a different kind cannot reopen a settled charge",
      late.json?.result?.status === "already_final", late.json);

    const huge = await call("/payments/webhook", {
      raw: JSON.stringify({ reference: `${MARK}-big`, blob: "x".repeat(70 * 1024) })
    });
    check("a payload over the cap is refused before it is parsed", huge.status === 413, huge.status);

    // ---------------- nothing live, nothing listening ----------------
    phase("switching off");
    const off = await call("/control/gateway/azampesa/enable", {
      ck: ck("owner"), body: { enabled: false }
    });
    check("the rail switches off again", off.status === 200 && off.json?.enabled === false, off.json);
    const deaf = await call("/payments/webhook", {
      raw: body(`${MARK}-n3`), headers: { "x-waisha-signature": sign(body(`${MARK}-n3`)) }
    });
    check("with nothing live the door does not answer at all", deaf.status === 404, deaf.json);

    const cleared = await call("/control/gateway/azampesa", { ck: ck("owner"), method: "DELETE" });
    const afterClear = await rail("azampesa");
    check("clearing a rail removes every secret and leaves the row",
      cleared.status === 200 && afterClear?.credentials_encrypted === null
      && afterClear?.webhook_secret_encrypted === null && afterClear?.base_url === null
      && !!afterClear?.provider_key, { status: cleared.status, row: !!afterClear });
    // The dialog promises "every credential and the switch", and a kept verdict would then sit on
    // the card naming an address the row no longer has — so the check goes with what it described.
    check("and a cleared rail stops reporting the check it failed against a gone address",
      afterClear?.last_check === null, afterClear?.last_check);

    // ---------------- the desk's own audit trail ----------------
    phase("the audit trail");
    const acts = (await oi(`select action, count(*)::int as n from audit_logs
      where tenant_id = $1 and entity = 'payment_gateways' group by action`, [TP])).rows;
    const have = Object.fromEntries(acts.map((a: any) => [a.action, a.n]));
    check("every write at the desk left its named line",
      have["gateway.configured"] >= 3 && have["gateway.activated"] >= 2
      && have["gateway.deactivated"] >= 1 && have["gateway.cleared"] === 1
      && have["gateway.tested"] >= 4, have);
    const leaky = (await oi(`select count(*)::int as n from audit_logs where tenant_id = $1
      and entity = 'payment_gateways'
      and (after::text like '%${APP_SECRET}%' or after::text like '%${WH_SECRET}%')`, [TP])).rows[0].n;
    check("and no audit line carries a secret", leaky === 0, leaky);

    // Four verdicts were handed out in front of the ledger: a rejected signature, a body that
    // described no outcome, the approved delivery, and the late one that arrived after the charge
    // had settled. The duplicate in between is deliberately not a fifth line.
    check("the ledger only grew by this run's deliveries",
      (await ledgerWindow()) >= 4, await ledgerWindow());
  } finally {
    await sweep();
    const left = (await oi(`select count(*)::int as n from payment_gateways
      where provider_key = $1`, [SYNTH])).rows[0].n;
    const liveNow = (await oi("select count(*)::int as n from payment_gateways where enabled")).rows[0].n;
    const now = (await oi(`select ${RAIL_COLS} from payment_gateways`)).rows;
    check("the register is back to what this run found",
      left === 0 && liveNow === before.filter((r: any) => r.enabled).length
      && now.every((r: any) => {
        const o: any = before.find((b: any) => b.provider_key === r.provider_key);
        return o && r.enabled === o.enabled
          && String(r.credentials_encrypted) === String(o.credentials_encrypted)
          && r.base_url === o.base_url && r.label === o.label;
      }), { left, liveNow });
    check("the ledger is back to its old size",
      (await oi("select count(*)::int as n from payment_webhooks")).rows[0].n === ledgerBefore);
    await owner.end();
  }

  console.log(`\n${failures ? "FAILURES: " + failures : "all checks passed"} — marker ${MARK}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
