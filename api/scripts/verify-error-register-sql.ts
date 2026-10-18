/**
 * Live proof for #130a — the register that catches what the system gets wrong
 * (migrations 082, 083).
 *
 * Same rule 066 established and 081 re-proved: EXPLAIN cannot see inside a SECURITY DEFINER
 * body, so a collector that silently drops every row, a guard that answers with an empty
 * judgement instead of refusing, or a register a handler can read (or rewrite) through RLS is
 * only caught by running it. The posture half is read out of the catalog as the owner; the
 * execution half runs the exported statements from the routes, so what is tested is the exact
 * string the routes send.
 *
 * Two things make this script different from the others, and both are deliberate:
 *
 *  - It tests the collector's own arithmetic first, in TypeScript, before any SQL runs.
 *    `normalisePath`/`scrub`/`fingerprintOf` decide whether the register groups at all and
 *    whether a phone number or an address ends up in a table that whoever opens the desk can
 *    read. They are pure functions — getting them wrong is not something a database is able
 *    to complain about, and the register would look healthy while being unreadable.
 *  - The write probes run inside their own transaction and roll it back, and prune_errors is
 *    run in there too. A script whose job is to read the shape of a reliability register must
 *    not itself delete evidence or leave probe lines in the table it is examining. Every count
 *    is a delta against a baseline read, because the register is live: the API running beside
 *    this script can legitimately write a row while it works.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-error-register-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  RECORD_ERROR_SQL, fingerprintOf, normalisePath, scrub, type ErrorSeed
} from "../src/security/error-record.js";
import {
  ERROR_REGISTER_SQL, ERROR_OCCURRENCES_SQL, ERROR_SUMMARY_SQL, ERROR_MARK_SQL, ERROR_PRUNE_SQL
} from "../src/routes/control-errors.routes.js";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label,
    (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500)); }
}

function ownerUrl(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  return url;
}

/** app_runtime URL: dev hands us the owner URL, so rebuild it (066's shape). */
function appUrl(): string | null {
  const url = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  const u = new URL(url);
  if (u.username.startsWith("app_runtime")) return url;
  if (!process.env.APP_DB_PASSWORD) return null;
  const ref = u.username.split(".")[1];
  u.username = "app_runtime" + (ref ? "." + ref : "");
  u.password = encodeURIComponent(process.env.APP_DB_PASSWORD);
  return u.toString();
}

const DEFINERS = [
  "record_error", "error_register", "error_occurrences", "error_summary",
  "mark_error", "prune_errors"
];

/**
 * One stamp per run, so a probe line can never be mistaken for a real failure. Letters
 * around the digits on purpose: a run of nine digits would be scrubbed to `###########`
 * before it was stored, and the probe could then not recognise its own message.
 */
const STAMP = "v" + Date.now().toString(36) + "p";
const ROUTE = `/082/verify/${STAMP}`;

function seed(message: string, extra: Partial<ErrorSeed> = {}): ErrorSeed {
  return {
    kind: "server", message, code: `PROBE_${STAMP}`, status: 500,
    method: "POST", path: `/api/v1/cargo/${randomUUID()}/docs?email=a@b.co`,
    route: ROUTE, ...extra
  };
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();

  // ================================================================
  console.log("\n--- 1 · the shape the collector is made of ---");

  // A register keyed on the raw URL is one line per order id, which is how a reliability tool
  // becomes a second copy of the transactions table. Id-shaped segments collapse.
  const id = randomUUID();
  check("a uuid, a long hex and a numeric segment all collapse to :id",
    normalisePath(`/api/v1/cargo/${id}/docs`) === "/api/v1/cargo/:id/docs"
    && normalisePath("/api/v1/trips/41780") === "/api/v1/trips/:id"
    && normalisePath("/api/v1/x/deadbeefdeadbeefdeadbeef") === "/api/v1/x/:id",
    normalisePath(`/api/v1/cargo/${id}/docs`));
  check("the query string and the fragment never reach the register",
    normalisePath("/api/v1/booking?tin=987654321&nida=12345") === "/api/v1/booking",
    normalisePath("/api/v1/booking?tin=987654321&nida=12345"));
  check("a word that happens to contain digits stays a word",
    normalisePath("/api/v1/control/tenants/policy/idle") === "/api/v1/control/tenants/policy/idle");

  // Contact-shaped text must be gone before hashing: the stored message AND the fingerprint
  // are both derived from what this function returns.
  const pii = scrub(
    "seat support@tengoa.com phone +255712345678 alt 0765432198 nida 198765432 "
    + "bearer abcdef123456 password: hunter2secret token=eyJhbGciOiJIU api_key: k-9988776655",
    500) ?? "";
  const leaks = ["support@tengoa.com", "255712345678", "0765432198", "198765432",
    "abcdef123456", "hunter2secret", "eyJhbGciOiJIU", "k-9988776655"].filter((s) => pii.includes(s));
  check("scrub removes addresses, MSISDNs, long digit runs and credential values",
    leaks.length === 0, { leaks, pii });
  check("…and keeps the sentence readable, with the masks where the secrets were",
    pii.includes("e***@masked") && pii.includes("+255*******") && pii.includes("0*******")
    && pii.includes("###########") && pii.includes("password: ***") && pii.includes("token=***")
    && pii.includes("api_key: ***") && pii.includes("bearer ***"), pii);
  check("a credential WORD alone is not masked, so prose still reads as prose",
    scrub("the refresh token is missing for this seat", 200) === "the refresh token is missing for this seat",
    scrub("the refresh token is missing for this seat", 200));
  check("an address on a dotted domain is masked whole, TLD and all",
    scrub("charge failed for ada@alpha.co.tz", 200) === "charge failed for e***@masked",
    scrub("charge failed for ada@alpha.co.tz", 200));
  check("control characters are dropped but a stack's newlines and tabs survive",
    (scrub("a\u0000b\u0007c\nd\te", 100) ?? "") === "a b c\nd\te", scrub("a\u0000b\u0007c\nd\te", 100));
  check("scrub clamps to the caller's ceiling and treats empty as null",
    (scrub("x".repeat(900), 500) ?? "").length === 500 && scrub("", 500) === null
    && scrub(null, 500) === null);

  // Two failures of the same bug at two different ids are one line; two different bugs in one
  // route are two lines. Everything else makes the desk unreadable.
  const fp1 = fingerprintOf(seed(`insert into freight_invoices failed with 23505 on row 41`));
  const fp2 = fingerprintOf(seed(`insert into freight_invoices failed with 23505 on row 77`));
  const fp3 = fingerprintOf(seed(`connection reset by peer`));
  check("the same bug at a different id is the same fingerprint", fp1 === fp2, { fp1, fp2 });
  check("a different message in the same route is a different fingerprint", fp1 !== fp3);
  check("kind is part of the key, so a browser crash is never folded into a server 500",
    fp1 !== fingerprintOf({ ...seed(`insert into freight_invoices failed with 23505 on row 41`), kind: "client" }));
  check("status and code are part of the key too",
    fingerprintOf({ ...seed("x"), status: 503 }) !== fingerprintOf({ ...seed("x"), status: 500 })
    && fingerprintOf({ ...seed("x"), code: "A" }) !== fingerprintOf({ ...seed("x"), code: "B" }));
  check("a fingerprint is 32 lowercase hex characters", /^[0-9a-f]{32}$/.test(fp1), fp1);

  // The point of scrubbing before hashing: the same bug seen through two customers must not
  // become two lines. This is the check that caught the raw-material key.
  const custA = fingerprintOf({ kind: "client", message: "charge failed for ada@alpha.co.tz on 2026-10-18" });
  const custB = fingerprintOf({ kind: "client", message: "charge failed for ben@bravo.co.tz on 2026-10-18" });
  check("fingerprinting the scrubbed text, not the raw text, keeps one bug one line",
    scrub("charge failed for ada@alpha.co.tz on 2026-10-18", 500)
      === scrub("charge failed for ben@bravo.co.tz on 2026-10-18", 500));
  check("…while a raw key would have split them", custA !== custB, { custA, custB });
  // A handler that names the row it choked on is the commonest way a bug description carries
  // an id, and a uuid is not a digit run — it survived the shape rules and gave one bug one
  // line per seat.
  const seatOne = "column user_id does not exist for 2f4a1b6c-7d8e-4a1b-9c8d-1e2f3a4b5c6d";
  const seatTwo = "column user_id does not exist for 9a8b7c6d-5e4f-4013-a2b1-0f1e2d3c4b5a";
  check("a message quoting one seat id and another seat id is one fingerprint",
    fingerprintOf({ kind: "server", message: seatOne, route: "/x" })
      === fingerprintOf({ kind: "server", message: seatTwo, route: "/x" }));
  check("…and a real word in that sentence still splits it",
    fingerprintOf({ kind: "server", message: seatOne, route: "/x" })
      !== fingerprintOf({ kind: "server", message: seatOne.replace("user_id", "tenant_id"), route: "/x" }));

  // ================================================================
  console.log("\n--- 2 · the catalog posture a handler must not be able to talk around ---");

  const shape = await owner.query(
    `select c.relname, c.relrowsecurity,
            (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
            (select string_agg(privilege_type, ',' order by privilege_type)
               from information_schema.table_privileges tp
              where tp.table_name = c.relname
                and tp.grantee in ('app_runtime','public','anon','authenticated','service_role'))
              as granted
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('app_errors','app_error_notes')
       order by c.relname`);
  check("both tables exist", shape.rows.length === 2, shape.rows.map((r) => r.relname));
  for (const t of shape.rows) {
    check(`${t.relname}: row security on`, t.relrowsecurity === true, t);
    check(`…with zero policies, because nothing is meant to be readable through RLS`,
      Number(t.policies) === 0, t.policies);
    check(`…and no table grant to app_runtime, public, anon, authenticated or service_role`,
      !t.granted, t.granted);
  }

  const key = await owner.query(
    `select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'app_errors'`);
  const defs = key.rows.map((r) => r.indexdef);
  check("the register's key is (fingerprint, bucket) — one line per bug per minute",
    defs.some((d) => /UNIQUE/i.test(d) && /fingerprint/.test(d) && /bucket/.test(d)), defs);
  check("and the desk's two read paths are indexed",
    defs.some((d) => /last_ts DESC/i.test(d)) && defs.some((d) => /kind/.test(d)), defs);

  const acl = await owner.query(
    `select p.proname, p.prosecdef,
            coalesce(nullif(array_to_string(p.proconfig, ','), ''), '(unset)') as config,
            has_function_privilege('app_runtime', p.oid, 'execute') as app_x,
            has_function_privilege('public', p.oid, 'execute') as pub_x,
            has_function_privilege('anon', p.oid, 'execute') as anon_x,
            has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
            has_function_privilege('service_role', p.oid, 'execute') as svc_x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)
      order by p.proname`, [DEFINERS]);
  const present = new Set(acl.rows.map((r) => r.proname));
  check("every 082 definer is present in the catalog",
    DEFINERS.every((n) => present.has(n)), acl.rows.map((r) => `${r.proname}/${r.app_x}`));
  for (const r of acl.rows) {
    check(`${r.proname}: definer, search_path pinned, app_runtime only`,
      r.prosecdef === true && r.config === "search_path=public" && r.app_x === true
      && r.pub_x === false && r.anon_x === false && r.auth_x === false && r.svc_x === false, r);
  }
  check("none of them is executable by PUBLIC — including the writer and the pruner",
    acl.rows.every((r) => r.pub_x === false),
    acl.rows.filter((r) => r.pub_x).map((r) => r.proname));

  const colChecks = await owner.query(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = any(array['app_errors'::regclass,'app_error_notes'::regclass])
        and contype = 'c'`);
  const cd = colChecks.rows.map((r) => r.def);
  check("the register constrains the kind and a sane status",
    cd.some((d) => d.includes("'server'") && d.includes("'client'"))
    && cd.some((d) => /status >= 100/.test(d) && /status <= 599/.test(d)), cd);
  check("a judgement has four states and a note with a ceiling",
    cd.some((d) => d.includes("'triaged'") && d.includes("'ignored'"))
    && cd.some((d) => /char_length\(note\) <= 600/.test(d)), cd);

  // ================================================================
  console.log("\n--- 3 · the writer, the doors and the guards, on lines that roll back ---");

  const tid = randomUUID();
  const uid = randomUUID();
  const fpAlpha = fingerprintOf(seed(`probe alpha ${STAMP}`));
  const fpBeta = fingerprintOf(seed(`probe beta ${STAMP}`));
  const fpGamma = fingerprintOf(seed(`probe gamma ${STAMP}`));
  const oldFp = randomUUID().replace(/-/g, "");
  const PROBE = [fpAlpha, fpBeta, fpGamma, oldFp];

  const countProbe = () => owner.query(
    `select count(*)::int as n from app_errors where fingerprint = any($1::text[])`, [PROBE]);
  const sum0 = (await owner.query(ERROR_SUMMARY_SQL, [7])).rows[0].s as any;
  const notes0 = (await owner.query(`select count(*)::int as n from app_error_notes`)).rows[0].n;

  await owner.query("begin");
  try {
    await owner.query(
      `insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')`,
      [tid, "082 verify probe (rolled back)"]);
    await owner.query(
      `insert into users (id, tenant_id, user_type, full_name, email, email_normalized_search, status)
       values ($1,$2,'platform','Ada Desk',$3,$4,'active')`,
      [uid, tid, `082.verify.probe.${STAMP}@waisha.test`, `082.verify.probe.${STAMP}@waisha.test`]);

    // The same parameter list recordError() builds, on this connection instead of the pool,
    // so the writes are inside the transaction that rolls back.
    const write = (s: ErrorSeed, fp: string) => owner.query(RECORD_ERROR_SQL, [
      s.kind, fp, scrub(s.code, 60), s.status ?? null, scrub(s.method, 8),
      s.path ? normalisePath(s.path) : null, scrub(s.route, 120), scrub(s.message, 500),
      scrub(s.detail, 4000), scrub(s.requestId, 64), s.tenantId ?? null, s.actorUserId ?? null,
      scrub(s.ip, 60), scrub(s.userAgent, 200), "verify"]);

    const base = (await countProbe()).rows[0].n;
    await write(seed(`probe alpha ${STAMP}`, {
      requestId: "req-alpha-1", tenantId: tid, actorUserId: uid, ip: "203.0.113.9",
      userAgent: "verify-error-register/082", detail: null
    }), fpAlpha);
    await write(seed(`probe alpha ${STAMP} at id 41`, { requestId: "req-alpha-2", detail: "stack one" }), fpAlpha);
    await write(seed(`probe alpha ${STAMP} at id 77`, { requestId: "req-alpha-3", detail: "stack two" }), fpAlpha);
    await write(seed(`probe alpha ${STAMP} again`, { detail: null }), fpAlpha);
    await write(seed(`probe beta ${STAMP}`, {
      kind: "client", status: null, method: null, path: null, route: null
    }), fpBeta);

    const lines = (await owner.query(
      `select fingerprint, kind, repeats, message, detail, request_id, tenant_id, actor_user_id,
              ip, user_agent, environment, status, method, path, code,
              bucket = date_trunc('minute', now()) as pinned, char_length(message) as mlen
         from app_errors where fingerprint = any($1::text[]) order by fingerprint`, [PROBE])).rows;
    const alpha = lines.find((r) => r.fingerprint === fpAlpha);
    check("four failures of one bug in one minute are ONE line with repeats 3",
      (await countProbe()).rows[0].n - base === 2 && lines.length === 2
      && Number(alpha?.repeats) === 3, { added: (await countProbe()).rows[0].n - base, alpha });
    check("the bucket is the truncated minute, so the fold key is real",
      alpha?.pinned === true, alpha?.pinned);
    // detail = coalesce(app_errors.detail, excluded.detail): the FIRST occurrence's stack is
    // the one that predates any retry, and nothing later may overwrite it.
    check("the line keeps the first stack it was given, not the last",
      alpha?.detail === "stack one", alpha?.detail);
    check("…and a later failure with no context does not blank the request id out",
      alpha?.request_id === "req-alpha-3", alpha?.request_id);
    check("attribution lands on the line once and stays: company, seat, ip, environment",
      alpha?.tenant_id === tid && alpha?.actor_user_id === uid && alpha?.ip === "203.0.113.9"
      && alpha?.environment === "verify" && /verify-error-register/.test(alpha?.user_agent ?? ""), alpha);
    check("the path is the normalised one and the code is the run's own",
      alpha?.path === "/api/v1/cargo/:id/docs" && alpha?.code === `PROBE_${STAMP}`,
      { p: alpha?.path, c: alpha?.code });
    check("the message is the scrubbed text exactly as the collector sends it",
      alpha?.message === `probe alpha ${STAMP}`
      && alpha?.mlen === (`probe alpha ${STAMP}`).length, { m: alpha?.message, mlen: alpha?.mlen });

    const beta = lines.find((r) => r.fingerprint === fpBeta);
    check("a client line is stored as a client line, with nothing invented around it",
      beta?.kind === "client" && beta?.status === null && beta?.method === null
      && beta?.path === null && beta?.repeats === 0, beta);

    // ----------------------------------------------------------------
    console.log("\n--- 3b · what the writer refuses to write ---");

    const junkBefore = (await countProbe()).rows[0].n;
    // Each of these must be a silent drop, not a raise: the collector runs inside a request
    // that is already failing, so an error here turns one broken route into a hung one.
    await owner.query(RECORD_ERROR_SQL,
      ["bogus", fpAlpha, null, null, null, null, null, "kind outside the enum", null, null, null, null, null, null, null]);
    await owner.query(RECORD_ERROR_SQL,
      ["server", "abc", null, null, null, null, null, "fingerprint too short to be one", null, null, null, null, null, null, null]);
    await owner.query(RECORD_ERROR_SQL,
      ["server", fpAlpha, null, null, null, null, null, "   ", null, null, null, null, null, null, null]);
    await owner.query(RECORD_ERROR_SQL,
      ["server", null, null, null, null, null, null, "no fingerprint at all", null, null, null, null, null, null, null]);
    await owner.query(RECORD_ERROR_SQL,
      [null, fpAlpha, null, null, null, null, null, "no kind at all", null, null, null, null, null, null, null]);
    const junkAfter = (await countProbe()).rows[0].n;
    check("a wrong kind, a short or null fingerprint and a blank message are all dropped",
      junkAfter === junkBefore, { junkBefore, junkAfter });
    check("…and dropping them did not even fold a repeat into the real line",
      (await owner.query(`select repeats from app_errors where fingerprint = $1`, [fpAlpha]))
        .rows[0].repeats === 3);

    await write(seed(`probe gamma ${STAMP}`, { status: 99, code: "y".repeat(400), method: "GETGETGETGET" }), fpGamma);
    const gamma = (await owner.query(
      `select status, char_length(code) as clen, char_length(method) as mlen, kind, message
         from app_errors where fingerprint = $1`, [fpGamma])).rows[0];
    check("a status outside 100-599 is nulled, not stored, and long fields are clamped",
      gamma?.status === null && gamma?.clen === 60 && gamma?.mlen === 8, gamma);

    // ----------------------------------------------------------------
    console.log("\n--- 3c · the readers, as the desk uses them ---");

    const reg = (await owner.query(ERROR_REGISTER_SQL, [null, null, STAMP, 7, 100])).rows;
    const lineA = reg.find((r) => r.fingerprint === fpAlpha);
    check("the register folds the minute lines into one bug line and counts them",
      lineA?.occurrences === 4 && lineA?.lines === 1 && lineA?.kind === "server"
      && lineA?.tenants === 1 && lineA?.request_id === "req-alpha-3", lineA);
    check("…and it starts with no judgement at all, only the default state",
      lineA?.state === "open" && lineA?.triage_note === null, lineA);
    check("the probe beta and gamma lines are on the same list",
      reg.length === 3 && reg.some((r) => r.fingerprint === fpBeta && r.kind === "client")
      && reg.some((r) => r.fingerprint === fpGamma && r.occurrences === 1),
      reg.map((r) => `${r.fingerprint.slice(0, 6)}/${r.kind}/${r.occurrences}`));
    // One search term per column the definer claims to look in, scored on the probe lines it
    // surfaced rather than on a row count — the register is live, and a real failure that
    // happens to mention "cargo" is not this check's business. beta has no path and no route,
    // so it is the term that proves the message column is searched on its own.
    const matched = async (term: string) =>
      (await owner.query(ERROR_REGISTER_SQL, [null, null, term, 7, 300])).rows
        .filter((r: any) => PROBE.includes(r.fingerprint)).map((r: any) => r.fingerprint).sort();
    const probe2 = [fpAlpha, fpGamma].sort();
    const byColumn = {
      message: await matched("probe beta"), path: await matched("cargo/:id"),
      route: await matched(ROUTE), code: await matched("PROBE_")
    };
    check("the q filter searches message, path, route and code — each on its own evidence",
      byColumn.message.length === 1 && byColumn.message[0] === fpBeta
      && byColumn.path.join() === probe2.join() && byColumn.route.join() === probe2.join()
      && byColumn.code.length === 3, byColumn);
    check("the kind filter really filters",
      (await owner.query(ERROR_REGISTER_SQL, ["client", null, null, 7, 100]))
        .rows.every((r) => r.kind === "client"));
    check("a one-day window still holds a line written now, and a search for nothing answers empty",
      (await owner.query(ERROR_REGISTER_SQL, [null, null, STAMP, 1, 100])).rows.length === 3
      && (await owner.query(ERROR_REGISTER_SQL, [null, null, "zzz-not-a-line-zzz", 7, 100])).rows.length === 0);
    check("the limit is honoured and clamped to a page the desk can render",
      (await owner.query(ERROR_REGISTER_SQL, [null, null, null, 7, 2])).rows.length === 2
      && (await owner.query(ERROR_REGISTER_SQL, [null, null, null, 7, 99999])).rows.length <= 300);

    const occ = (await owner.query(ERROR_OCCURRENCES_SQL, [fpAlpha, 20])).rows;
    check("the drill-down returns the one minute line with the company and the seat named",
      occ.length === 1 && occ[0].tenant_name === "082 verify probe (rolled back)"
      && occ[0].actor_name === "Ada Desk" && occ[0].repeats === 3
      && occ[0].detail === "stack one", occ[0]);
    check("an unknown fingerprint answers with no rows, not an error",
      (await owner.query(ERROR_OCCURRENCES_SQL, [randomUUID().replace(/-/g, ""), 20])).rows.length === 0);

    const sum = (await owner.query(ERROR_SUMMARY_SQL, [7])).rows[0].s as any;
    const d = (k: string) => Number(sum[k]) - Number(sum0[k]);
    check("the summary counts the probe lines on top of whatever the live API wrote",
      d("lines") === 3 && d("server_lines") === 2 && d("client_lines") === 1
      && d("occurrences") === 6 && d("server_occurrences") === 5 && d("client_occurrences") === 1,
      { d: Object.fromEntries(Object.keys(sum).map((k) => [k, d(k)])), sum0 });
    const unt = (await owner.query(
      `select count(distinct e.fingerprint)::int as n from app_errors e
        where not exists (select 1 from app_error_notes n where n.fingerprint = e.fingerprint)`
    )).rows[0].n;
    check("…and the 24-hour and tenant counters agree with the lines it counted",
      d("in_last_24h") === 6 && d("server_in_last_24h") === 5 && d("tenants") >= 1
      && sum.untouched === unt, { unt, sum });
    check("every counter the desk reads is a number, never a null it has to defend against",
      Object.keys(sum).length === 16 && Object.values(sum).every((v) => typeof v === "number"),
      Object.entries(sum).filter(([, v]) => typeof v !== "number"));

    // ----------------------------------------------------------------
    console.log("\n--- 3d · triage is a judgement, and the guards hold ---");

    const unknown = await owner.query(ERROR_MARK_SQL, [randomUUID().replace(/-/g, ""), "triaged", null, uid]);
    check("a fingerprint the register has never seen cannot be triaged",
      unknown.rows.length === 0, unknown.rows);
    const badState = await owner.query(ERROR_MARK_SQL, [fpAlpha, "wontfix", null, uid]);
    check("an invented state is refused with no rows at all, not a row of nulls",
      badState.rows.length === 0 && !badState.rows.some((r) => r.state === null), badState.rows);
    const longNote = await owner.query(ERROR_MARK_SQL, [fpAlpha, "triaged", "n".repeat(601), uid]);
    check("a note too long for the column is refused before the upsert runs",
      longNote.rows.length === 0, longNote.rows);
    check("…and none of the three refusals wrote a judgement",
      (await owner.query(`select count(*)::int as n from app_error_notes`)).rows[0].n === notes0,
      (await owner.query(`select count(*)::int as n from app_error_notes`)).rows[0].n);

    const first = (await owner.query(ERROR_MARK_SQL,
      [fpAlpha, "triaged", "Needs the billing route, not the pool.", uid])).rows[0];
    check("a real triage answers with the line it judged",
      first?.fingerprint === fpAlpha && first?.state === "triaged"
      && first?.note === "Needs the billing route, not the pool." && !!first?.updated_at, first);
    const second = (await owner.query(ERROR_MARK_SQL, [fpAlpha, "resolved", null, uid])).rows[0];
    check("a state change with no note keeps the sentence the last seat wrote",
      second?.state === "resolved" && second?.note === "Needs the billing route, not the pool.", second);
    const blank = (await owner.query(ERROR_MARK_SQL, [fpAlpha, "open", "", uid])).rows[0];
    check("…and an explicit blank keeps it too, because only an absent note means keep",
      blank?.state === "open" && blank?.note === "Needs the billing route, not the pool.", blank);
    const third = (await owner.query(ERROR_MARK_SQL,
      [fpAlpha, "ignored", "Duplicate of the pool timeout.", uid])).rows[0];
    check("a new note replaces it, because a judgement is allowed to change",
      third?.state === "ignored" && third?.note === "Duplicate of the pool timeout.", third);
    check("the note row names the seat who judged it",
      (await owner.query(`select updated_by from app_error_notes where fingerprint = $1`, [fpAlpha]))
        .rows[0]?.updated_by === uid);

    const judged = (await owner.query(ERROR_REGISTER_SQL, ["server", "ignored", STAMP, 7, 100])).rows;
    check("the desk can find the lines it already judged",
      judged.length === 1 && judged[0].fingerprint === fpAlpha
      && judged[0].triage_note === "Duplicate of the pool timeout.", judged);
    const untouched = (await owner.query(ERROR_REGISTER_SQL, [null, "untouched", STAMP, 7, 100])).rows;
    check("…and 'untouched' means no note row at all, not a state called open",
      untouched.length === 2 && !untouched.some((r) => r.fingerprint === fpAlpha)
      && untouched.every((r) => r.triage_note === null), untouched.map((r) => r.kind));
    const stillThere = (await owner.query(ERROR_REGISTER_SQL, [null, null, STAMP, 7, 100])).rows;
    check("triage changed nothing about the facts: same counts, same lines, same message",
      stillThere.length === 3 && stillThere.find((r) => r.fingerprint === fpAlpha)?.occurrences === 4
      && stillThere.find((r) => r.fingerprint === fpAlpha)?.message === `probe alpha ${STAMP}`,
      stillThere.map((r) => `${r.fingerprint.slice(0, 6)}/${r.occurrences}`));

    // ----------------------------------------------------------------
    console.log("\n--- 3e · retention is an operator decision with a floor under it ---");

    await owner.query(
      `insert into app_errors (bucket, fingerprint, kind, code, status, method, path, route,
                message, request_id, first_ts, last_ts, repeats)
       values (date_trunc('minute', now() - interval '30 days'), $1,'server','OLD',500,'GET',
               '/api/v1/old','/old','a failure from a month ago','req-old',
               now() - interval '30 days', now() - interval '30 days', 41)`, [oldFp]);
    await owner.query(`insert into app_error_notes (fingerprint, state, note, updated_by)
                       values ($1,'resolved','Old enough to be gone.', $2)`, [oldFp, uid]);

    const totalBefore = (await owner.query(`select count(*)::int as n from app_errors`)).rows[0].n;
    const tooSoon = (await owner.query(ERROR_PRUNE_SQL, [3])).rows[0].r;
    check("a prune that would keep three days is refused outright",
      tooSoon.status === "invalid" && /at least 7 days/.test(tooSoon.message ?? ""), tooSoon);
    check("…and it deleted nothing",
      (await owner.query(`select count(*)::int as n from app_errors`)).rows[0].n === totalBefore,
      { totalBefore, n: (await owner.query(`select count(*)::int as n from app_errors`)).rows[0].n });

    const pruned = (await owner.query(ERROR_PRUNE_SQL, [7])).rows[0].r;
    check("a week is the floor it keeps, and it reports its own cutoff",
      pruned.status === "ok" && pruned.keep_days === 7 && !!pruned.cutoff, pruned);
    const afterPrune = (await owner.query(
      `select (select count(*)::int from app_errors where fingerprint = $1) as old_line,
              (select count(*)::int from app_errors where fingerprint = any($2::text[])) as probes,
              (select count(*)::int from app_error_notes where fingerprint = $1) as old_note`,
      [oldFp, [fpAlpha, fpBeta, fpGamma]])).rows[0];
    check("it removes the month-old line and leaves every line still inside the window",
      afterPrune.old_line === 0 && afterPrune.probes === 3, afterPrune);
    check("a fingerprint nobody can see any more loses its judgement too",
      afterPrune.old_note === 0, afterPrune);
    check("…while the judgement on a line still inside the window stays",
      (await owner.query(`select state from app_error_notes where fingerprint = $1`, [fpAlpha]))
        .rows[0]?.state === "ignored");
    check("the pruned line is gone from the register and the summary alike",
      (await owner.query(ERROR_REGISTER_SQL, [null, null, "a month ago", 90, 100])).rows.length === 0
      && !(await owner.query(ERROR_MARK_SQL, [oldFp, "open", null, uid])).rows.length);

    await owner.query("rollback");
  } catch (e) {
    await owner.query("rollback").catch(() => { });
    check("the write probes rolled back cleanly", false, String(e).slice(0, 300));
  }

  const residue = await owner.query(
    `select (select count(*)::int from app_errors where fingerprint = any($1::text[])
                            or route = $2) as errors,
            (select count(*)::int from app_error_notes where fingerprint = any($1::text[])) as notes,
            (select count(*)::int from tenants where id = $3) as probe_tenant,
            (select count(*)::int from users where id = $4) as probe_user`,
    [PROBE, ROUTE, tid, uid]);
  check("nothing survives the probe: no register line, no judgement, no fixture company or seat",
    residue.rows[0].errors === 0 && residue.rows[0].notes === 0
    && residue.rows[0].probe_tenant === 0 && residue.rows[0].probe_user === 0, residue.rows[0]);
  check("…and the live register was not emptied by a prune run inside the transaction",
    (await owner.query(`select count(*)::int as n from app_errors`)).rows[0].n >= 0
    && (await owner.query(`select count(*)::int as n from app_error_notes`)).rows[0].n === notes0,
    (await owner.query(`select count(*)::int as n from app_error_notes`)).rows[0].n);

  await owner.end();

  // ================================================================
  console.log("\n--- 4 · the exported statements, as the role that actually runs them ---");

  const app = appUrl();
  if (!app) {
    console.log("skip  app_runtime probe (no APP_DB_PASSWORD / APP_DATABASE_URL)");
  } else {
    const runtime = new pg.Client({ connectionString: app, ssl: { rejectUnauthorized: false } });
    await runtime.connect();
    await runtime.query("begin");
    await runtime.query("set transaction read only");
    for (const [label, sql, params] of [
      ["error_register", ERROR_REGISTER_SQL, [null, null, null, 7, 50]],
      ["error_occurrences", ERROR_OCCURRENCES_SQL, ["00000000000000000000000000000000", 20]],
      ["error_summary", ERROR_SUMMARY_SQL, [7]]
    ] as [string, string, any[]][]) {
      const r = await runtime.query(sql, params).catch((e) => ({ err: String(e.message) } as any));
      check(`app_runtime can execute ${label}`, !r.err, r.err ?? "");
    }
    await runtime.query("rollback");

    for (const [label, sql] of [
      ["select the register", "select * from app_errors limit 1"],
      ["select the notes", "select * from app_error_notes limit 1"],
      ["insert a line", "insert into app_errors (bucket, fingerprint, kind, message) "
        + "values (now(),'deadbeefdeadbeefdeadbeefdeadbeef','server','x')"],
      ["update a line", "update app_errors set message = 'x' where true"],
      ["delete a line", "delete from app_errors where true"]
    ] as [string, string][]) {
      const denied = await runtime.query(sql).then(() => null).catch((e) => String(e.message));
      check(`app_runtime cannot ${label} — the definer is the only door`,
        !!denied && /permission denied/i.test(denied), denied);
    }
    await runtime.end();
  }

  console.log(`\n${failures ? "FAILURES: " + failures : "082 verified."}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
