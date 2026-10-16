/**
 * Step 6 — SQL + security-shape validation for the booking state machine.
 *
 * Two jobs. First, EXPLAIN every statement the booking routes, timers and
 * alerts run against the live schema so nothing ships broken. Second, prove
 * the state machine is the ONLY way in: every transport_* function is
 * SECURITY DEFINER with a pinned search_path, execute-only for the app role,
 * and transport_bookings stays read-only for app_runtime. Clients never set a
 * status directly — the transitions are the functions.
 * Run: npx tsx scripts/verify-bookings-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const T = "00000000-0000-7000-8000-000000000000";  // tenant
const U = "11111111-1111-7111-8111-111111111111";  // actor
const R = "99999999-9999-7999-8999-999999999999";  // transport request
const B = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";  // booking

const sql: [string, string, unknown[]][] = [
  // ---- board book + transport-request transitions ----
  ["book: call state machine",
    `select transport_book_request($1,$2,$3,$4,$5) as r`, [R, T, U, "Amani Salum", "+255 712 000 000"]],
  ["withdraw: call state machine",
    `select transport_withdraw_request($1,$2,$3) as r`, [R, T, U]],
  ["confirm: call state machine",
    `select transport_confirm_booking($1,$2,$3) as r`, [R, T, U]],
  ["reject: call state machine",
    `select transport_reject_booking($1,$2,$3,$4) as r`, [R, T, U, "Rate too high"]],
  ["release: call state machine",
    `select transport_release_booking($1,$2,$3,$4) as r`, [R, T, U, null]],
  ["cancel-booking: call state machine",
    `select transport_cancel_booking($1,$2,$3,$4) as r`, [R, T, U, "Client changed the plan"]],

  // ---- timers (idempotent, row-locked, driven by the scheduler + secret tick) ----
  ["timer: reminders",
    `select transport_booking_reminders() as n`],
  ["timer: releases",
    `select transport_booking_releases() as ids`],

  // ---- the booker's own rows ----
  ["my-bookings: list",
    `select id, status, cargo_label, container_type, container_count, weight_tonnes, cbm,
            vehicle_types, route_label, distance_km, expected_duration_hours,
            pickup_text, dest_text, via_label, required_date::text as required_date,
            company_name, contact_name, contact_channel,
            temp_booked_at, reminder_sent_at, confirmed_at, ended_at, ended_reason,
            created_at
       from transport_bookings
      where tenant_id = $1 and deleted_at is null
      order by created_at desc limit 200`, [T]],
  ["booking: resolve own row",
    `select request_id from transport_bookings
      where id = $1 and tenant_id = $2 and deleted_at is null`, [B, T]],

  // ---- alerts derived from bookings (notifications route) ----
  ["alerts: publisher holds",
    `select t.id, t.status, t.booked_company_name, t.booked_contact_name,
            t.booked_contact_channel, t.temp_booked_at, t.reminder_sent_at, t.confirmed_at
       from transport_requests t
      where t.tenant_id = $1 and t.deleted_at is null
        and t.status in ('temp_booked','confirmed')`, [T]],
  ["alerts: back on the board",
    `select id, booked_company_name, released_at from transport_requests
      where tenant_id = $1 and deleted_at is null and status = 'open'
        and released_at > now() - interval '7 days'`, [T]],
  ["alerts: booker bookings",
    `select b.id, b.status, b.cargo_label, b.dest_text, b.company_name, b.ended_reason,
            b.temp_booked_at, b.confirmed_at, b.ended_at,
            not exists (select 1 from users u
                         where u.id = b.ended_by and u.tenant_id = b.tenant_id) as ended_by_other
       from transport_bookings b
      where b.tenant_id = $1 and b.deleted_at is null
        and b.created_at > now() - interval '30 days'`, [T]],

  // ---- step 7: read state, readiness checklist, booker review copy ----
  ["alerts: this user's read keys",
    `select alert_key from alert_reads where user_id = $1 and tenant_id = $2`, [U, T]],
  ["alerts: mark read (idempotent by primary key)",
    `insert into alert_reads (user_id, tenant_id, alert_key)
     select $1, $2, k from unnest($3::text[]) as k
     on conflict (user_id, alert_key) do nothing`, [U, T, ["booking_hold:x"]]],
  ["readiness: the company profile checklist",
    `select company_name, description, services_offered, corridors_served,
            transport_licence_no, transport_licence_expiry
       from company_profiles where tenant_id = $1`, [T]],
  ["transport list: the booker's company copy",
    `select t.id, t.status, t.booked_company_name, t.booked_company_description,
            t.booked_company_services, t.booked_company_corridors, t.booked_company_website,
            t.booked_fleet_size, t.booked_year_established, t.booked_licence_no,
            t.booked_licence_expiry::text as booked_licence_expiry
       from transport_requests t
      where t.tenant_id = $1 and t.deleted_at is null
        and t.status in ('temp_booked','confirmed')`, [T]],

  // ---- guards the functions rely on ----
  ["guard: tenant scope setter",
    `select set_config('app.tenant_id', $1, true)`, [T]]
];

/** The complete transition surface — anything else must not be execute-able. */
const FUNCTIONS: [string, string][] = [
  ["transport_book_request(uuid,uuid,uuid,text,text)", "the concurrency gate (open → temp_booked)"],
  ["transport_confirm_booking(uuid,uuid,uuid)", "temp_booked → confirmed"],
  ["transport_reject_booking(uuid,uuid,uuid,text)", "temp_booked → open"],
  ["transport_release_booking(uuid,uuid,uuid,text)", "temp_booked → open (booker side)"],
  ["transport_cancel_booking(uuid,uuid,uuid,text)", "confirmed → open with a reason"],
  ["transport_withdraw_request(uuid,uuid,uuid)", "open → cancelled"],
  ["transport_booking_reminders()", "6h reminder stamp"],
  ["transport_booking_releases()", "12h auto-release"]
];

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  const pool = new pg.Pool({ connectionString: url, max: 1,
    ssl: { rejectUnauthorized: false } });

  let failed = 0;
  for (const [label, stmt, params] of sql) {
    try {
      await pool.query("explain " + stmt, params ?? []);
      console.log("ok   ", label);
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  console.log("\n--- state machine: functions are definer, pinned, execute-only ---");
  const fns = await pool.query(
    `select p.oid, p.proname, p.prosecdef, p.proconfig,
            oidvectortypes(p.proargtypes) as types,
            pg_get_userbyid(p.proowner) as owner,
            coalesce(array_to_string(p.proacl, ' '), '') as acl
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'transport\\_%'`);
  const byName = new Map(fns.rows.map((r: any) =>
    [`${r.proname}(${String(r.types).replace(/\s+/g, "")})`, r]));
  /** Exec grantees parsed from the acl; "" (bare =X/) means PUBLIC. */
  const execGrantees = (acl: string): string[] =>
    acl.split(/\s+/).filter(Boolean).filter((e) => e.includes("=X/"))
      .map((e) => e.split("=")[0] || "PUBLIC");

  for (const [sig, why] of FUNCTIONS) {
    const f = byName.get(sig);
    const want: string[] = [];
    if (!f) { failed++; console.log("FAIL ", sig, "- missing"); continue; }
    if (!f.prosecdef) want.push("not SECURITY DEFINER");
    if (!(f.proconfig ?? []).some((c: string) => c.startsWith("search_path=")))
      want.push("search_path not pinned");
    const grantees = execGrantees(f.acl);
    if (grantees.includes("PUBLIC")) want.push("executable by PUBLIC");
    const extra = grantees.filter((g) => g !== "app_runtime" && g !== f.owner);
    if (extra.length) want.push(`executable by ${extra.join(", ")}`);
    if (!grantees.includes("app_runtime")) want.push("app_runtime cannot execute");
    if (want.length) { failed++; console.log("FAIL ", sig, "-", want.join("; "), `(${why}) acl="${f.acl}"`); }
    else console.log(`ok    ${sig} — ${why}`);
  }
  // transport_actor_ok is the tenant-scope guard the transitions call — it
  // only reads the transaction-local setting, so it is a plain function, but
  // the app role must not be able to call it directly.
  const helper = byName.get("transport_actor_ok(uuid)");
  if (!helper) { failed++; console.log("FAIL  transport_actor_ok(uuid) - missing"); }
  else {
    const hw: string[] = [];
    const grantees = execGrantees(helper.acl);
    if (grantees.includes("app_runtime"))
      hw.push("app_runtime can execute the guard directly - keep it internal to the transitions");
    if (grantees.includes("PUBLIC"))
      hw.push("executable by PUBLIC");
    const extra = grantees.filter((g) => g !== helper.owner);
    if (extra.length) hw.push(`executable by ${extra.join(", ")}`);
    if (hw.length) { failed++; console.log("FAIL  transport_actor_ok(uuid) -", hw.join("; "), `acl="${helper.acl}"`); }
    else console.log("ok    transport_actor_ok(uuid) — internal tenant-scope guard, owner-only");
  }
  const known = new Set([...FUNCTIONS.map(([s]) => s), "transport_actor_ok(uuid)"]);
  const extraFns = [...byName.keys()].filter((k) => !known.has(k));
  if (extraFns.length) {
    failed++;
    console.log("FAIL  unexpected transport_* functions (review):", extraFns.join(", "));
  }

  console.log("\n--- transport_bookings: read-only for the app role, RLS on ---");
  const tbl = (await pool.query(
    `select c.relrowsecurity as rls,
            (select count(*) from pg_policies p
              where p.tablename = 'transport_bookings' and p.schemaname = 'public') as policies,
            (select count(*) from pg_indexes i
              where i.tablename = 'transport_bookings'
                and i.indexname = 'transport_bookings_one_active_uq') as active_uq,
            has_table_privilege('app_runtime','public.transport_bookings','SELECT') as can_select,
            has_table_privilege('app_runtime','public.transport_bookings','INSERT') as can_insert,
            has_table_privilege('app_runtime','public.transport_bookings','UPDATE') as can_update,
            has_table_privilege('app_runtime','public.transport_bookings','DELETE') as can_delete,
            has_table_privilege('app_runtime','public.transport_requests','UPDATE') as req_update,
            has_column_privilege('app_runtime','public.transport_requests','status','INSERT') as ins_status
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'transport_bookings'`)).rows[0];
  const want: string[] = [];
  if (!tbl.rls) want.push("RLS off");
  if (Number(tbl.policies) === 0) want.push("no tenant policy");
  if (Number(tbl.active_uq) !== 1) want.push("one-active-booking unique index missing");
  if (!tbl.can_select) want.push("app_runtime cannot SELECT its own bookings");
  if (tbl.can_insert || tbl.can_update || tbl.can_delete)
    want.push("app_runtime can write bookings directly - must be function-only");
  if (tbl.req_update) want.push("app_runtime can UPDATE transport_requests - state must go through functions");
  if (tbl.ins_status) want.push("app_runtime can INSERT transport_requests.status - clients must not set the state");
  if (want.length) { failed++; console.log("FAIL  bookings shape -", want.join("; ")); }
  else console.log("ok    transport_bookings (rls on, select-only, one active per request)");

  console.log("\n--- alert_reads: per-user seen state, append-only for the app role ---");
  const ar = (await pool.query(
    `select c.relrowsecurity as rls,
            (select count(*) from pg_policies p
              where p.tablename = 'alert_reads' and p.schemaname = 'public') as policies,
            has_table_privilege('app_runtime','public.alert_reads','SELECT') as can_select,
            has_table_privilege('app_runtime','public.alert_reads','INSERT') as can_insert,
            has_table_privilege('app_runtime','public.alert_reads','UPDATE') as can_update,
            has_table_privilege('app_runtime','public.alert_reads','DELETE') as can_delete,
            (select count(*) from pg_constraint k
              where k.conrelid = c.oid and k.contype = 'p'
                and pg_get_constraintdef(k.oid) = 'PRIMARY KEY (user_id, alert_key)') as pk,
            (select count(*) from pg_constraint k
              where k.conrelid = c.oid and k.contype = 'f'
                and k.confdeltype = 'c') as cascade_fk
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'alert_reads'`)).rows[0];
  const arw: string[] = [];
  if (!ar) arw.push("table missing");
  else {
    if (!ar.rls) arw.push("RLS off");
    if (Number(ar.policies) === 0) arw.push("no tenant policy");
    if (!ar.can_select || !ar.can_insert) arw.push("app_runtime cannot read or mark keys");
    if (ar.can_update || ar.can_delete)
      arw.push("app_runtime can rewrite read state - it must be append-only");
    if (Number(ar.pk) !== 1) arw.push("primary key (user_id, alert_key) missing");
    if (Number(ar.cascade_fk) === 0) arw.push("no on-delete-cascade for the user row");
  }
  if (arw.length) { failed++; console.log("FAIL  alert_reads shape -", arw.join("; ")); }
  else console.log("ok    alert_reads (rls on, select+insert only, keyed per user, cascades with the user)");

  console.log("\n--- step 7 copy columns: the booker's profile rides on both rows ---");
  const copyCols = (await pool.query(
    `select table_name, count(*)::int as n from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'transport_requests' and column_name in
                ('booked_company_description','booked_company_services','booked_company_corridors',
                 'booked_company_website','booked_fleet_size','booked_year_established',
                 'booked_licence_no','booked_licence_expiry'))
          or (table_name = 'transport_bookings' and column_name in
                ('booker_description','booker_services','booker_corridors','booker_website',
                 'booker_fleet_size','booker_year_established','booker_licence_no',
                 'booker_licence_expiry')))
      group by table_name`)).rows as { table_name: string; n: number }[];
  const reqCols = copyCols.find((r) => r.table_name === "transport_requests")?.n ?? 0;
  const bkCols = copyCols.find((r) => r.table_name === "transport_bookings")?.n ?? 0;
  if (reqCols !== 8 || bkCols !== 8) {
    failed++;
    console.log(`FAIL  copy columns - requests=${reqCols}/8, bookings=${bkCols}/8`);
  } else {
    console.log("ok    the 8 booked_* and 8 booker_* snapshot columns all exist");
  }

  console.log("\n--- timers: the clock leaves a record (audit + job timeline) ---");
  const defs = (await pool.query(
    `select p.proname, pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('transport_booking_reminders','transport_booking_releases',
                          'transport_book_request')`)).rows;
  for (const [fn, needs] of [
    ["transport_booking_reminders", ["audit_logs", "job_activity", "'transport.booking_reminded'"]],
    ["transport_booking_releases", ["audit_logs", "job_activity", "'transport.booking_auto_released'"]],
    ["transport_book_request", ["company_profiles", "booked_company_description", "booker_description"]]
  ] as [string, string[]][]) {
    const row = defs.find((d: any) => d.proname === fn);
    const missing = needs.filter((need) => !String(row?.def ?? "").includes(need));
    if (!row || missing.length) {
      failed++;
      console.log("FAIL ", fn, "- missing", missing.join(", ") || "(function absent)");
    } else console.log(`ok    ${fn} — writes ${needs.join(", ")}`);
  }

  console.log("\n--- supabase default roles: no access to the transport surface ---");
  const leaked = await pool.query(
    `select g.table_name as obj, g.grantee, string_agg(g.privilege_type, ',' order by g.privilege_type) as privs
       from information_schema.role_table_grants g
      where g.table_schema = 'public'
        and g.table_name in ('transport_requests','transport_bookings','alert_reads')
        and g.grantee in ('anon','authenticated','service_role')
      group by g.table_name, g.grantee
      union all
     select p.proname, a.grantee::regrole::text, 'EXECUTE'
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(p.proacl) a
      where n.nspname = 'public'
        and (p.proname like 'transport\\_%' or p.proname like 'board\\_%')
        and a.grantee <> 0
        and a.grantee::regrole::text in ('anon','authenticated','service_role')`);
  if (leaked.rowCount) {
    failed++;
    for (const l of leaked.rows)
      console.log("FAIL ", l.obj, "-", l.grantee, "holds", l.privs,
        "(migration 049 must revoke these)");
  } else {
    console.log("ok    anon/authenticated/service_role hold nothing on transport or board objects");
  }

  await pool.end();
  if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
  console.log("\nall booking SQL valid; the state machine is the only way in");
}

main().catch((e) => { console.error(e); process.exit(1); });
