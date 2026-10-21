/**
 * Live proof for #338 — the two-person register (migration 121).
 *
 * 066's rule, 081's lesson and 110's warning all point the same way: an approval rule that
 * lives in a handler is only as strong as the last handler somebody wrote in a hurry. So
 * this script runs the definers and the trigger rather than the routes — a CHECK cannot be
 * demonstrated by reading it, EXPLAIN cannot see inside a SECURITY DEFINER body, and the
 * only proof that `tenant_actions_two_seats` really stops a ban is the exception it raises.
 *
 * Every write happens inside one transaction that is rolled back. The fixture seats, the
 * companies, the proposals and the register row a signed ban writes must not survive a
 * script whose only job is to read the shape of the thing. The refusal probes sit behind
 * SAVEPOINTs on purpose: a trigger that raises aborts the statement, and every later query
 * in an aborted transaction answers "current transaction is aborted" instead of the thing
 * being tested.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-approvals-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { APPLY_SQL } from "../src/util/tenant-policy.js";
import {
  BOARD_SQL, CLAIM_SQL, DECIDE_SQL, DETAIL_SQL, PROPOSE_SQL, SETTLE_SQL
} from "../src/control/approvals.js";
import { HISTORY_SQL } from "../src/routes/control-tenants.routes.js";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else {
    failures++;
    console.log("FAIL ", label,
      (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500));
  }
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

/** Callable by the API role, because a handler runs them. */
const RUNTIME_FNS = ["propose_approval", "decide_approval", "claim_approval", "settle_approval",
  "approvals_board", "approval_detail", "count_open_approvals", "tenant_apply_action"];
/** Owner-only: a trigger body and a predicate two other definers call for themselves. */
const OWNER_FNS = ["approval_seat", "action_needs_two_seats"];

const ACT = "The office has a complaint against this company and is shutting the door.";
const NOTE = "Probe: the sentence the company would be sent.";
const SIGN = "Probe: the second seat checked the complaint.";

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({
    connectionString: ownerUrl(), ssl: { rejectUnauthorized: false }, statement_timeout: 60000
  });
  await owner.connect();
  const one = async (sql: string, p: any[] = []) => (await owner.query(sql, p)).rows[0];

  // ================================================================
  console.log("\n--- 1 · the posture a handler must not be able to talk around ---");

  const shape = await one(
    `select c.relname, c.relrowsecurity,
            (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
            -- Supabase's default privileges hand service_role full DML on every table in the
            -- public schema — all 114 of them, 078's register included. That role is the
            -- platform's own admin key, it bypasses RLS wherever it goes, and nothing in this
            -- app connects as it, so it is the posture of the host rather than a hole in this
            -- migration. The four grantees below are the ones that face the application, and
            -- they are the ones a register must not have.
            (select coalesce(string_agg(privilege_type, ',' order by privilege_type), '')
               from information_schema.table_privileges tp
              where tp.table_name = c.relname
                and tp.grantee in ('app_runtime','public','anon','authenticated'))
              as facing_the_app
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'platform_approvals'`);
  check("platform_approvals exists with row security on", shape?.relrowsecurity === true, shape);
  check("…zero policies, because nothing is meant to be readable through RLS",
    Number(shape?.policies ?? -1) === 0, shape?.policies);
  check("…and no table grant to the API role, PUBLIC or either Supabase web role",
    !shape?.facing_the_app, shape?.facing_the_app);

  const cons = (await owner.query(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conname <> 'platform_approvals_pkey'
        and conrelid = 'platform_approvals'::regclass order by conname`)).rows;
  const defs = cons.map((r: any) => r.def);
  // Compared against the decompiled text rather than the names: a constraint somebody
  // renamed still holds, and one that was rewritten into a different rule does not.
  check("the two-seats rule is a CHECK on the row, not a line in a route",
    defs.some((d) => /decided_by is null/i.test(d) && /decided_by <> proposed_by/i.test(d)),
    defs.filter((d) => /proposed_by/.test(d)));
  check("a decision without a decision time is refused",
    defs.some((d) => /decided_by is null/i.test(d) && /decided_at is not null/i.test(d)), defs);
  check("a settled row cannot claim it is still waiting",
    defs.some((d) => /'pending'/i.test(d) && /'lapsed'/i.test(d) && /decided_by is not null/i.test(d)), defs);
  check("only a spent signature may say it was applied",
    defs.some((d) => /applied_at is null/i.test(d) && /status = 'applied'/i.test(d)), defs);
  check("the hash column is a hash and nothing else",
    defs.some((d) => /payload_sha256 ~/i.test(d) && /\[0-9a-f\]\{64\}/.test(d)), defs);
  check("the reason has a floor as well as a ceiling, so a signature is never bought by a word",
    defs.some((d) => /char_length/i.test(d) && /reason/i.test(d)), defs);
  check("a proposal cannot be born already expired",
    defs.some((d) => /expires_at > proposed_at/i.test(d)), defs);

  const idx = await one(
    `select indexdef from pg_indexes
      where tablename = 'platform_approvals' and indexname = 'approvals_one_open'`);
  check("one act against one company may be open at a time, and it is a UNIQUE index",
    /UNIQUE/i.test(idx?.indexdef ?? "") && /WHERE/i.test(idx?.indexdef ?? "")
    && /PENDING/i.test(idx?.indexdef ?? ""), idx?.indexdef);

  const trg = await one(
    `select t.tgname, t.tgenabled::text as en, pg_get_triggerdef(t.oid) as def
       from pg_trigger t where t.tgrelid = 'tenant_actions'::regclass and not t.tgisinternal
         and t.tgname = 'tenant_actions_two_seats'`);
  check("the register table carries the two-seats trigger, enabled",
    !!trg && trg.en === "O" && /BEFORE INSERT/i.test(trg.def), trg);
  const apcol = await one(
    `select column_name, data_type from information_schema.columns
      where table_name = 'tenant_actions' and column_name = 'approval_id'`);
  check("…and the column it reads, pointing at the proposal that bought the row",
    !!apcol && apcol.data_type === "uuid", apcol);

  const acl = await owner.query(
    `select p.proname, p.prosecdef,
            coalesce(nullif(array_to_string(p.proconfig, ','), ''), '(unset)') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)
      order by p.proname, pg_get_function_arguments(p.oid)`,
    [RUNTIME_FNS.concat(OWNER_FNS)]);
  const priv = await owner.query(
    `select p.proname,
            has_function_privilege('app_runtime', p.oid, 'execute') as app_x,
            has_function_privilege('public', p.oid, 'execute') as pub_x,
            has_function_privilege('anon', p.oid, 'execute') as anon_x,
            has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
            has_function_privilege('service_role', p.oid, 'execute') as svc_x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [RUNTIME_FNS.concat(OWNER_FNS)]);
  const present = new Set(acl.rows.map((r: any) => r.proname));
  check("every 121 definer is in the catalog",
    RUNTIME_FNS.concat(OWNER_FNS).every((n) => present.has(n)), [...present]);
  for (const r of acl.rows) {
    // 110's rule, kept by 121: a trigger body is created by the owner and fired as the
    // inserting role, inside the statement that already runs pinned — so it is a plain
    // function on purpose, and only the privilege row below applies to it.
    if (r.proname === "action_needs_two_seats") {
      check(`${r.proname}: a trigger body, fired as the inserting role`,
        r.prosecdef === false, r);
      continue;
    }
    check(`${r.proname}: security definer with search_path pinned to public`,
      r.prosecdef === true && r.config === "search_path=public", r);
  }
  for (const r of priv.rows) {
    const runtime = RUNTIME_FNS.includes(r.proname);
    check(`${r.proname}: ${runtime ? "app_runtime may execute it" : "nobody but the owner may execute it"}, `
      + "and PUBLIC, anon, authenticated and service_role may not",
      r.app_x === runtime && !r.pub_x && !r.anon_x && !r.auth_x && !r.svc_x, r);
  }

  const overloads = await owner.query(
    `select pg_get_function_arguments(p.oid) as args from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'tenant_apply_action'`);
  check("the eight-argument door is gone: one tenant_apply_action, nine arguments",
    overloads.rows.length === 1
    && (overloads.rows[0].args.match(/,/g) ?? []).length === 8, overloads.rows);

  const pgcrypto = await one(
    `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'extensions' and p.proname = 'digest'`);
  check("pgcrypto's digest() is where 121 says it is, and the pin stays shut",
    Number(pgcrypto?.n ?? 0) > 0, pgcrypto);
  const inPublic = await one(
    `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'digest'`);
  check("…because digest() is not reachable from a search_path of public alone",
    Number(inPublic?.n ?? 0) === 0, inPublic);

  const duties = await one(
    `select (select coalesce(array_agg(key order by key), '{}') from permissions
             where key like 'control.approvals%') as keys,
            (select coalesce(array_agg(r.key order by r.key), '{}')
               from role_permissions rp join roles r on r.id = rp.role_id
              where rp.permission_key = 'control.approvals.view' and r.tenant_id is null) as readers,
            (select coalesce(array_agg(r.key order by r.key), '{}')
               from role_permissions rp join roles r on r.id = rp.role_id
              where rp.permission_key = 'control.approvals.decide' and r.tenant_id is null) as signers,
            (select coalesce(array_agg(r.key order by r.key), '{}')
               from role_permissions rp join roles r on r.id = rp.role_id
              where rp.permission_key = 'control.tenants.manage' and r.tenant_id is null) as managers`);
  check("both duty keys are seeded",
    duties.keys.includes("control.approvals.view")
    && duties.keys.includes("control.approvals.decide"), duties.keys);
  check("the seats that may sign a ban are exactly the seats that may ban",
    JSON.stringify(duties.signers) === JSON.stringify(duties.managers), duties);
  check("…and reading is wider than signing, so a seat can see what it cannot spend",
    duties.readers.length >= duties.signers.length
    && duties.signers.every((k: string) => duties.readers.includes(k)), duties);

  // ================================================================
  console.log("\n--- 2 · two seats, two companies, and one rolled-back transaction ---");

  const CT = randomUUID();       // the platform desk the seats belong to
  const TID = randomUUID();      // company one: the ban under test
  const TID2 = randomUUID();     // company two: the clock and the lapse
  const SEAT_A = randomUUID();   // raises
  const SEAT_B = randomUUID();   // signs
  const OUTSIDER = randomUUID(); // a staff seat: not a platform seat at all
  const ids = [CT, TID, TID2];

  await owner.query("begin");
  try {
    await owner.query(
      `insert into tenants (id, type, name, status) values
         ($1,'platform','121 verify desk (rolled back)','active'),
         ($2,'transporter','121 verify probe (rolled back)','active'),
         ($3,'transporter','121 verify probe 2 (rolled back)','active')`, [CT, TID, TID2]);
    const mail = (() => {
      const at = Date.now();
      return (who: string) => `v121.${who}.${at}@waisha.test`;
    })();
    await owner.query(
      `insert into users (id, tenant_id, user_type, full_name, email,
             email_normalized_search, status, totp_enabled)
       values ($1,$2,'platform','Ara Proposer',$4,$5,'active',false),
              ($3,$2,'platform','Bobo Signer',$6,$7,'active',false),
              ($8,$9,'staff','Nora Staff',$10,$11,'active',false)`,
      [SEAT_A, CT, SEAT_B, mail("a"), mail("a"), mail("b"), mail("b"),
      OUTSIDER, TID, mail("c"), mail("c")]);

    const propose = (action: string, target: string, payload: unknown, reason: string,
      who: string, role = "super_admin") =>
      one(PROPOSE_SQL, [action, "tenant", target, JSON.stringify(payload), reason,
        who, role, "127.0.0.1", "verify-approvals-sql"]).then((r: any) => r?.r);
    const decide = (id: string, decision: string, note: string, who: string,
      role = "compliance_officer") =>
      one(DECIDE_SQL, [id, decision, note, who, role, "127.0.0.1", "verify-approvals-sql"])
        .then((r: any) => r?.r);
    const claim = (id: string, who: string) =>
      one(CLAIM_SQL, [id, who]).then((r: any) => r?.r);
    const settle = (id: string, result: unknown) =>
      one(SETTLE_SQL, [id, JSON.stringify(result)]).then((r: any) => r?.r);
    const apply = (tenant: string, action: string, code: string, note: string,
      kind: string, who: string | null, role: string | null, approval: string | null) =>
      one(APPLY_SQL, [tenant, action, code, note, kind, who, role, "127.0.0.1", approval])
        .then((r: any) => r?.r);
    const board = (status: string | null, action: string | null = null, q: string | null = null,
      limit = 50, offset = 0) => one(BOARD_SQL, [status, action, q, limit, offset]).then((r: any) => r?.b);
    const detail = (id: string) => one(DETAIL_SQL, [id]).then((r: any) => r?.d);
    const stored = (id: string) => owner.query(
      `select payload, payload::text as bytes, payload_sha256, status, expires_at,
              proposed_by, decided_by
         from platform_approvals where id = $1`, [id]);

    const body = (extra: Record<string, unknown> = {}) => ({
      tenant_id: TID, reason_code: "complaint", note: NOTE, ...extra
    });

    // ----------------------------------------------------------------
    console.log("\n--- 3 · raising: only a platform seat, only a real company, only these bytes ---");

    check("a staff seat cannot raise a proposal at all",
      (await propose("tenant.block", TID, body(), ACT, OUTSIDER))?.status === "invalid");
    check("a reason too thin to defend is refused",
      (await propose("tenant.block", TID, body(), "nope", SEAT_A))?.status === "invalid");
    check("a payload naming another company than the target is refused",
      (await propose("tenant.block", TID, { ...body(), tenant_id: TID2 }, ACT, SEAT_A))?.status === "invalid");
    check("an invented reason code is refused",
      (await propose("tenant.block", TID, { ...body(), reason_code: "because_i_said" }, ACT, SEAT_A))?.status === "invalid");
    check("a note too short to be the sentence the company reads is refused",
      (await propose("tenant.block", TID, { ...body(), note: "bad" }, ACT, SEAT_A))?.status === "invalid");
    check("the platform desk is not a company and is refused",
      (await propose("tenant.block", CT, { tenant_id: CT, reason_code: "abuse", note: NOTE }, ACT, SEAT_A))?.status === "invalid");
    // The payload has to name the ghost too, or the question the definer answers is the
    // mismatch above, not the missing company.
    const ghost = randomUUID();
    check("a company that does not exist is not_found",
      (await propose("tenant.block", ghost,
        { tenant_id: ghost, reason_code: "complaint", note: NOTE }, ACT, SEAT_A))?.status === "not_found");
    check("an act with no apply path cannot be filed",
      (await propose("money.payout", TID, body(), ACT, SEAT_A))?.status === "invalid");

    const p1 = await propose("tenant.block", TID, body({ status: "active", actor_kind: "system" }),
      ACT, SEAT_A);
    check("a real proposal is filed as pending, with a hash and a week to live",
      p1?.status === "ok" && p1?.approval_status === "pending"
      && /^[0-9a-f]{64}$/.test(p1?.payload_sha256 ?? "")
      && new Date(p1?.expires_at).getTime() - Date.now() > 6 * 86_400_000, p1);
    const A1 = p1?.approval_id as string;

    const row1 = (await stored(A1)).rows[0];
    check("the payload a caller hands over is rebuilt by the definer: the overtyped keys are gone",
      JSON.stringify(Object.keys(row1.payload).sort()) === JSON.stringify(["note", "reason_code", "tenant_id"])
      && row1.payload.tenant_id === TID, row1.payload);
    check("the stored hash is provably the hash of the stored bytes",
      createHash("sha256").update(row1.bytes).digest("hex") === row1.payload_sha256,
      { bytes: row1.bytes, sha: row1.payload_sha256 });

    const dup = await propose("tenant.block", TID, body(), ACT, SEAT_A);
    check("a second proposal of the same act on the same company is a conflict, and it names the open one",
      dup?.status === "conflict" && dup?.open_id === A1, dup);
    const other = await propose("tenant.close", TID, body(),
      "The same company has to be closed rather than paused.", SEAT_A);
    check("…but a different act against the same company is its own decision",
      other?.status === "ok", other);
    const A2 = other?.approval_id as string;

    const pend = await board("pending");
    const ids = (pend?.rows ?? []).map((r: any) => String(r.id));
    // Both proposals were filed inside this one transaction, so `created_at` — which is
    // `now()`, the transaction timestamp — is identical for the two rows. Ordered on the
    // timestamp alone the board therefore has no answer to "newest first", and this gate
    // proved it by passing one run and failing the next. 122's `id desc` makes the order
    // total, so the assertions below are about that order rather than about which act was
    // filed second: they can only be made against a tie at all.
    check("the board shows both proposals, each with the seat that raised them",
      pend?.rows?.length === 2
      && pend?.rows?.every((r: any) => r.proposed_name === "Ara Proposer")
      && pend?.counts?.pending === 2, { rows: pend?.rows?.map((r: any) => r.action), c: pend?.counts });
    check("a timestamp tie still has one order, so the desk cannot be shown two answers",
      ids.every((id, i) => i === 0 || ids[i - 1] > id), ids);
    check("…and asking the same question again prints the same order",
      JSON.stringify((await board("pending"))?.rows?.map((r: any) => String(r.id)))
      === JSON.stringify(ids), ids);
    const pages = [
      String((await board("pending", null, null, 1, 0))?.rows?.[0]?.id),
      String((await board("pending", null, null, 1, 1))?.rows?.[0]?.id)
    ];
    check("…so two single-row pages show the register once, with nothing repeated or skipped",
      pages.every(p => p !== "undefined" && p !== "null")
      && new Set(pages).size === 2
      && JSON.stringify([...pages].sort()) === JSON.stringify([...ids].sort()), { pages, ids });
    check("…and every row carries the hash a second seat is asked to sign",
      pend?.rows?.every((r: any) => /^[0-9a-f]{64}$/.test(r.payload_sha256)), pend?.rows?.[0]);
    const found = await board(null, null, "shutting the door");
    check("the search box reads the note the proposer wrote, not only the reason",
      found?.rows?.some((r: any) => r.id === A1), found?.rows?.map((r: any) => r.id));

    // ----------------------------------------------------------------
    console.log("\n--- 4 · deciding: the rule, the floor, and the audit line ---");

    check("the seat that raised a proposal cannot sign it",
      (await decide(A1, "approve", SIGN, SEAT_A))?.status === "self");
    check("a signature with no sentence behind it is refused",
      (await decide(A1, "approve", "yes", SEAT_B))?.status === "invalid");
    check("nor can a seat that is not on the platform roster sign",
      (await decide(A1, "approve", SIGN, OUTSIDER))?.status === "invalid");
    check("a signature cannot be spent before it is released",
      (await claim(A1, SEAT_B))?.status === "conflict");

    const signed = await decide(A1, "approve", SIGN, SEAT_B);
    check("a second seat signs, and the answer says approved",
      signed?.status === "ok" && signed?.approval_status === "approved"
      && signed?.decided_name === "Bobo Signer" && signed?.proposed_by === SEAT_A, signed);
    check("a proposal cannot be decided twice",
      (await decide(A1, "approve", SIGN, SEAT_B))?.status === "conflict");
    const refused = await decide(A2, "reject", "Probe: refused on purpose.", SEAT_B);
    check("refusing is one call and it decides the row",
      refused?.status === "ok" && refused?.approval_status === "rejected", refused);
    check("…and a refused proposal is settled, so it cannot be reopened",
      (await decide(A2, "approve", SIGN, SEAT_B))?.status === "conflict");

    const aud = (await owner.query(
      `select action, actor_user_id, before, after from audit_logs
        where entity = 'platform_approvals' and entity_id = any($1::uuid[])`,
      [[A1, A2]])).rows;
    // Counted per step rather than read in order: `ts` is one value inside a transaction, so
    // four lines written in one pass have no sequence to assert. Who wrote each one does.
    const byAct = (a: string) => aud.filter((r: any) => r.action === a);
    const signedLine = byAct("approval.approve")[0];
    check("every step on the register leaves an audit line — proposed, approved, rejected",
      byAct("approval.proposed").length === 2 && byAct("approval.approve").length === 1
      && byAct("approval.reject").length === 1,
      aud.map((r: any) => `${r.action}/${r.actor_user_id === SEAT_A ? "raiser" : "signer"}`));
    check("…and the two steps are two seats: the raiser files, the signer decides",
      byAct("approval.proposed").every((r: any) => r.actor_user_id === SEAT_A)
      && [...byAct("approval.approve"), ...byAct("approval.reject")]
        .every((r: any) => r.actor_user_id === SEAT_B),
      aud.map((r: any) => `${r.action}/${r.actor_user_id === SEAT_A ? "raiser" : "signer"}`));
    check("…and the audit row carries the before and the after, not just a name",
      signedLine?.before?.status === "pending" && !!signedLine?.before?.proposed_by
      && signedLine?.after?.decided_name === "Bobo Signer"
      && /^[0-9a-f]{64}$/.test(signedLine?.after?.payload_sha256 ?? ""), signedLine);

    const gone = await detail(randomUUID());
    check("a deep link to a proposal that is not there says so",
      gone?.status === "not_found", gone);
    const d1 = await detail(A1);
    check("…and the detail read returns the same bytes the board does",
      d1?.approval_status === "approved" && d1?.payload_sha256 === row1.payload_sha256
      && d1?.decided_name === "Bobo Signer", d1);

    // ----------------------------------------------------------------
    console.log("\n--- 5 · spending: the effect is the only thing that can burn the signature ---");

    await owner.query("savepoint sp_unsigned");
    const unsigned = await owner.query(APPLY_SQL,
      [TID, "block", "complaint", NOTE, "control", SEAT_B, "compliance_officer", "127.0.0.1", null])
      .then(() => ({ err: null as string | null }))
      .catch((e) => ({ err: String(e.message) }));
    await owner.query("rollback to savepoint sp_unsigned");
    check("a control ban with no signature at all is refused by the trigger, in SQL",
      !!unsigned.err && /two-person signature/i.test(unsigned.err ?? "") && /approval_id/.test(unsigned.err ?? ""),
      unsigned.err);

    const p3 = await propose("tenant.block", TID2,
      { tenant_id: TID2, reason_code: "abuse", note: NOTE },
      "A second company, to prove an unsigned proposal is no key at all.", SEAT_A);
    await owner.query("savepoint sp_pending");
    const pendingKey = await owner.query(APPLY_SQL,
      [TID2, "block", "abuse", NOTE, "control", SEAT_B, "compliance_officer", "127.0.0.1", p3?.approval_id])
      .then(() => ({ err: null as string | null }))
      .catch((e) => ({ err: String(e.message) }));
    await owner.query("rollback to savepoint sp_pending");
    check("…and a signature that is only still waiting does not open the door either",
      !!pendingKey.err && /two-person signature/i.test(pendingKey.err ?? ""), pendingKey.err);

    check("only the seat that released a signature may spend it",
      (await claim(A1, SEAT_A))?.status === "unauthorised");
    const spent = await claim(A1, SEAT_B);
    check("the signing seat spends it once, and gets the payload back",
      spent?.status === "ok" && spent?.action === "tenant.block"
      && spent?.payload?.tenant_id === TID && spent?.payload?.note === NOTE, spent);
    check("…and a signature cannot be spent twice",
      (await claim(A1, SEAT_B))?.status === "conflict");

    const applied = await apply(TID, "block", "complaint", NOTE, "control", SEAT_B,
      "compliance_officer", A1);
    check("with a released signature the ban lands, and names the proposal behind it",
      applied?.status === "ok" && applied?.new_status === "suspended"
      && applied?.approval_id === A1 && !!applied?.action_id, applied);
    check("the effect tells the desk how many sessions it shut",
      applied?.sessions_revoked === 0, applied?.sessions_revoked);
    check("recording what the effect answered with lands on the signature",
      (await settle(A1, { action_id: applied?.action_id, new_status: applied?.new_status }))?.status === "ok");

    const after = await board("applied");
    const spentRow = after?.rows?.find((r: any) => r.id === A1);
    check("the board now reads the proposal as applied, with the register row it bought",
      spentRow?.approval_status === "applied" && !!spentRow?.applied_at
      && spentRow?.result?.action_id === applied?.action_id, spentRow);

    const reg = (await one(HISTORY_SQL, [TID, 20])).a;
    check("the company's register names both seats, not one",
      reg?.length === 1 && reg[0].action === "block" && reg[0].approval_id === A1
      && reg[0].raised_by === "Ara Proposer" && reg[0].signed_by === "Bobo Signer"
      && !!reg[0].signed_at, reg);

    const clock = await apply(TID2, "block", "long_idle", "Probe: the clock's own note.",
      "system", null, "system", null);
    check("the idle clock keeps its exemption: a timer has no second hand",
      clock?.status === "ok" && clock?.new_status === "suspended" && clock?.approval_id === null, clock);
    const reg2 = (await one(HISTORY_SQL, [TID2, 20])).a;
    check("…and its register row says the clock wrote it, with nobody behind it",
      reg2[0]?.actor_kind === "system" && reg2[0]?.approval_id === null
      && reg2[0]?.raised_by === null, reg2);

    check("an unblock is not a ban and stays a one-seat act",
      (await apply(TID, "unblock", "other", "Probe: opened again by the desk.",
        "control", SEAT_A, "super_admin", null))?.status === "ok");

    // The company now has two register rows, both born in this transaction, so they tie on
    // `created_at` exactly like the board's two proposals did. Same fix, same guarantee: a
    // desk that pages a company's history reads it in one order.
    const regBoth = (await one(HISTORY_SQL, [TID, 20])).a;
    check("a company's own register keeps a total order when its rows tie on the timestamp",
      regBoth?.length === 2
      && String(regBoth[0].id) > String(regBoth[1].id)
      && regBoth.map((r: any) => r.action).sort().join() === "block,unblock",
      regBoth?.map((r: any) => ({ id: r.id, action: r.action, ts: r.created_at })));

    // ----------------------------------------------------------------
    console.log("\n--- 6 · a proposal nobody signs must not sit open forever ---");

    // `expires_at > proposed_at` is a CHECK, so aging a proposal means moving its birth back
    // with it — the same shape a week of real waiting produces, and the only way to ask the
    // question inside one transaction that lasts seconds.
    const expire = (id: string) => owner.query(
      `update platform_approvals set proposed_at = now() - interval '8 days',
               expires_at = now() - interval '1 hour', created_at = now() - interval '8 days'
         where id = $1`, [id]);

    const p4 = await propose("tenant.close", TID2,
      { tenant_id: TID2, reason_code: "long_idle", note: NOTE },
      "Filed to prove that an unsigned proposal lapses before it can be signed.", SEAT_A);
    await expire(p4?.approval_id);
    check("signing after the window answers lapsed rather than spending it",
      (await decide(p4?.approval_id, "approve", SIGN, SEAT_B))?.status === "lapsed");
    check("…and the row itself says lapsed",
      (await stored(p4.approval_id)).rows[0].status === "lapsed");
    check("…and a lapsed proposal cannot be decided afterwards",
      (await decide(p4?.approval_id, "approve", SIGN, SEAT_B))?.status === "conflict");

    // A second one, expired the same way but never put in front of a decider: only the
    // board read can retire it, which is why there is no sweeper to schedule for expiry.
    const p5 = await propose("tenant.close", TID,
      { tenant_id: TID, reason_code: "other", note: NOTE },
      "Filed and left alone, to be retired by whoever looks at the register.", SEAT_A);
    await expire(p5?.approval_id);
    const afterRead = await board("pending");
    check("the board retires an expired proposal the moment it is read",
      !afterRead?.rows?.some((r: any) => r.id === p5?.approval_id)
      && (await stored(p5.approval_id)).rows[0].status === "lapsed", afterRead?.rows);
    check("…and nothing that is still waiting is already out of time",
      afterRead?.rows?.every((r: any) => new Date(r.expires_at).getTime() > Date.now()),
      afterRead?.rows?.map((r: any) => r.expires_at));
    const all = await board(null);
    check("…with the lapses counted, so the desk can see why a signature is missing",
      (all?.counts?.lapsed ?? 0) >= 2 && (all?.counts?.pending ?? 0) >= 1, all?.counts);

    const freed = await propose("tenant.close", TID2,
      { tenant_id: TID2, reason_code: "long_idle", note: NOTE },
      "Filed again after the first one lapsed, which the open slot now allows.", SEAT_A);
    check("a lapsed proposal frees its target for a second opinion",
      freed?.status === "ok", freed);

    // ================================================================
    await owner.query("rollback");
  } catch (e) {
    await owner.query("rollback").catch(() => { });
    check("the write probes rolled back cleanly", false, String(e).slice(0, 400));
  }

  const residue = await one(
    `select (select count(*)::int from tenants where id = any($1::uuid[])) as tenants,
            (select count(*)::int from users where tenant_id = any($1::uuid[])) as seats,
            (select count(*)::int from platform_approvals where target_id = any($1::text[])) as proposals,
            (select count(*)::int from tenant_actions where tenant_id = any($1::uuid[])) as actions,
            (select count(*)::int from audit_logs where tenant_id = any($1::uuid[])) as audit`,
    [ids.concat([TID, TID2].map(String))]);
  check("nothing survives the probe: no seat, company, proposal, register row or audit line",
    residue.tenants === 0 && residue.seats === 0 && residue.proposals === 0
    && residue.actions === 0 && residue.audit === 0, residue);
  const liveBoard = (await one(BOARD_SQL, [null, null, null, 100, 0])).b;
  check("the live register is untouched by any of it",
    !liveBoard?.rows?.some((r: any) => /rolled back/.test(String(r.target_name))),
    liveBoard?.rows?.map((r: any) => r.target_name));

  await owner.end();

  // ================================================================
  console.log("\n--- 7 · the same doors, as the role that actually runs them ---");

  const app = appUrl();
  if (!app) {
    console.log("skip  app_runtime probe (no APP_DB_PASSWORD / APP_DATABASE_URL)");
  } else {
    const runtime = new pg.Client({ connectionString: app, ssl: { rejectUnauthorized: false } });
    await runtime.connect();
    // One transaction per probe, always rolled back. Two reasons, both learned the hard way:
    // a refused statement aborts its transaction and every later query in it answers
    // "current transaction is aborted" instead of the thing under test, and 121's board
    // retires expired proposals as it is read — so a read-only transaction would answer the
    // read-only rule rather than the grant question, and an unrolled one would write.
    const probe = async (sql: string, p: any[] = []) => {
      await runtime.query("begin");
      const out = await runtime.query(sql, p)
        .then((r) => r.rows[0] as any).catch((e) => ({ err: String(e.message) }));
      await runtime.query("rollback");
      return out;
    };

    const b = await probe(BOARD_SQL, ["pending", null, null, 5, 0]);
    check("app_runtime can read the board", !b.err, b.err);
    const c = await probe("select platform_auth.count_open_approvals() as n");
    check("…and the open count a later advisory line reads", !c.err, c.err);
    const d = await probe(DETAIL_SQL, [randomUUID()]);
    check("…and a deep link to one proposal", !d.err, d.err);
    const denied = await probe("select * from platform_approvals limit 1");
    check("but it cannot read the register table itself",
      !!denied.err && /permission denied/i.test(denied.err), denied.err);

    // Reaching `not_found` proves EXECUTE was granted, and the row it names does not exist,
    // so the probe cannot write anything whatever the definer decides.
    const cl = await probe(CLAIM_SQL, [randomUUID(), randomUUID()]);
    check("…and may attempt a claim, which answers not_found rather than permission denied",
      !cl.err && cl.r?.status === "not_found", cl.err ?? cl);
    // Every column the forged row would need, bound as parameters: the refusal this probe
    // wants is the table grant, and it has to arrive before any check on the values.
    const forged = await probe(
      `insert into platform_approvals (action, target_kind, target_id, payload, payload_sha256,
           reason, status, proposed_by, expires_at)
       values ('tenant.block','tenant',$1,'{}'::jsonb,$2,$3,'pending',$4, now() + interval '7 days')`,
      [randomUUID(), "0".repeat(64), "A forged signature, minted by a handler.", randomUUID()]);
    check("…but it cannot file a proposal by hand, so no handler can mint a signature",
      !!forged.err && /permission denied/i.test(forged.err), forged.err);
    await runtime.end();
  }

  console.log(`\n${failures ? "FAILURES: " + failures : "121 and 122 verified."}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
