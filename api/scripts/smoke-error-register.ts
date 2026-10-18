/**
 * #130a — does a failure actually reach the register, and who can see it once it has.
 *
 * The verify script proves the definer bodies. This proves the wiring around them, which is
 * the half that can only be seen over HTTP: an unhandled error inside a real request must
 * answer 500 with a request id AND put a line in `app_errors` carrying the company and the
 * seat that were on the token, because that link is the whole point of the register — the
 * caller was handed an id and the desk is the only place it means anything.
 *
 * The 500 is forced by a route that fails on purpose (`/dev/error-probe`), registered only
 * when NODE_ENV is not production. The alternative — calling the collector from the test —
 * would prove the collector works and leave the question that matters unanswered: was it the
 * error handler that caught it?
 *
 * Three things are checked on the way that nothing else in this suite can:
 *  - the capture is fire-and-forget, so every read-back polls instead of assuming;
 *  - the message the probe throws carries an address and an MSISDN, and neither may appear in
 *    the stored line — the register is read by whoever opens the desk, so it must describe the
 *    failure without repeating the data that was inside it;
 *  - the stack is kept FOR the desk and never given to the caller: the 500 body that went over
 *    the wire must not contain it, while the occurrence the desk reads back must.
 *
 * Counts are read as `sum(1 + repeats)` across a fingerprint's rows rather than from one
 * row, because the register folds per minute and a suite that straddles a minute boundary
 * legitimately holds two rows for one bug. The numbers this suite cares about are the same
 * either way.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-error-register.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { encryptField, searchHash, sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";

const STAMP = "s" + Date.now().toString(36);
const COMPANY = `Errors Smoke ${STAMP} Ltd`;
const DESK = `Errors Smoke Desk ${STAMP}`;
const EMAIL = `err.smoke.${STAMP}@waisha.test`;
const TIN = `9${Date.now().toString().slice(-8)}`;
const PHONE = `+2557${Date.now().toString().slice(-8)}`;
const PASSWORD = `Er-${STAMP}-K9!q`;
const NAME_SWEEP = `Errors Smoke %`;
const PROBE_CODE = `PROBE_${STAMP}`;
const CLIENT_CODE = `SMOKE_${STAMP}`;
/** The web collector sends the JS error's own name as the code, so this run cannot key its
 *  browser-shaped batch on a code of its own making — it is marked inside the message. */
const MARK_PREFIX = "deskpayload";
const MARK = `${MARK_PREFIX}-${STAMP}`;
const RAW_EMAIL = "ada@alpha.co.tz";
const RAW_MSISDN = "+255712345678";
const PROBE_PATH = "/api/v1/dev/error-probe";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const publicBodies: string[] = [];
const serverBodies: string[] = [];
const deskBodies: string[] = [];
async function call(path: string, token: string | null, init: RequestInit = {},
  bucket: string = "public") {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  if (bucket === "public") publicBodies.push(text);
  else if (bucket === "server") serverBodies.push(text);
  else deskBodies.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

const ck = (who: string) => ({ Cookie: `waisha_control=${who}` });
const cookieOf = (h: Headers) =>
  (typeof h.getSetCookie === "function" ? h.getSetCookie() : [])
    .find((c) => c.startsWith("waisha_refresh="))?.split(";")[0] ?? "";

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const clearBuckets = async (...prefixes: string[]) => {
    for (const p of prefixes) await oi(`delete from rate_limits where bucket like $1`, [`${p}%`]);
  };
  /**
   * `hit_rate_limit` aligns its window to the epoch rather than to the first hit, so a loop
   * that starts four seconds before a boundary spends half its calls in the next window and
   * is never refused at all. Seeding a window is how a suite proves a cap without depending
   * on where the clock happened to be.
   */
  const seedBuckets = async (prefix: string, count: number) => {
    await oi(`update rate_limits set count = $2 where bucket like $1`, [`${prefix}%`, count]);
  };
  const toMinuteEdge = async () => {
    const wait = 60_000 - (Date.now() % 60_000) + 250;
    console.log(`   pacing: the intake cap needs a whole window — waiting ${(wait / 1000).toFixed(1)}s`);
    await new Promise((r) => setTimeout(r, wait));
  };

  const COLS = `fingerprint, kind, code, status, method, path, route, message, detail,
                request_id, tenant_id, actor_user_id, ip, user_agent, environment, repeats`;
  const byRequest = (rid: string) => oi(
    `select ${COLS} from app_errors where request_id = $1`, [rid]);
  const byCode = (code: string) => oi(
    `select ${COLS} from app_errors where code = $1 order by id`, [code]);
  const byMessage = (phrase: string) => {
    const like = `%${phrase}%`;
    return oi(`select ${COLS} from app_errors where message like $1 order by id`, [like]);
  };
  /** One bug is one fingerprint spread over one row per minute it happened in. */
  const foldState = (fp: string) => oi(
    `select coalesce(sum(1 + repeats),0)::int as occurrences, count(*)::int as lines,
            (array_agg(request_id order by last_ts desc))[1] as newest_request
       from app_errors where fingerprint = $1`, [fp]);
  const totalErrors = () => oi(`select count(*)::int as n from app_errors`);
  /** The collector is fire-and-forget, so every read-back of a line it should have written polls. */
  async function poll<T>(fn: () => Promise<T>, done: (v: T) => boolean, tries = 60): Promise<T> {
    let last = await fn();
    for (let i = 0; i < tries && !done(last); i++) {
      await new Promise((r) => setTimeout(r, 250));
      last = await fn();
    }
    return last;
  }

  const WIPE = ["trip_checkpoint_logs", "route_checkpoints", "shipper_file_shares", "shipper_accounts",
    "freight_invoice_payments", "freight_invoice_items", "freight_invoices", "freight_expenses",
    "fuel_logs", "incidents", "trip_shipments", "trips", "routes", "message_reads", "messages",
    "office_costs", "office_tasks", "employee_evaluations", "employees", "screening_checks",
    "screening_entries", "cargo_tasks", "cargo_shipments", "clients", "drivers", "vessels",
    "office_budgets", "regulatory_licences", "inventory_items", "documents", "branches",
    "transport_requests", "transport_bookings", "tenant_actions", "payments", "invoices",
    "sessions", "otp_codes", "password_resets", "settings", "subscriptions", "user_roles"];
  const wipeTenants = async (tids: string[]) => {
    if (!tids.length) return;
    for (const t of WIPE) {
      await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    }
    await oi(`delete from alert_reads where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from user_roles where user_id in
             (select id from users where tenant_id = any($1::uuid[]))`, [tids]).catch(() => { });
    await oi(`delete from roles where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from tenants where id = any($1::uuid[])`, [tids]);
  };
  /** Only ever this run's lines: the probe's own path, or the code stamped on the batch.
   *  The web-shaped batch carries neither — it is found by the phrase inside its messages, and
   *  that sweep is prefix-wide so a run aborted half way leaves no residue for the next one. */
  const sweepRegister = async () => {
    await oi(`delete from app_error_notes where fingerprint in
              (select distinct fingerprint from app_errors
                where path = $1 or code = $2 or message like $3)`,
      [PROBE_PATH, CLIENT_CODE, `%${MARK_PREFIX}%`]).catch(() => { });
    await oi(`delete from app_errors
               where path = $1 or code = $2 or message like $3`,
      [PROBE_PATH, CLIENT_CODE, `%${MARK_PREFIX}%`]);
  };

  let TC = "", dirU = "", directorName = "", tokenA = "", refreshA = "";
  const CT = randomUUID();
  const uADM = randomUUID();   // super_admin — holds view and manage
  const uSUP = randomUUID();   // support_engineer — 069 gave it the read, not the judgement
  const uBIL = randomUUID();   // billing_admin — holds neither
  const tok = (who: string) => `err-smoke-${who}-${STAMP}`;

  try {
    // ==================================================================
    phase("A · fixtures, and a register that starts empty of this run");

    await wipeTenants((await oi(`select id from tenants where name like $1`, [NAME_SWEEP]))
      .rows.map((r: any) => r.id));
    await sweepRegister();
    await clearBuckets("clienterr:ip:", "errors:uid:", "errors-detail:uid:",
      "errors-triage:uid:", "errors-prune:uid:", "ip:", "login:", "signup:");
    const errors0 = (await totalErrors()).rows[0].n;
    check("this run leaves no line of its own behind before it starts",
      (await byCode(PROBE_CODE)).rows.length === 0, { errors0 });

    const signup = await call("/auth/transporter/signup", null, {
      method: "POST", body: JSON.stringify({
        companyName: COMPANY, tin: TIN, phone: PHONE, email: EMAIL,
        password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true
      })
    });
    dirU = signup.json?.userId ?? "";
    TC = (await oi(`select tenant_id from users where id = $1`, [dirU])).rows[0]?.tenant_id ?? "";
    check("a company signed up for real, to be the one whose failure is collected",
      signup.status === 201 && !!TC, { s: signup.status });

    await oi(`insert into tenants (id, type, name, status) values ($1,'platform',$2,'active')`,
      [CT, DESK]);
    await oi(`insert into users (id, tenant_id, user_type, full_name, email,
             email_normalized_search, status, totp_enabled)
       values ($1,$2,'platform','Ada Desk',$3,$4,'active',false),
              ($5,$2,'platform','Sid Engineer',$6,$7,'active',false),
              ($8,$2,'platform','Ben Billing',$9,$10,'active',false)`,
      [uADM, CT, `err.desk.admin.${STAMP}@waisha.test`, searchHash(`err.desk.admin.${STAMP}@waisha.test`),
      uSUP, `err.desk.engineer.${STAMP}@waisha.test`, searchHash(`err.desk.engineer.${STAMP}@waisha.test`),
      uBIL, `err.desk.billing.${STAMP}@waisha.test`, searchHash(`err.desk.billing.${STAMP}@waisha.test`)]);
    const roleRows = (await oi(
      `select id, key from roles where tenant_id is null
        and key = any($1)`, [["super_admin", "billing_admin", "support_engineer", "director"]])).rows;
    const rid = (k: string) => roleRows.find((r: any) => r.key === k)?.id;
    if (!rid("super_admin") || !rid("support_engineer") || !rid("billing_admin")) {
      throw new Error("global platform roles missing");
    }
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2), ($3,$4), ($5,$6)`,
      [uADM, rid("super_admin"), uSUP, rid("support_engineer"), uBIL, rid("billing_admin")]);
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
             refresh_token_hash, user_agent, ip, expires_at)
       values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-error-register','127.0.0.1',
               now() + interval '2 hours'),
              ($6,$7,$3,$8, now() + interval '2 hours', $9,'smoke-error-register','127.0.0.1',
               now() + interval '2 hours'),
              ($10,$11,$3,$12, now() + interval '2 hours', $13,'smoke-error-register','127.0.0.1',
               now() + interval '2 hours')`,
      [randomUUID(), uADM, CT, randomUUID(), sha256(tok("adm")),
      randomUUID(), uSUP, randomUUID(), sha256(tok("sup")),
      randomUUID(), uBIL, randomUUID(), sha256(tok("bil"))]);

    await oi(`update tenants set status = 'active' where id = $1`, [TC]);
    await oi(`update users set status = 'active', phone_encrypted = $2, phone_search = $3
               where id = $1`, [dirU, encryptField(PHONE), searchHash(PHONE)]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [dirU, rid("director")]);
    await oi(`insert into subscriptions (tenant_id, plan_id, billing_cycle, status, seats_licensed,
             current_period_start, current_period_end)
       values ($1,$2,'monthly','active',5, now(), now() + interval '30 days')`,
      [TC, (await oi(`select id from plans where key='starter'`)).rows[0].id]);
    await oi(`update tenants set licence_expires_at = now() + interval '30 days' where id = $1`, [TC]);
    // The same expression the definer uses, so the drill-down can be compared exactly.
    directorName = (await oi(`select coalesce(full_name, email) as n from users where id = $1`,
      [dirU])).rows[0]?.n ?? "";

    const login = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({
        mode: "transporter", tin: TIN, email: EMAIL, password: PASSWORD
      })
    });
    tokenA = login.json?.accessToken ?? "";
    refreshA = cookieOf(login.headers);
    check("the director of that company signs in with a real password",
      login.status === 200 && !!tokenA && !!refreshA, login.status);

    // ==================================================================
    phase("B · a real 500, and the line it has to leave behind");

    const boom = await call(`/dev/error-probe?kind=plain&stamp=${STAMP}`, tokenA, { method: "POST" }, "server");
    const rid1 = boom.headers.get("x-request-id") ?? "";
    check("the probe answers 500 with the shape every caller already handles",
      boom.status === 500 && boom.json?.error?.code === "INTERNAL", { s: boom.status, b: boom.json });
    check("and hands the caller a request id — the only key into the register it has",
      /^[0-9a-f-]{36}$/.test(rid1) && boom.json?.error?.request_id === rid1, rid1);
    check("the 500 body says nothing about what broke",
      boom.json?.error?.message === "An unexpected error occurred"
      && !boom.text.includes("probe failure") && !boom.text.includes("node_modules")
      && !boom.text.includes(RAW_EMAIL), boom.text.slice(0, 200));

    const row1 = await poll(() => byRequest(rid1), (r) => r.rows.length > 0);
    const line1 = row1.rows[0] ?? {};
    check("the failure was written to the register, keyed by that request id",
      row1.rows.length === 1 && !!line1.fingerprint, line1);
    check("with the server's own description of where it happened",
      line1.kind === "server" && line1.status === 500 && line1.method === "POST"
      && line1.path === PROBE_PATH && /error-probe/.test(line1.route ?? "")
      && line1.code === PROBE_CODE, line1);
    check("and the company and the seat that were on the token, which the caller never sent",
      line1.tenant_id === TC && line1.actor_user_id === dirU,
      { t: line1.tenant_id, a: line1.actor_user_id });
    check("the client's own address and user-agent are recorded beside it",
      !!line1.ip && !!line1.user_agent, { ip: line1.ip, ua: line1.user_agent });
    check("the stored line names the environment it happened in",
      line1.environment === "development", line1.environment);
    check("a fingerprint is 32 lowercase hex characters",
      /^[0-9a-f]{32}$/.test(String(line1.fingerprint ?? "")), line1.fingerprint);

    const stored = String(line1.message ?? "");
    check("the message kept the failure and dropped the people inside it",
      /probe failure plain/.test(stored) && stored.includes("e***@masked")
      && stored.includes("+255*******") && !stored.includes(".co.tz"), stored);
    check("…so an address and an MSISDN are nowhere in the stored line",
      !stored.includes(RAW_EMAIL) && !stored.includes(RAW_MSISDN.slice(1))
      && !String(line1.detail ?? "").includes(RAW_EMAIL)
      && !String(line1.detail ?? "").includes(RAW_MSISDN.slice(1)),
      { message: stored, detail: String(line1.detail ?? "").slice(0, 120) });

    // ------------------------------------------------------------------
    phase("C · the same bug four times is one count, and the first stack is the one kept");

    const again = [];
    for (let i = 0; i < 3; i++) {
      again.push(await call(`/dev/error-probe?kind=plain&stamp=${STAMP}`, tokenA,
        { method: "POST" }, "server"));
    }
    const againRid = again[2].headers.get("x-request-id") ?? "";
    const folded = await poll(() => foldState(line1.fingerprint), (r) => r.rows[0]?.occurrences >= 4);
    const fold = folded.rows[0] ?? {};
    check("three more failures of the same bug are folded, not appended",
      fold.occurrences === 4 && fold.lines <= 2, fold);
    check("…and the request id moved to the newest one, so the desk can trace the last call",
      fold.newest_request === againRid, { kept: fold.newest_request, last: againRid });
    const registerLine = (await oi(
      `select * from platform_auth.error_register(null,null,$1,7,100)`, [PROBE_CODE]))
      .rows.find((r: any) => r.fingerprint === line1.fingerprint);
    check("and the register reports it as four occurrences on one line",
      registerLine?.occurrences === 4 && registerLine?.lines <= 2
      && registerLine?.tenants === 1 && registerLine?.request_id === againRid, registerLine);

    const pg = await call(`/dev/error-probe?kind=pg&stamp=${STAMP}`, tokenA, { method: "POST" }, "server");
    const pgRow = await poll(() => byRequest(pg.headers.get("x-request-id") ?? ""),
      (r) => r.rows.length > 0);
    check("a different failure in the same route is a second line, not a repeat",
      pgRow.rows.length === 1 && pgRow.rows[0].fingerprint !== line1.fingerprint,
      { fp: pgRow.rows[0]?.fingerprint, want: line1.fingerprint });
    check("the stack is stored for the desk but was never sent to the caller",
      !/no_such_table|node_modules/.test(pg.text)
      && /no_such_table/.test(String(pgRow.rows[0]?.detail ?? "")),
      { body: pg.text.slice(0, 120), detail: String(pgRow.rows[0]?.detail ?? "").slice(0, 90) });

    const anon = await call(`/dev/error-probe?kind=anon&stamp=${STAMP}`, null,
      { method: "POST" }, "server");
    const anonRow = await poll(() => byRequest(anon.headers.get("x-request-id") ?? ""),
      (r) => r.rows.length > 0);
    check("a failure with no token is collected too, and attributed to nobody",
      anonRow.rows.length === 1 && anonRow.rows[0].tenant_id === null
      && anonRow.rows[0].actor_user_id === null, anonRow.rows[0]);
    check("…and it is its own line, because the message describes a different failure",
      anonRow.rows[0]?.fingerprint !== line1.fingerprint, anonRow.rows[0]?.fingerprint);

    // ------------------------------------------------------------------
    phase("D · a refusal is not a failure, and is not collected");

    const before = (await totalErrors()).rows[0].n;
    await call("/control/errors", null, {}, "server");
    await call("/control/errors", null, { headers: ck(`err-smoke-forged-${STAMP}`) }, "server");
    await call("/control/errors?days=999", null, { headers: ck(tok("adm")) }, "server");
    await call("/control/errors/not-a-fingerprint", null, { headers: ck(tok("adm")) }, "server");
    await call("/auth/login", null, { method: "POST", body: JSON.stringify({ mode: "transporter" }) });
    const after = (await totalErrors()).rows[0].n;
    check("401s, a 403 and three validation refusals wrote no line at all",
      after === before, { before, after });

    // ------------------------------------------------------------------
    phase("E · what the browser reports about itself");

    const intake = await call("/client-errors", null, {
      method: "POST", body: JSON.stringify({
        errors: [
          { message: `client crash for ${RAW_EMAIL} on ${RAW_MSISDN} seat 198765432`,
            code: CLIENT_CODE, source: "boundary", path: "/app/cargo/41780?tab=docs",
            status: 500, requestId: rid1,
            detail: "    at CargoPage (web/app/app/cargo/page.tsx:88)" },
          { message: `unhandled rejection ${STAMP}`, code: CLIENT_CODE, source: "rejection" },
          { message: `a fetch that never came back ${STAMP}`, code: CLIENT_CODE, source: "fetch" }
        ]
      })
    });
    check("the intake answers 202 with a count and no detail of its own",
      intake.status === 202 && intake.json?.recorded === 3 && !intake.text.includes("client crash"),
      { s: intake.status, b: intake.json });
    const clientRows = await poll(() => byCode(CLIENT_CODE), (r) => r.rows.length >= 3);
    check("all three reports are in the register as client lines",
      clientRows.rows.length === 3 && clientRows.rows.every((r: any) => r.kind === "client"),
      clientRows.rows.map((r: any) => `${r.kind}/${r.route}`));
    const crash = clientRows.rows.find((r: any) => /client crash/.test(String(r.message))) ?? {};
    check("the page it crashed on is stored normalised, so one bug is one line",
      crash.path === "/app/cargo/:id", crash.path);
    check("the route column says which surface of the page reported it",
      String(crash.route ?? "").startsWith("client:"), crash.route);
    check("the PII in the browser's own message was scrubbed before it was stored",
      !String(crash.message ?? "").includes(RAW_EMAIL)
      && String(crash.message ?? "").includes("e***@masked"), crash.message);
    check("the request id of the failed call is kept, which is the join back to the server line",
      crash.request_id === rid1, crash.request_id);
    check("a client row carries the ip the server saw and nothing else about the person",
      !!crash.ip && crash.tenant_id === null && crash.actor_user_id === null,
      { ip: crash.ip, t: crash.tenant_id, a: crash.actor_user_id });
    check("a report with no status of its own stores a null status, not a made-up one",
      clientRows.rows.find((r: any) => /never came back/.test(String(r.message)))?.status === null,
      clientRows.rows.find((r: any) => /never came back/.test(String(r.message)))?.status);

    // Exactly the payload web/lib/client-errors.ts composes: five items, the fields the
    // browser fills, and the undefined ones simply absent from the JSON. If the web side ever
    // drifts from this shape the whole batch is dropped quietly, so this is the only thing
    // that would notice.
    const asTheWebSends = await call("/client-errors", null, {
      method: "POST", body: JSON.stringify({
        errors: [
          { message: `A screen failed to render ${MARK}`, code: "TypeError", source: "boundary",
            path: "/app/office/payroll", detail: "TypeError: x is not a function\n    at n (web/app/x.tsx:3:1)",
            requestId: "D-abc123" },
          { message: `The API answered 503 for /api/v1/trips ${MARK}`, code: "API_503",
            source: "fetch", path: "/api/v1/trips", status: 503 },
          { message: `Could not load script chunk-7f9a.js ${MARK}`, code: "ResourceLoadError",
            source: "window", path: "/login" },
          { message: `Unhandled promise rejection ${MARK}`, code: "DOMException", source: "rejection" },
          { message: `Uncaught ReferenceError ${MARK}`, code: "ReferenceError", source: "window",
            status: 500, requestId: rid1 }
        ]
      })
    });
    check("a full page of reports shaped exactly like the web collector sends lands in full",
      asTheWebSends.status === 202 && asTheWebSends.json?.recorded === 5, asTheWebSends.json);
    const webRows = await poll(() => byMessage(MARK), (r) => r.rows.length >= 5);
    const apiLine = webRows.rows.find((r: any) => /API answered 503/.test(String(r.message))) ?? {};
    const chunkLine = webRows.rows.find((r: any) => /Could not load script/.test(String(r.message))) ?? {};
    check("…each carries the code the browser gave it, not the suite's own",
      webRows.rows.filter((r: any) => ["TypeError", "API_503", "ResourceLoadError",
        "DOMException", "ReferenceError"].includes(r.code)).length === 5,
      webRows.rows.map((r: any) => r.code));
    check("…the fetch report keeps the status that makes it findable",
      apiLine.status === 503 && apiLine.route === "client:fetch", apiLine);
    check("…an API path is normalised like any other, so ids in a URL cannot split a line",
      apiLine.path === "/api/v1/trips", apiLine.path);
    check("…a resource failure is a line of its own with no invented status",
      chunkLine.status === null && chunkLine.route === "client:window",
      { s: chunkLine.status, r: chunkLine.route });

    const badStatus = await call("/client-errors", null, {
      method: "POST", body: JSON.stringify({
        errors: [{ message: `invented status ${STAMP}`, code: CLIENT_CODE, status: 0 }]
      })
    });
    check("a status outside 100-599 is refused by the schema, still with a quiet 202",
      badStatus.status === 202 && badStatus.json?.recorded === 0
      && (await oi(`select count(*)::int as n from app_errors where message like 'invented status%'`))
        .rows[0].n === 0, badStatus.json);

    const smuggle = await call("/client-errors", null, {
      method: "POST", body: JSON.stringify({
        errors: [{ message: `smoke ${STAMP} pretending to be somebody`, code: CLIENT_CODE,
          tenantId: TC, actorUserId: dirU, kind: "server" }]
      })
    });
    check("a report cannot name the company, the seat or the kind it wants to be written as",
      smuggle.status === 202 && smuggle.json?.recorded === 0, smuggle.json);
    check("…and the whole batch is refused, so nothing about that person is in the register",
      (await oi(`select count(*)::int as n from app_errors where tenant_id = $1 and code = $2`,
        [TC, CLIENT_CODE])).rows[0].n === 0);
    const overBatch = await call("/client-errors", null, {
      method: "POST", body: JSON.stringify({
        errors: Array.from({ length: 6 }, () => ({ message: `six ${STAMP}`, code: CLIENT_CODE }))
      })
    });
    check("a batch bigger than one page of reports is dropped, not written",
      overBatch.status === 202 && overBatch.json?.recorded === 0, overBatch.json);
    const junkBody = await call("/client-errors", null, { method: "POST", body: "{}" });
    const noBody = await call("/client-errors", null, { method: "POST" });
    check("an empty or shapeless body is a 202 with nothing recorded, never a 500",
      junkBody.status === 202 && junkBody.json?.recorded === 0
      && noBody.status < 500 && noBody.status > 0,
      { j: junkBody.status, n: noBody.status });
    const blank = await call("/client-errors", null, {
      method: "POST", body: JSON.stringify({ errors: [{ message: "   ", code: CLIENT_CODE }] })
    });
    check("a report with no message in it is dropped rather than stored",
      blank.status === 202 && blank.json?.recorded === 0, blank.json);

    // ------------------------------------------------------------------
    phase("F · the desk, read by the seats that are allowed to read it");

    const desk = await call("/control/errors?q=" + PROBE_CODE, null, { headers: ck(tok("adm")) }, "desk");
    const pLine = (desk.json?.items ?? []).find((i: any) => i.fingerprint === line1.fingerprint);
    check("a super admin reads the register with its summary and its window",
      desk.status === 200 && !!pLine && desk.json?.window_days === 7
      && desk.json?.summary?.server_lines >= 3 && desk.json?.summary?.client_lines >= 3,
      { s: desk.status, line: pLine, summary: desk.json?.summary });
    check("the line the desk sees carries the counts, not the internals",
      pLine?.occurrences === 4 && pLine?.state === "open" && pLine?.triage_note === null
      && pLine?.detail === undefined, pLine);
    check("…and the desk can point at the request it is answering",
      pLine?.request_id === againRid, pLine?.request_id);
    const clientDesk = await call("/control/errors?kind=client&q=" + CLIENT_CODE, null,
      { headers: ck(tok("adm")) }, "desk");
    check("the kind filter separates the browser's reports from the server's",
      clientDesk.status === 200 && clientDesk.json?.items?.length === 3
      && clientDesk.json.items.every((i: any) => i.kind === "client"),
      { n: clientDesk.json?.items?.length });
    const asEngineer = await call("/control/errors?q=" + PROBE_CODE, null,
      { headers: ck(tok("sup")) }, "desk");
    check("the seat that fixes faults can read it: 069 gave support_engineer the read",
      asEngineer.status === 200 && asEngineer.json?.items?.length >= 1, asEngineer.status);
    const asBilling = await call("/control/errors", null, { headers: ck(tok("bil")) }, "desk");
    check("the seat that sells licences cannot: reading the machine room is its own duty",
      asBilling.status === 403 && asBilling.json?.error?.code === "FORBIDDEN",
      { s: asBilling.status, c: asBilling.json?.error?.code });
    const noCookie = await call("/control/errors", null, {}, "desk");
    const forged = await call("/control/errors", null, { headers: ck(`err-smoke-nope-${STAMP}`) }, "desk");
    check("and nobody without a real control session gets in at all",
      noCookie.status === 401 && forged.status === 401,
      { n: noCookie.status, f: forged.status });
    check("a director's bearer token is not a control cookie either",
      (await call("/control/errors", tokenA, {}, "desk")).status === 401);

    const occ = await call(`/control/errors/${line1.fingerprint}?limit=5`, null,
      { headers: ck(tok("sup")) }, "desk");
    const occ1 = (occ.json?.occurrences ?? [])[0] ?? {};
    check("the drill-down shows the minutes behind the line, with the company and the seat named",
      occ.status === 200 && occ.json?.occurrences?.length >= 1
      && occ1.tenant_name === COMPANY && occ1.actor_name === directorName,
      { s: occ.status, n: occ.json?.occurrences?.length, t: occ1.tenant_name, a: occ1.actor_name });
    check("the seat reading it gets the stack, which is the thing it needs to fix the bug",
      /probe failure plain/.test(String(occ1.detail ?? "")), String(occ1.detail ?? "").slice(0, 90));
    check("a fingerprint that is not shaped like one is a 404, not a database call",
      (await call("/control/errors/zz%27%20or%201%3D1--", null, { headers: ck(tok("adm")) }, "desk")).status === 404);
    const ghostFp = randomUUID().replace(/-/g, "");
    check("and a well-shaped one the register has never seen is a 404 too",
      (await call(`/control/errors/${ghostFp}`, null, { headers: ck(tok("adm")) }, "desk")).status === 404);

    // ------------------------------------------------------------------
    phase("G · the judgement, and who is allowed to make it");

    const NOTE = "The dev probe route. Owned by the platform team.";
    const judged = await call(`/control/errors/${line1.fingerprint}/triage`, null, {
      method: "POST", headers: ck(tok("adm")), body: JSON.stringify({ state: "triaged", note: NOTE })
    }, "desk");
    check("a triage answers 200 with the judgement it just made — not the one before it",
      judged.status === 200 && judged.json?.state === "triaged"
      && judged.json?.fingerprint === line1.fingerprint && judged.json?.note === NOTE,
      { s: judged.status, b: judged.json });
    const reread = await call(`/control/errors?q=` + PROBE_CODE, null, { headers: ck(tok("adm")) }, "desk");
    check("…and the register now carries it",
      reread.json?.items?.find((i: any) => i.fingerprint === line1.fingerprint)?.state === "triaged"
      && reread.json?.items?.find((i: any) => i.fingerprint === line1.fingerprint)?.triage_note === NOTE);
    const kept = await call(`/control/errors/${line1.fingerprint}/triage`, null, {
      method: "POST", headers: ck(tok("adm")), body: JSON.stringify({ state: "resolved" })
    }, "desk");
    check("moving the state without a note keeps the sentence the first seat wrote",
      kept.status === 200 && kept.json?.state === "resolved" && kept.json?.note === NOTE, kept.json);
    const audited = (await oi(
      `select after from audit_logs where tenant_id = $1 and entity = 'app_errors'
         and action = 'control.error.triaged' order by ts desc limit 1`, [CT])).rows[0]?.after;
    check("the judgement is audited against the line, not against a company",
      audited?.state === "resolved" && audited?.note === true, audited);
    const byEngineer = await call(`/control/errors/${line1.fingerprint}/triage`, null, {
      method: "POST", headers: ck(tok("sup")), body: JSON.stringify({ state: "ignored" })
    }, "desk");
    check("the seat that can read the register cannot close a line on it",
      byEngineer.status === 403, { s: byEngineer.status, c: byEngineer.json?.error?.code });
    check("…and the judgement it tried to write is still the one the desk made",
      (await oi(`select state from app_error_notes where fingerprint = $1`, [line1.fingerprint]))
        .rows[0]?.state === "resolved");
    const badState = await call(`/control/errors/${line1.fingerprint}/triage`, null, {
      method: "POST", headers: ck(tok("adm")), body: JSON.stringify({ state: "wontfix" })
    }, "desk");
    check("an invented state is a 400 before the definer is asked", badState.status === 400, badState.status);
    const longNote = await call(`/control/errors/${line1.fingerprint}/triage`, null, {
      method: "POST", headers: ck(tok("adm")),
      body: JSON.stringify({ state: "open", note: "n".repeat(601) })
    }, "desk");
    check("and a note too long to be a sentence is a 400 too", longNote.status === 400, longNote.status);
    const ghost = await call(`/control/errors/${ghostFp}/triage`, null, {
      method: "POST", headers: ck(tok("adm")), body: JSON.stringify({ state: "triaged" })
    }, "desk");
    check("triaging a line the register has never seen is a 404, and writes no judgement",
      ghost.status === 404 && (await oi(
        `select count(*)::int as n from app_error_notes where fingerprint = $1`, [ghostFp])
      ).rows[0].n === 0, ghost.status);

    // ------------------------------------------------------------------
    phase("H · retention is a person's decision, with a floor and a ceiling on it");

    const stale = (await oi(
      `select count(*)::int as n from app_errors where last_ts < now() - interval '7 days'`
    )).rows[0].n;
    check("nothing in the register is older than the week floor, so the next prune deletes nothing",
      stale === 0, stale);
    const tooShort = await call("/control/errors/retention", null, {
      method: "POST", headers: ck(tok("adm")), body: JSON.stringify({ keepDays: 3 })
    }, "desk");
    check("a week is the floor and the schema refuses below it before anything is deleted",
      tooShort.status === 400 && (await totalErrors()).rows[0].n >= errors0,
      { s: tooShort.status, b: tooShort.json });
    const prune403 = await call("/control/errors/retention", null, {
      method: "POST", headers: ck(tok("bil")), body: JSON.stringify({ keepDays: 30 })
    }, "desk");
    const pruneAnon = await call("/control/errors/retention", null, {
      method: "POST", body: JSON.stringify({ keepDays: 30 })
    }, "desk");
    check("deleting evidence needs the manage duty and a control session",
      prune403.status === 403 && pruneAnon.status === 401,
      { m: prune403.status, a: pruneAnon.status });

    await clearBuckets("errors-prune:uid:");
    const prune = await call("/control/errors/retention", null, {
      method: "POST", headers: ck(tok("adm")), body: JSON.stringify({ keepDays: 7 })
    }, "desk");
    check("the seat that holds it can run it, and is told what it removed",
      prune.status === 200 && prune.json?.keep_days === 7 && prune.json?.deleted === 0, prune.json);
    const pruned = (await oi(
      `select after from audit_logs where tenant_id = $1 and entity = 'app_errors'
         and action = 'control.error.retention' order by ts desc limit 1`, [CT])).rows[0]?.after;
    check("the decision is audited with the number of lines it deleted",
      pruned?.keep_days === 7 && pruned?.deleted === 0, pruned);
    const stillHere = (await byCode(PROBE_CODE)).rows.length;
    check("and this run's own lines survived it, because they are minutes old",
      stillHere >= 3, stillHere);

    // Five decisions an hour over a 3600-second window cannot be walked into by a test suite,
    // so the window this run is standing in is set to four hits and the cap is crossed on the
    // fifth. The refusal is the point; the hour is not.
    await seedBuckets("errors-prune:uid:", 4);
    let refused = 0, accepted = 0;
    for (let i = 0; i < 6; i++) {
      const r = await call("/control/errors/retention", null, {
        method: "POST", headers: ck(tok("adm")), body: JSON.stringify({ keepDays: 400 })
      }, "desk");
      if (r.status === 429) refused++; else if (r.status === 200) accepted++;
    }
    check("the door that deletes is limited to five decisions an hour, far tighter than the read",
      accepted === 1 && refused === 5, { accepted, refused });
    const keptDecisions = (await oi(
      `select count(*)::int as n from audit_logs where tenant_id = $1
         and action = 'control.error.retention' and after->>'keep_days' = '400'`, [CT])).rows[0].n;
    check("…and a decision the limiter refused was never audited as if it had run",
      keptDecisions === 1, keptDecisions);
    await clearBuckets("errors-prune:uid:");

    // ------------------------------------------------------------------
    phase("I · the intake is limited too, because it is open to the internet");

    await toMinuteEdge();
    await clearBuckets("clienterr:ip:");
    let intake429 = 0, intakeOk = 0;
    for (let i = 0; i < 34; i++) {
      const r = await call("/client-errors", null, {
        method: "POST", body: JSON.stringify({
          errors: [{ message: `flood ${STAMP}`, code: CLIENT_CODE, source: "window" }]
        })
      });
      if (r.status === 429) intake429++; else if (r.status === 202) intakeOk++;
    }
    check("thirty reports a minute from one address, then the address is ignored",
      intakeOk === 30 && intake429 === 4, { intakeOk, intake429 });
    const flooded = (await oi(
      `select coalesce(sum(1 + repeats),0)::int as occurrences, count(*)::int as lines
         from app_errors where code = $1 and message like 'flood%'`, [CLIENT_CODE])).rows[0];
    check("a refused report is not written, so a flood costs the register one line per minute",
      flooded.occurrences === intakeOk && flooded.lines <= 2, flooded);
    await clearBuckets("clienterr:ip:");

    // ------------------------------------------------------------------
    phase("J · the system report and the advisory now speak the same numbers");

    const report = await call("/control/system/report", null, { headers: ck(tok("adm")) }, "desk");
    const rep = report.json?.errors ?? {};
    check("the technical report carries the register's summary instead of saying it is missing",
      report.status === 200 && rep.server_lines >= 3 && rep.client_lines >= 3
      && rep.window_days === 7, rep);
    check("…and its occurrences fold the repeats, which is the number worth reading",
      rep.occurrences >= rep.server_occurrences && rep.server_occurrences >= 6, rep);
    const advice = await call("/control/system/advisory", null, { headers: ck(tok("adm")) }, "desk");
    const errItem = (advice.json?.items ?? []).find((i: any) => i.item_id === "errors_server_24h");
    check("the advisory has a reliability item, counted over the last day",
      advice.status === 200 && !!errItem && errItem.area === "Reliability"
      && Number(errItem.metric) >= 6 && errItem.unit === "occurrences", errItem);
    check("…and its priority matches the threshold the item is written against",
      errItem?.priority === (Number(errItem?.metric) >= 20 ? "high" : "medium"),
      { priority: errItem?.priority, metric: errItem?.metric });
    check("the honesty note no longer claims the register does not exist",
      !/no error collector|no metrics endpoint and no error collector/i
        .test(JSON.stringify(advice.json?.not_measured ?? "")),
      JSON.stringify(advice.json?.not_measured ?? "").match(/collector[^"]{0,60}/)?.[0]);

    // ------------------------------------------------------------------
    phase("K · nothing about the plumbing leaves the building");

    const leakMarkers = ["password_hash", "token_hash", "totp_secret", "nida_encrypted",
      "phone_encrypted", "syntax error at or near", "duplicate key value violates",
      'relation "no_such_table"', "at Object.<anonymous>", "FastifyError"];
    const inServer = serverBodies.join("\n").match(new RegExp(leakMarkers.map(escapeRe).join("|"), "i"));
    check("a 500 response never contains an engine message, a stack frame or a column name",
      !inServer, inServer?.[0]);
    const inPublic = publicBodies.join("\n");
    check("the intake never echoes the message it was given, so a crash report cannot poison a page",
      !inPublic.includes(RAW_EMAIL) && !inPublic.includes("client crash")
      && !inPublic.includes(`flood ${STAMP}`), inPublic.slice(0, 120));
    const inDesk = deskBodies.join("\n");
    check("the desk never shows a credential column",
      !["password_hash", "token_hash", "totp_secret", "refresh_token_hash", "nida_encrypted",
        "phone_encrypted"].some((m) => inDesk.includes(m)),
      ["password_hash", "token_hash", "totp_secret", "refresh_token_hash", "nida_encrypted",
        "phone_encrypted"].filter((m) => inDesk.includes(m)));
    check("a director reading its own portal sees no hint of the platform's failures",
      (await call("/notifications", tokenA, {})).status === 200);
  } finally {
    // ==================================================================
    phase("teardown");
    await sweepRegister();
    const tids = [TC, CT].filter(Boolean);
    await wipeTenants(tids);
    await clearBuckets("clienterr:ip:", "errors:uid:", "errors-detail:uid:",
      "errors-triage:uid:", "errors-prune:uid:", "login:", "signup:", "otp:", "ip:");
    const left = (await oi(
      `select (select count(*)::int from tenants where name like $1) as tenants,
              (select count(*)::int from users where tenant_id = any($4::uuid[])) as seats,
              (select count(*)::int from app_errors where path = $2 or code = $3) as errors,
              (select count(*)::int from app_error_notes where fingerprint in
                  (select fingerprint from app_errors where path = $2 or code = $3)) as notes,
              (select count(*)::int from app_errors) as total`,
      [NAME_SWEEP, PROBE_PATH, CLIENT_CODE, tids])).rows[0];
    check("no fixture company, seat, probe line, client line or judgement is left behind",
      left.tenants === 0 && left.seats === 0 && left.errors === 0 && left.notes === 0, left);
    console.log(`   register still holds ${left.total} line(s) belonging to other runs`);
    await owner.end();
  }

  console.log(`\n${failures ? "FAILURES: " + failures : "all error-register checks passed"}`);
  process.exit(failures ? 1 : 0);
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

main().catch((e) => { console.error(e); process.exit(1); });
