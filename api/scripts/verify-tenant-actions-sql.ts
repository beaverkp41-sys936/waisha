/**
 * Live proof for #127 — the seat ladder, the action register and the gate behind them
 * (migrations 078, 079, 080, 081) and for the signature a ban now stands on (121).
 *
 * Same rule 066 established and 068 re-proved: EXPLAIN cannot see inside a SECURITY
 * DEFINER body, so a function that licenses the wrong seat count, answers a duplicate
 * jsonb key, or leaves a closed company visible to nobody is only caught by running it.
 * The posture half is read out of the catalog as the owner; the execution half runs the
 * exported statements from the routes as app_runtime.
 *
 * The write probes create a company INSIDE their own transaction and roll it back. That
 * matters more here than in the revenue verify: `tenant_apply_action` suspends a tenant,
 * revokes its sessions and writes an append-only register row, and none of those may
 * survive a script whose only job is to read the shape of the thing. Nothing outside the
 * transaction can see the fixture, and after the rollback nothing at all can.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-tenant-actions-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { BLOCK_STATE_SQL, SUSPENSIONS_SQL } from "../src/security/tenant-state.js";
import { CANDIDATES_SQL, APPLY_SQL, RECEIPT_SQL } from "../src/util/tenant-policy.js";
import { DECIDE_SQL, PROPOSE_SQL } from "../src/control/approvals.js";
import { HISTORY_SQL } from "../src/routes/control-tenants.routes.js";

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
  "tenant_apply_action", "tenant_action_receipt", "tenant_policy_candidates",
  "control_tenant_actions", "tenant_block_state", "tenant_suspensions",
  "manual_activate", "list_tenants_for_control"
];

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();

  // ================================================================
  console.log("\n--- 1 · the catalog posture a handler must not be able to talk around ---");

  const shape = await owner.query(
    `select c.relname, c.relrowsecurity, c.relpersistence,
            (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
            (select string_agg(privilege_type, ',' order by privilege_type)
               from information_schema.table_privileges tp
              where tp.table_name = c.relname and tp.grantee in ('app_runtime','public','anon','authenticated'))
              as granted
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'tenant_actions'`);
  const ta = shape.rows[0] ?? {};
  check("tenant_actions exists with row security on", ta.relrowsecurity === true, ta);
  check("…and zero policies, because nothing is meant to be readable through RLS",
    Number(ta.policies) === 0, ta.policies);
  check("…and no table grant to app_runtime, public, anon or authenticated",
    !ta.granted, ta.granted);

  const acl = await owner.query(
    `select p.proname, p.prosecdef,
            coalesce(nullif(array_to_string(p.proconfig, ','), ''), '(unset)') as config,
            has_function_privilege('app_runtime', p.oid, 'execute') as app_x,
            has_function_privilege('public', p.oid, 'execute') as pub_x,
            has_function_privilege('anon', p.oid, 'execute') as anon_x,
            has_function_privilege('authenticated', p.oid, 'execute') as auth_x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)
      order by p.proname`, [DEFINERS]);
  // A name can appear twice — manual_activate still has its pre-078 overload — and both
  // copies have to be locked down, so the per-row check below walks every one.
  const present = new Set(acl.rows.map((r) => r.proname));
  check("every #127 definer is present in the catalog",
    DEFINERS.every((n) => present.has(n)), acl.rows.map((r) => `${r.proname}/${r.app_x}`));
  for (const r of acl.rows) {
    check(`${r.proname}: definer, search_path pinned, app_runtime only`,
      r.prosecdef === true && r.config === "search_path=public" && r.app_x === true
      && r.pub_x === false && r.anon_x === false && r.auth_x === false, r);
  }

  // The 078 regression 079 closed, and 081 had to keep closed: a drop-and-recreate
  // resets the ACL to PUBLIC EXECUTE, so this is a check that has to be re-run every
  // time one of these bodies is re-declared, not a check that ever passes on its own.
  const publicExec = acl.rows.filter((r) => r.pub_x).map((r) => r.proname);
  check("none of them is executable by PUBLIC", publicExec.length === 0, publicExec);

  const colChecks = await owner.query(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'tenant_actions'::regclass and contype = 'c'`);
  const defs = colChecks.rows.map((r) => r.def);
  check("the register constrains the action, the reason and the actor",
    defs.some((d) => d.includes("'block'") && d.includes("'close'"))
    && defs.some((d) => d.includes("'terms_violation'"))
    && defs.some((d) => d.includes("'control'") && d.includes("'system'")), defs);
  check("a note has a floor as well as a ceiling",
    defs.some((d) => /char_length\(TRIM\(BOTH FROM note\)\) >= 8/.test(d)
      && /char_length\(TRIM\(BOTH FROM note\)\) <= 600/.test(d)), defs);

  // ================================================================
  console.log("\n--- 2 · the seat ladder, on a company that rolls back ---");

  // The gate's snapshot is not empty on a development database: the office has closed
  // companies by hand here, and those rows are other people's work. So every assertion
  // below about the snapshot measures this script against the set it found, not against an
  // empty table. What the script may not do is add to it — before or after the rollback.
  const baseline = new Set<string>(((await owner.query(SUSPENSIONS_SQL)).rows[0].s as any[])
    .map((x) => x.tenant_id));

  const tid = randomUUID();
  const tid2 = randomUUID();
  const subId = randomUUID();
  const desk = randomUUID();
  const seatA = randomUUID();
  const seatB = randomUUID();
  const actor = (await owner.query(
    `select id from users where user_type = 'platform' and status = 'active' limit 1`)).rows[0]?.id ?? null;

  await owner.query("begin");
  try {
    // 121: a control-actor block is refused by a trigger unless a released two-seat
    // signature stands behind it, so this script needs two platform seats of its own. They
    // are made here, in the same transaction as everything else, and rolled back with it —
    // borrowing real seats would leave a proposal nobody raised sitting against a real
    // company the moment a probe failed half-way.
    await owner.query(
      `insert into tenants (id, type, name, status) values ($1,'platform','081 verify desk (rolled back)','active')`,
      [desk]);
    await owner.query(
      `insert into users (id, tenant_id, user_type, full_name, email,
             email_normalized_search, status, totp_enabled)
       values ($1,$2,'platform','Vera Raiser',$4,$5,'active',false),
              ($3,$2,'platform','Wesley Signer',$6,$7,'active',false)`,
      [seatA, desk, seatB, `v081.a.${Date.now()}@waisha.test`, `v081.a.${Date.now()}@waisha.test`,
      `v081.b.${Date.now()}@waisha.test`, `v081.b.${Date.now()}@waisha.test`]);

    /**
     * The signature a control ban now has to stand on: raised by one seat, released by the
     * other, spent by the second. `verify-approvals-sql.ts` proves that machinery line by
     * line; here it only exists so the register and the gate can be run at all.
     */
    const release = async (tenant: string, act: string, code: string, note: string) => {
      const p = (await owner.query(PROPOSE_SQL, [
        `tenant.${act}`, "tenant", tenant,
        JSON.stringify({ tenant_id: tenant, reason_code: code, note }),
        "Probe: the two seats behind this ban.", seatA, "super_admin", "127.0.0.1", "verify"
      ])).rows[0].r;
      if (p?.status !== "ok") throw new Error(`proposal refused: ${JSON.stringify(p)}`);
      const d = (await owner.query(DECIDE_SQL,
        [p.approval_id, "approve", "Probe: signed by the second seat.", seatB,
        "compliance_officer", "127.0.0.1", "verify"])).rows[0].r;
      if (d?.status !== "ok") throw new Error(`signature refused: ${JSON.stringify(d)}`);
      return p.approval_id as string;
    };
    await owner.query(
      `insert into tenants (id, type, name, status, licence_expires_at)
       values ($1,'transporter',$2,'active', now() + interval '30 days')`,
      [tid, "081 verify probe (rolled back)"]);
    await owner.query(
      `insert into subscriptions (id, tenant_id, plan_id, billing_cycle, status, seats_licensed,
               current_period_start, current_period_end)
       values ($1,$2,(select id from plans where key='starter'),'monthly','active',1,
               now(), now() + interval '30 days')`, [subId, tid]);

    const up = (await owner.query(
      `select platform_auth.manual_activate($1,'enterprise','monthly','bank',$2,null,$3,null) as r`,
      [tid, `VER-${Date.now()}`, actor])).rows[0].r;
    check("selling Enterprise licenses 100 seats over a legacy 1",
      up.status === "ok" && up.seats === 100, up);

    const down = (await owner.query(
      `select platform_auth.manual_activate($1,'starter','monthly','bank',$2,null,$3,null) as r`,
      [tid, `VER2-${Date.now()}`, actor])).rows[0].r;
    check("re-selling Starter keeps the 100 seats already paid for",
      down.status === "ok" && down.seats === 100, down);

    const lic = (await owner.query(
      `select platform_auth.get_licence($1) as l`, [tid])).rows[0].l;
    check("the licence the app reads is the one that was sold",
      lic.seats_licensed === 100 && lic.plan_key === "starter", lic);

    const st100 = (await owner.query(
      `select s.seats_licensed from subscriptions s where s.tenant_id = $1 and s.deleted_at is null`,
      [tid])).rows[0].seats_licensed;
    check("and the row agrees with it", st100 === 100, st100);

    // ----------------------------------------------------------------
    console.log("\n--- 3 · the register and the gate, on the same rolled-back company ---");

    const banNote = "Probe: the register must keep a real sentence.";
    const signed = await release(tid, "block", "terms_violation", banNote);
    const blocked = (await owner.query(APPLY_SQL,
      [tid, "block", "terms_violation", banNote,
      // The seat that signed is the seat the register names as its author, and the
      // proposal it signed is on the row beside it (121).
      "control", seatB, "compliance_officer", "127.0.0.1", signed])).rows[0].r;
    check("a control ban lands when a released signature stands behind it",
      blocked.status === "ok" && blocked.approval_id === signed,
      { status: blocked.status, approval_id: blocked.approval_id });
    // 081: the payload used to carry two keys called 'status', and the second one — the
    // tenant's new status — won. Every successful act therefore looked like a refusal.
    check("tenant_apply_action answers with one status key, and it says ok",
      blocked.status === "ok" && blocked.new_status === "suspended"
      && blocked.prior_status === "active" && !!blocked.action_id,
      { status: blocked.status, new_status: blocked.new_status });
    check("the block revokes nothing that is not there, and names its register row",
      blocked.sessions_revoked === 0 && blocked.tenant_name === "081 verify probe (rolled back)",
      { r: blocked.sessions_revoked, n: blocked.tenant_name });
    check("a block returns the seats the company holds, for the desk to read back",
      blocked.seats_licensed === 100, blocked.seats_licensed);

    const state = (await owner.query(BLOCK_STATE_SQL, [tid])).rows[0].s;
    check("tenant_block_state reports the suspension with its reason and note",
      state?.reason_code === "terms_violation" && state?.closed === false
      && !!state?.since && !!state?.by, state);
    const susp = (await owner.query(SUSPENSIONS_SQL)).rows[0].s as any[];
    check("the gate's snapshot holds this company and adds no other",
      susp.some((x) => x.tenant_id === tid)
      && susp.filter((x) => !baseline.has(x.tenant_id)).every((x) => x.tenant_id === tid),
      susp.filter((x) => !baseline.has(x.tenant_id)));

    const receipt = (await owner.query(RECEIPT_SQL,
      [blocked.action_id, JSON.stringify({ subject: "probe", recipients: 1 })])).rows[0].r;
    check("a delivery receipt lands on the register row", receipt.status === "ok", receipt);
    const again = (await owner.query(RECEIPT_SQL,
      [blocked.action_id, JSON.stringify({ subject: "rewritten" })])).rows[0].r;
    check("…and cannot be rewritten afterwards", again.status === "noop", again);
    const history = (await owner.query(HISTORY_SQL, [tid, 20])).rows[0].a;
    check("the desk reader returns the row with its receipt",
      history.length === 1 && history[0].action === "block"
      && history[0].delivery?.subject === "probe", history);
    check("…and names the two seats the ban stands on, not just the one that pressed it",
      history[0].approval_id === signed && history[0].raised_by === "Vera Raiser"
      && history[0].signed_by === "Wesley Signer" && !!history[0].signed_at, history);

    const second = (await owner.query(APPLY_SQL,
      [tid, "block", "abuse", "A second block on a company already suspended.",
      "control", seatB, "compliance_officer", null, signed])).rows[0].r;
    check("a second block is a conflict, not a second suspension",
      second.status === "conflict", second);
    // Both refused by the definer before it ever reaches the register table, which is why a
    // null signature is enough to ask the question: the trigger is not what stops them.
    const bad = (await owner.query(APPLY_SQL,
      [tid, "block", "terms_violation", "short", "control", seatB, "compliance_officer", null, null])).rows[0].r;
    check("a note too thin to defend is refused before anything is written",
      bad.status === "invalid", bad);
    const ghost = (await owner.query(APPLY_SQL,
      [randomUUID(), "block", "abuse", "A company that does not exist at all.",
      "control", seatB, "compliance_officer", null, null])).rows[0].r;
    check("an unknown company is not_found", ghost.status === "not_found", ghost);

    const unblocked = (await owner.query(APPLY_SQL,
      [tid, "unblock", "other", "Probe cleanup: put it back where it was found.",
      "control", seatA, "super_admin", null, null])).rows[0].r;
    check("unblock restores the status the block found, and needs no second seat",
      unblocked.status === "ok" && unblocked.new_status === "active", unblocked);
    check("…and the company leaves the gate's snapshot",
      !(await owner.query(SUSPENSIONS_SQL)).rows[0].s.some((x: any) => x.tenant_id === tid),
      (await owner.query(SUSPENSIONS_SQL)).rows[0].s.filter((x: any) => x.tenant_id === tid));

    // ----------------------------------------------------------------
    console.log("\n--- 4 · the idle clock's own arithmetic ---");

    // The override rule first, on the company the desk just unblocked: a lapse the office
    // has already waived must not start the clock again. The candidate query measures the
    // idle window from the newest of licence, subscription and registration, and then
    // stands down if an unblock is dated after that — so pushing this company's expiry
    // into the past has to leave the list empty.
    await owner.query(
      `update tenants set licence_expires_at = now() - interval '46 days' where id = $1`, [tid]);
    await owner.query(
      `update subscriptions set current_period_end = now() - interval '46 days' where id = $1`, [subId]);
    const waived = (await owner.query(CANDIDATES_SQL, [45, 90])).rows[0].c;
    check("a company the desk unblocked is off the clock until a later lapse",
      waived.length === 0, waived);

    // The clock itself needs a company with no decisions on it, so a second one is made
    // for it — same transaction, same rollback.
    await owner.query(
      `insert into tenants (id, type, name, status, licence_expires_at)
       values ($1,'transporter',$2,'active', now() - interval '46 days')`,
      [tid2, "081 verify probe 2 (rolled back)"]);
    const sub2 = (await owner.query(
      `insert into subscriptions (tenant_id, plan_id, billing_cycle, status, seats_licensed,
           current_period_start, current_period_end)
       values ($1,(select id from plans where key='starter'),'monthly','grace',5,
               now() - interval '46 days', now() - interval '46 days')
       returning id`, [tid2])).rows[0].id;

    const cand = (await owner.query(CANDIDATES_SQL, [45, 90])).rows[0].c;
    check("at six weeks without a licence the clock asks for a block",
      cand.length === 1 && cand[0].tenant_id === tid2 && cand[0].action === "block"
      && cand[0].days_idle >= 45, cand);
    const swept = (await owner.query(APPLY_SQL,
      [tid2, "block", "long_idle", "Probe: the clock's own note.",
      // A timer has no second hand, and 121's trigger reads exactly that: the exemption is
      // on `actor_kind`, not on the act, so the sweep stays automatic with a null signature.
      "system", null, "system", null, null])).rows[0].r;
    check("the clock's act is recorded as the clock's act",
      swept.status === "ok" && swept.new_status === "suspended", swept);
    const regSwept = (await owner.query(HISTORY_SQL, [tid2, 5])).rows[0].a;
    check("…with the system as its author and no human claimed behind it",
      regSwept[0].actor_kind === "system" && regSwept[0].actor_role === "system"
      && regSwept[0].approval_id === null, regSwept);
    const cand2 = (await owner.query(CANDIDATES_SQL, [45, 90])).rows[0].c;
    check("a suspended company is not asked to be suspended again",
      cand2.length === 0, cand2);

    await owner.query(
      `update tenants set licence_expires_at = now() - interval '91 days' where id = $1`, [tid2]);
    await owner.query(
      `update subscriptions set current_period_end = now() - interval '91 days' where id = $1`, [sub2]);
    const cand3 = (await owner.query(CANDIDATES_SQL, [45, 90])).rows[0].c;
    check("at three months the same list asks for a close",
      cand3.length === 1 && cand3[0].action === "close" && cand3[0].days_idle >= 90, cand3);
    const closed = (await owner.query(APPLY_SQL,
      [tid2, "close", "long_idle", "Probe: past the three-month window.",
      "system", null, "system", null, null])).rows[0].r;
    check("a close suspends as well as tombstones, so no window can widen later",
      closed.status === "ok" && closed.new_status === "suspended" && closed.closed === true, closed);
    const closedState = (await owner.query(BLOCK_STATE_SQL, [tid2])).rows[0].s;
    check("the gate still sees a closed company, and calls it withdrawn",
      closedState?.closed === true && closedState?.reason_code === "long_idle", closedState);
    // Refused by the definer's own state read — the company is tombstoned — before the
    // register is touched, so an unblock never gets far enough to need a signature.
    const afterClose = (await owner.query(APPLY_SQL,
      [tid2, "unblock", "other", "Trying to reopen a company the clock closed.",
      "control", actor, "super_admin", null, null])).rows[0].r;
    check("once closed, no action reaches the company again",
      afterClose.status === "not_found", afterClose);
    const cand4 = (await owner.query(CANDIDATES_SQL, [45, 90])).rows[0].c;
    check("…and it is off the idle list for good", cand4.length === 0, cand4);
    const withdrawn = (await owner.query(SUSPENSIONS_SQL)).rows[0].s
      .find((x: any) => x.tenant_id === tid2);
    check("the snapshot carries the closed one, with the withdrawn flag",
      withdrawn?.state?.closed === true && withdrawn?.state?.reason_code === "long_idle",
      withdrawn);

    await owner.query("rollback");
  } catch (e) {
    await owner.query("rollback").catch(() => { });
    check("the write probes rolled back cleanly", false, String(e).slice(0, 300));
  }

  const residue = await owner.query(
    `select (select count(*) from tenants where id = any($1::uuid[])) as tenant,
            (select count(*) from tenant_actions where tenant_id = any($1::uuid[])) as actions,
            (select count(*) from subscriptions where tenant_id = any($1::uuid[])) as subs,
            (select count(*) from invoices where tenant_id = any($1::uuid[])) as invoices,
            (select count(*) from audit_logs where tenant_id = any($1::uuid[])) as audit,
            (select count(*) from platform_approvals
              where proposed_by = any($2::uuid[]) or decided_by = any($2::uuid[])) as approvals,
            (select count(*) from users where id = any($2::uuid[])) as seats`,
    [[tid, tid2, desk], [seatA, seatB]]);
  check("nothing survives the probe: no company, seat, register row, signature, licence, "
    + "invoice or audit row",
    residue.rows[0].tenant === "0" && residue.rows[0].actions === "0"
    && residue.rows[0].subs === "0" && residue.rows[0].invoices === "0"
    && residue.rows[0].audit === "0" && residue.rows[0].approvals === "0"
    && residue.rows[0].seats === "0", residue.rows[0]);

  const liveSusp = (await owner.query(`select platform_auth.tenant_suspensions() as s`))
    .rows[0].s as any[];
  // The honest version of "nothing is shut": this script may not be what shut it. Companies
  // the office closed by hand are allowed to be in the snapshot; a probe company is not.
  check("no company this probe made is left suspended or closed",
    !liveSusp.some((x) => x.tenant_id === tid || x.tenant_id === tid2)
    && liveSusp.every((x) => baseline.has(x.tenant_id)),
    liveSusp.filter((x) => !baseline.has(x.tenant_id)));
  console.log(`     (${liveSusp.length} companies were already shut on this database before the probe ran.)`);
  const liveCand = await owner.query(`select platform_auth.tenant_policy_candidates(45,90) as c`);
  check("and none is a candidate for the idle clock, so a sweep today changes nothing",
    (liveCand.rows[0].c as any[]).length === 0, liveCand.rows[0].c);

  await owner.end();

  // ================================================================
  console.log("\n--- 5 · the exported statements, as the role that actually runs them ---");

  const app = appUrl();
  if (!app) {
    console.log("skip  app_runtime probe (no APP_DB_PASSWORD / APP_DATABASE_URL)");
  } else {
    const runtime = new pg.Client({ connectionString: app, ssl: { rejectUnauthorized: false } });
    await runtime.connect();
    await runtime.query("begin");
    await runtime.query("set transaction read only");
    for (const [label, sql, params] of [
      ["tenant_block_state", BLOCK_STATE_SQL, [randomUUID()]],
      ["tenant_suspensions", SUSPENSIONS_SQL, []],
      ["tenant_policy_candidates", CANDIDATES_SQL, [45, 90]],
      ["control_tenant_actions", HISTORY_SQL, [randomUUID(), 5]]
    ] as [string, string, any[]][]) {
      const r = await runtime.query(sql, params).catch((e) => ({ err: String(e.message) } as any));
      check(`app_runtime can execute ${label}`, !r.err, r.err ?? "");
    }
    const denied = await runtime.query("select * from tenant_actions limit 1").then(() => null)
      .catch((e) => String(e.message));
    check("app_runtime still cannot read the register table itself",
      !!denied && /permission denied/i.test(denied), denied);
    await runtime.query("rollback");
    await runtime.end();
  }

  console.log(`\n${failures ? "FAILURES: " + failures : "081 verified."}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
