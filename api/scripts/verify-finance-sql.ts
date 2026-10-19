/**
 * SQL validation for finance.routes.ts and migration 090.
 *
 * Two halves, because the module has two kinds of promise:
 *
 *  A. every statement the desk can issue is PLANNED against the live schema as
 *     `app_runtime` (EXPLAIN, no writes). The statements are imported from the
 *     route file itself, so this gate proves the SQL the route actually sends and
 *     not a paraphrase of it.
 *
 *  B. the return register's gates are RUN for real — each one inside a savepoint,
 *     with the whole transaction rolled back at the end, so nothing survives. A
 *     "filed return is immutable" rule that has never been broken on purpose is a
 *     rule nobody has checked.
 *
 * Run: npx tsx scripts/verify-finance-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import {
  CASH_OUT_SQL, CASH_SQL, CUSTOMERS_SQL, DSO_SQL, FOREIGN_SQL, PAYABLE_SQL, POSITION_SQL,
  RATES_LINES_SQL, RATES_VERSION_SQL, RECEIVABLE_SQL, RETURN_SELECT_SQL,
  SCHEDULE_SQL, SPEND_SQL, SUPPLIERS_SQL, TREND_SQL
} from "../src/routes/finance.routes.js";

const FAKE_TENANT = "00000000-0000-7000-8000-0000000000fe";
const FAKE_USER = "11111111-1111-7111-8111-1111111111fe";
const FROM = "2026-09-01";
const TO = "2026-09-30";
const FROM2 = "2026-08-01";
const TO2 = "2026-08-31";
const FROM3 = "2026-07-01";
const TO3 = "2026-07-31";
const FUTURE = "2099-01-01";

let failed = 0;
function ok(label: string, detail?: unknown) {
  console.log("ok   ", label, detail === undefined ? "" : `(${String(detail)})`);
}
function bad(label: string, detail: unknown) {
  console.log("FAIL ", label, "-", String(detail).slice(0, 220));
  failed++;
}

// ---------------------------------------------------------------------------
// A. The statements the desk reads with, planned as the runtime role.
// ---------------------------------------------------------------------------
async function planGate() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL, max: 1,
    ssl: { rejectUnauthorized: false }
  });
  await pool.query(`select set_config('app.tenant_id', $1, false)`, [FAKE_TENANT]);

  const three = [FAKE_TENANT, FROM, TO];
  const checks: [string, string, unknown[]][] = [
    ["tax position", POSITION_SQL, three],
    ["invoice schedule", SCHEDULE_SQL, three],
    ["receivable + ageing", RECEIVABLE_SQL, [FAKE_TENANT]],
    ["payable", PAYABLE_SQL, [FAKE_TENANT]],
    ["cash in", CASH_SQL, three],
    ["cash out", CASH_OUT_SQL, three],
    ["days to collect", DSO_SQL, three],
    ["billing trend", TREND_SQL, three],
    ["spend trend", SPEND_SQL, three],
    ["top customers", CUSTOMERS_SQL, three],
    ["top suppliers", SUPPLIERS_SQL, three],
    ["foreign paper, in period", FOREIGN_SQL, three],
    ["foreign paper, whole company", FOREIGN_SQL, [FAKE_TENANT, null, null]],
    ["rates version", RATES_VERSION_SQL, []],
    ["rates lines", RATES_LINES_SQL, ["TRA 2025/26"]],
    ["return list", RETURN_SELECT_SQL +
      " where t.tenant_id = $1 and t.deleted_at is null" +
      " and ($2::text is null or t.kind = $2) and ($3::text is null or t.status = $3)" +
      " order by t.period_start desc, t.created_at desc limit $4",
    [FAKE_TENANT, null, null, 60]],
    ["return by id", RETURN_SELECT_SQL +
      " where t.id = $1 and t.tenant_id = $2 and t.deleted_at is null",
    ["99999999-9999-7999-8999-999999999999", FAKE_TENANT]],
    ["open return for a period",
      "select id, status, basis, net_payable::text as net_payable from tax_returns" +
      " where tenant_id = $1 and kind = $2 and deleted_at is null and status <> 'filed'" +
      " and period_start = $3::date and period_end = $4::date" +
      " order by created_at desc limit 1",
      [FAKE_TENANT, "vat", FROM, TO]]
  ];

  for (const [label, sql, params] of checks) {
    try {
      await pool.query("explain " + sql, params);
      ok(`plan ${label}`);
    } catch (e: any) {
      bad(`plan ${label}`, e.message);
    }
  }

  // The register's own shape, read back rather than assumed.
  const grants = await pool.query(
    `select has_table_privilege('app_runtime','tax_returns','select') as s,
            has_table_privilege('app_runtime','tax_returns','insert') as i,
            has_table_privilege('app_runtime','tax_returns','update') as u,
            has_table_privilege('app_runtime','tax_returns','delete') as d,
            relrowsecurity from pg_class where relname = 'tax_returns'`);
  const g = grants.rows[0];
  if (g.s && g.i && g.u && !g.d && g.relrowsecurity) ok("grants", "select+insert+update, no delete, RLS on");
  else bad("grants", JSON.stringify(g));

  const keys = await pool.query(
    `select p.key, array_agg(r.key order by r.key) as roles from permissions p
       join role_permissions rp on rp.permission_key = p.key
       join roles r on r.id = rp.role_id
      where p.key in ('finance.view','tax.view','tax.prepare','tax.file') and r.tenant_id is null
      group by p.key order by p.key`);
  const seen = Object.fromEntries(keys.rows.map((r: any) => [r.key, r.roles as string[]]));
  const readers = ["auditor", "director", "finance_officer", "general_manager"];
  const want: [string, string[]][] = [
    ["finance.view", readers],
    ["tax.view", readers],
    ["tax.prepare", ["director", "finance_officer"]],
    ["tax.file", ["director", "finance_officer"]]
  ];
  for (const [key, roles] of want) {
    const got = (seen[key] ?? []).slice().sort();
    if (JSON.stringify(got) === JSON.stringify(roles)) ok(`matrix ${key}`, got.join(", "));
    else bad(`matrix ${key}`, `held ${JSON.stringify(got)}`);
  }
  // The desk is built for the finance seat, so the dashboard door has to be a key
  // that seat actually holds — this is the assertion that caught it riding on
  // invoices.view, which only the director and the auditor have.
  if ((seen["finance.view"] ?? []).includes("finance_officer")) ok("the finance officer can open the dashboard");
  else bad("the finance officer can open the dashboard", JSON.stringify(seen["finance.view"]));

  await pool.end();
}

// ---------------------------------------------------------------------------
// B. The gates, broken on purpose, inside one transaction that is thrown away.
// ---------------------------------------------------------------------------
async function gateRuns() {
  const c = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await c.connect();
  await c.query("begin");
  await c.query(`select set_config('app.tenant_id', $1, true)`, [FAKE_TENANT]);
  await c.query(`insert into tenants (id, type, name, status) values ($1,'transporter','FINANCE GATE VERIFY','active')`,
    [FAKE_TENANT]);

  const insertDraft = (id: string, kind: string, basis: string, extra: unknown[] = []) => c.query(
    "insert into tax_returns (id, tenant_id, kind, basis, period_start, period_end, currency," +
    " base_amount, zero_rated_base, exempt_base, tax_charged, input_tax, credits_declared," +
    " net_payable, statutory_collected, invoices_count, input_basis, rates_version, created_by, updated_by)" +
    " values ($1,$2,$3,$4,$5::date,$6::date,'TZS',$7,$8,0,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)",
    [id, FAKE_TENANT, kind, basis, FROM, TO, ...extra]);

  /** Run one statement under a savepoint and report whether it failed as expected. */
  let attemptNo = 0;
  async function attempt(label: string, expect: string | null, fn: () => Promise<unknown>) {
    const sp = `sp_${++attemptNo}`;
    await c.query(`savepoint ${sp}`);
    try {
      await fn();
      if (expect === null) ok(label);
      else bad(label, `statement succeeded, but it must fail with "${expect}"`);
      await c.query(`release savepoint ${sp}`);
    } catch (e: any) {
      await c.query(`rollback to savepoint ${sp}`);
      const msg = String(e.message ?? e);
      if (expect && msg.includes(expect)) ok(label, msg.split("\n")[0].slice(0, 70));
      else bad(label, `expected "${expect}", got ${msg.split("\n")[0].slice(0, 160)}`);
    }
  }

  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "aaaaaaaa-0000-4000-8000-000000000002";
  const D = "aaaaaaaa-0000-4000-8000-000000000003";
  const E = "aaaaaaaa-0000-4000-8000-000000000004";
  const F = "aaaaaaaa-0000-4000-8000-000000000005";

  // 100,000 of VAT, 20,000 of input credit, so the net is 80,000.
  const figures = [500000, 0, 100000, 20000, 0, 80000, 0, 3, null, "TRA 2025/26", FAKE_USER];
  await attempt("draft is born a draft", null, () => insertDraft(A, "vat", "computed", figures));
  await attempt("insert refuses a status that is not draft", "starts as a draft",
    () => c.query(
      "insert into tax_returns (id, tenant_id, kind, period_start, period_end, status)" +
      " values ($1,$2,'vat',$3::date,$4::date,'submitted')",
      [F, FAKE_TENANT, FROM, TO]));
  await attempt("a period that has not finished is refused on the way in", "has not finished",
    () => c.query(
      "insert into tax_returns (id, tenant_id, kind, period_start, period_end)" +
      " values ($1,$2,'vat',$3::date,$4::date)", [E, FAKE_TENANT, FROM, FUTURE]));
  await attempt("only one live return per kind and period", "duplicate key",
    () => insertDraft(B, "vat", "computed", figures));
  // One rule per statement: this case carries its provenance sentence so the only
  // rule it can break is the one being proven. Two violated CHECKs at once and
  // Postgres picks which to name, and the pick is not this test's to make.
  await attempt("a declared basis is refused on a computed kind", "declared_only_for_withholding",
    () => insertDraft(B, "vat", "declared",
      [500000, 0, 100000, 20000, 0, 80000, 0, 3,
       "Withholding certificate from a customer", "TRA 2025/26", FAKE_USER]));
  await attempt("a declared return without its provenance is refused", "declared_needs_basis",
    () => insertDraft(B, "withholding_vat", "declared",
      [0, 0, 30000, 0, 0, 30000, 0, 0, null, "TRA 2025/26", FAKE_USER]));
  await attempt("a total that does not foot against its own parts is refused", "net_foots",
    () => insertDraft(B, "vat", "computed",
      [500000, 0, 100000, 20000, 0, 999999, 0, 3, null, "TRA 2025/26", FAKE_USER]));
  await attempt("the register holds one currency only", "currency",
    () => c.query(
      "insert into tax_returns (id, tenant_id, kind, period_start, period_end, currency)" +
      " values ($1,$2,'vat',$3::date,$4::date,'USD')", [F, FAKE_TENANT, FROM, TO]));
  await attempt("a return cannot supersede itself", "does_not_supersede_itself",
    () => c.query(
      "insert into tax_returns (id, tenant_id, kind, period_start, period_end, supersedes_id)" +
      " values ($1,$2,'vat',$3::date,$4::date,$1)", [F, FAKE_TENANT, FROM, TO]));

  await attempt("a draft can be prepared", null, () => c.query(
    "update tax_returns set status='prepared', prepared_by=$3, prepared_at=now()" +
    " where id=$1 and tenant_id=$2 and status='draft'", [A, FAKE_TENANT, FAKE_USER]));
  await attempt("filing without a reference is refused", "reference the submission gave back",
    () => c.query("update tax_returns set status='filed', filed_at=current_date where id=$1 and tenant_id=$2",
      [A, FAKE_TENANT]));
  await attempt("filing without a date is refused", "needs the date it was filed",
    () => c.query("update tax_returns set status='filed', filing_reference='TRA-0001' where id=$1 and tenant_id=$2",
      [A, FAKE_TENANT]));
  await attempt("a prepared return files", null, () => c.query(
    "update tax_returns set status='filed', filing_reference='TRA-0001'," +
    " filed_at=current_date, filed_by=$3 where id=$1 and tenant_id=$2 and status='prepared'",
    [A, FAKE_TENANT, FAKE_USER]));
  await attempt("a filed return cannot be edited", "kept as filed",
    () => c.query("update tax_returns set tax_charged = 1 where id=$1 and tenant_id=$2", [A, FAKE_TENANT]));
  await attempt("a filed return cannot be re-opened to draft", "kept as filed",
    () => c.query("update tax_returns set status='draft' where id=$1 and tenant_id=$2", [A, FAKE_TENANT]));
  await attempt("a filed return cannot be withdrawn", "kept as filed",
    () => c.query("update tax_returns set deleted_at=now() where id=$1 and tenant_id=$2", [A, FAKE_TENANT]));
  await attempt("a filed return cannot be deleted", "kept as filed",
    () => c.query("delete from tax_returns where id=$1 and tenant_id=$2", [A, FAKE_TENANT]));

  // The replacement chain. A replacement starts as a draft, so the supersede rules
  // are proven at the moment it is filed — which is the only moment they matter.
  const draft = (id: string, kind: string, from: string, to: string, supersedes: string | null) => c.query(
    "insert into tax_returns (id, tenant_id, kind, basis, period_start, period_end," +
    " tax_charged, net_payable, supersedes_id, created_by, updated_by)" +
    " values ($1,$2,$3,'computed',$4::date,$5::date,80000,80000,$6,$7,$7)",
    [id, FAKE_TENANT, kind, from, to, supersedes, FAKE_USER]);
  const fileIt = (id: string) => c.query(
    "update tax_returns set status='prepared', prepared_by=$3, prepared_at=now()" +
    " where id=$1 and tenant_id=$2 and status='draft'", [id, FAKE_TENANT, FAKE_USER])
    .then(() => c.query(
      "update tax_returns set status='filed', filing_reference='TRA-REPL'," +
      " filed_at=current_date, filed_by=$3 where id=$1 and tenant_id=$2 and status='prepared'",
      [id, FAKE_TENANT, FAKE_USER]));

  await attempt("a draft may point at a filed return of the same kind and period", null,
    () => draft(D, "vat", FROM, TO, A));
  await attempt("a replacement files when its target was filed and matches", null, () => fileIt(D));
  await attempt("a replacement cannot be filed against a return that was never filed", "only replace one that was filed",
    async () => {
      const X = "aaaaaaaa-0000-4000-8000-000000000011";
      const Y = "aaaaaaaa-0000-4000-8000-000000000012";
      await draft(X, "vat", FROM2, TO2, null);
      // Withdrawn first, so the live-period unique index lets the replacement exist
      // at all — the gate is about the target's status, not about the index.
      await c.query("update tax_returns set deleted_at = now() where id=$1 and tenant_id=$2", [X, FAKE_TENANT]);
      await draft(Y, "vat", FROM2, TO2, X);
      await fileIt(Y);
    });
  await attempt("a replacement must keep the kind it corrects", "same kind and period",
    async () => {
      const G = "aaaaaaaa-0000-4000-8000-000000000007";
      await draft(G, "statutory_charges", FROM, TO, A);
      await fileIt(G);
    });

  const state = await c.query(
    "select id, status, kind, net_payable::text as net, filing_reference from tax_returns" +
    " where tenant_id = $1 order by created_at", [FAKE_TENANT]);
  ok("register after the gate run", state.rows.map(r => `${r.kind}/${r.status}/${r.net}`).join(" | "));
  const filedRows = state.rows.filter(r => r.status === "filed");
  const everyFiledHasReference = filedRows.every(r => !!r.filing_reference);
  if (filedRows.length >= 2 && everyFiledHasReference) {
    ok("every filed row carries the reference it was filed under", filedRows.length + " filed");
  } else {
    bad("every filed row carries the reference it was filed under", JSON.stringify(filedRows));
  }

  // updated_at is stamped by the shared trigger, not by the route. It cannot be
  // proven by comparing it to created_at inside this transaction — now() is
  // constant for the whole transaction, so both stamps are the same instant. The
  // shape that does prove it: type an old stamp in and show the row kept the
  // moment of the statement instead.
  const K = "aaaaaaaa-0000-4000-8000-000000000013";
  await attempt("a spare draft exists for the stamp proof", null, () => draft(K, "vat", FROM3, TO3, null));
  const bump = await c.query(
    "update tax_returns set updated_at = '2020-01-01T00:00:00Z'::timestamptz" +
    " where id = $1 and tenant_id = $2" +
    " returning abs(extract(epoch from (now() - updated_at)))::int as seconds_off",
    [K, FAKE_TENANT]);
  const off = Number(bump.rows[0]?.seconds_off ?? 1e9);
  if (bump.rowCount === 1 && off < 60) ok("set_updated_at overrides a stamp typed over it", `${off}s`);
  else bad("set_updated_at overrides a stamp typed over it", JSON.stringify(bump.rows));

  await c.query("rollback");
  const left = await c.query("select count(*)::int as n from tax_returns where tenant_id = $1", [FAKE_TENANT]);
  if (Number(left.rows[0].n) === 0) ok("nothing survived the run", "0 rows for the gate tenant");
  else bad("nothing survived the run", left.rows[0].n);
  const tenantLeft = await c.query("select count(*)::int as n from tenants where id = $1", [FAKE_TENANT]);
  if (Number(tenantLeft.rows[0].n) === 0) ok("the gate tenant was never committed");
  else bad("the gate tenant was never committed", tenantLeft.rows[0].n);
  await c.end();
}

async function main() {
  await planGate();
  await gateRuns();
  if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
  console.log("\nall finance SQL valid: statements plan, and every gate refuses what it promises to");
}

main().catch((e) => { console.error(e); process.exit(1); });
