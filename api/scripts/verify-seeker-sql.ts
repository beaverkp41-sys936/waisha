/**
 * SQL validation for migration 060 — seeker accounts and service groups.
 *
 * Part one EXPLAINs every statement the seeker signup, login and profile routes
 * will emit (060 ships the schema before those routes exist, so this is the
 * proof the schema actually accepts them rather than a guess they will fit).
 * Part two checks the shape the migration promised: the widened vocabularies,
 * RLS and grant posture on both new tables, the three seeded bundles and the
 * price ladder they claim to follow, the role and its deliberately small grant,
 * the pre-auth definer helpers, and that no Supabase browser role can reach any
 * of it.
 *
 * Part three is the only part that can catch what the catalogue cannot: it
 * connects as app_runtime for real, because the dev DATABASE_URL is the owner
 * role and the owner bypasses RLS — which is exactly how 047's half-fix on
 * plans survived a year of green runs.
 * Run: npx tsx scripts/verify-seeker-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_SEEKER = "22222222-2222-7222-8222-222222222222";
const FAKE_SUB = "33333333-3333-7333-8333-333333333333";
const FAKE_GROUP = "44444444-4444-7444-8444-444444444444";
const FAKE_OTP = "55555555-5555-7555-8555-555555555555";

const statements: [string, string, unknown[]][] = [
  // ---------- Seeker signup, in the order auth.routes.ts will run it ----------
  ["signup: duplicate probe before anything is written",
    `select platform_auth.check_seeker_duplicates($1, $2) as kind`,
    ["a@b.com", "hash-of-phone"]],

  ["signup: the seeker's own one-person tenant",
    `insert into tenants (id, type, name, status) values ($1,'seeker',$2,'pending_verification')`,
    [FAKE_TENANT, "Amina Juma"]],

  ["signup: the user row — two names joined, phone and email sealed",
    `insert into users (id, tenant_id, user_type, email, email_normalized_search,
        phone_encrypted, phone_search, password_hash, status, full_name)
      values ($1,$2,'seeker',$3,$4,$5,$6,$7,'pending_verification',$8)`,
    [FAKE_USER, FAKE_TENANT, "amina@example.com", "email-hash",
     Buffer.from("cipher"), "phone-hash", "argon2$hash", "Amina Juma"]],

  ["signup: the seeker profile beside the user",
    `insert into seekers (id, tenant_id, user_id, first_name, last_name, looking_for,
        industry, country, created_by, updated_by)
      values ($1,$2,$3,$4,$5,$6,$7,'Tanzania',$3,$3)`,
    [FAKE_SEEKER, FAKE_TENANT, FAKE_USER, "Amina", "Juma",
     ["transporter"], "Manufacturing"]],

  ["signup: an email-channel code (channel is written by nobody today)",
    `insert into otp_codes (id, user_id, tenant_id, purpose, channel, destination_search,
        code_hash, expires_at, resend_available_at)
      values ($1,$2,$3,'signup','email',$4,$5, now() + interval '5 minutes', now())`,
    [FAKE_OTP, FAKE_USER, FAKE_TENANT, "email-hash", "otp-hash"]],

  ["signup: an sms-channel code for the same account",
    `insert into otp_codes (id, user_id, tenant_id, purpose, channel, destination_search,
        code_hash, expires_at, resend_available_at)
      values ($1,$2,$3,'signup','sms',$4,$5, now() + interval '5 minutes', now())`,
    [FAKE_OTP, FAKE_USER, FAKE_TENANT, "phone-hash", "otp-hash"]],

  // ---------- Verification and login ----------
  ["verify: consume the code",
    `select platform_auth.consume_otp($1,'signup',$2) as r`, [FAKE_USER, "otp-hash"]],

  ["verify: which channel cleared it",
    `select platform_auth.mark_seeker_verified($1,'sms') as r`, [FAKE_USER]],

  ["verify: stamp the email channel too",
    `select platform_auth.mark_seeker_verified($1,'email') as r`, [FAKE_USER]],

  ["verify: the seeker role is granted from the global row",
    `insert into user_roles (user_id, role_id)
      select $1, id from roles where tenant_id is null and key = $2
      on conflict do nothing`, [FAKE_USER, "seeker"]],

  ["login: by email or phone",
    `select platform_auth.lookup_seeker_login($1, $2) as u`, ["email-hash", "phone-hash"]],

  ["login: by email alone, phone omitted",
    `select platform_auth.lookup_seeker_login($1, null) as u`, ["email-hash"]],

  ["resend: read the pending user with the address and the channel",
    `select platform_auth.get_user_for_otp($1) as u`, [FAKE_USER]],

  ["resend: the cooldown clock",
    `select platform_auth.last_otp_created_at($1,'signup') as t`, [FAKE_USER]],

  // ---------- The seeker's own surface ----------
  ["profile: read own seeker row with the user facts beside it",
    `select s.id, s.first_name, s.last_name, s.looking_for, s.industry, s.country,
            s.phone_verified_at, s.email_verified_at, u.email, u.status, u.language,
            t.status as tenant_status
      from seekers s
      join users u on u.id = s.user_id
      join tenants t on t.id = s.tenant_id
      where s.tenant_id = $1 and s.deleted_at is null`, [FAKE_TENANT]],

  ["profile: edit names, what they are looking for, and the sealed phone",
    `update seekers set first_name = $3, last_name = $4, looking_for = $5, industry = $6,
        updated_by = $2, updated_at = now()
      where tenant_id = $1 and deleted_at is null`,
    [FAKE_TENANT, FAKE_USER, "Amina", "Juma Mwakalinga", ["cfa"], "Agro-processing"]],

  ["profile: the permission gate the route runs first",
    `select 1 from user_roles ur
      join role_permissions rp on rp.role_id = ur.role_id
      where ur.user_id = $1 and rp.permission_key = $2
        and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
    [FAKE_USER, "seeker_profile.view"]],

  ["profile: soft delete, never a hard one",
    `update seekers set deleted_at = now(), updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $3`, [FAKE_SEEKER, FAKE_USER, FAKE_TENANT]],

  // ---------- Service groups ----------
  ["groups: the picker the signup and the admin both read",
    `select id, key, name, description, services, seat_limit, price_monthly,
            price_quarterly, price_annual, currency
      from service_groups where is_active order by sort, price_monthly`, []],

  ["groups: the bundle a subscription carries",
    `select s.id, s.status, s.billing_cycle, p.key as plan_key, sg.key as group_key,
            sg.name as group_name, sg.services
      from subscriptions s
      join plans p on p.id = s.plan_id
      left join service_groups sg on sg.id = s.service_group_id
      where s.tenant_id = $1 and s.deleted_at is null`, [FAKE_TENANT]],

  ["groups: sell a bundle onto a subscription",
    `update subscriptions set service_group_id = $3, updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $4 and deleted_at is null`,
    [FAKE_SUB, FAKE_USER, FAKE_GROUP, FAKE_TENANT]],

  ["groups: a subscription may still carry no bundle",
    `select count(*)::int as unbundled from subscriptions
      where service_group_id is null and deleted_at is null`, []],

  ["groups: the control price editor (COALESCE, presence-based)",
    `update service_groups set
        name = coalesce($2, name),
        seat_limit = coalesce($3, seat_limit),
        price_monthly = coalesce($4, price_monthly),
        is_active = coalesce($5, is_active),
        updated_by = $6, updated_at = now()
      where key = $1`,
    ["cfa_office", null, null, 375000, null, FAKE_USER]],

  ["groups: read one bundle by key, active only",
    `select key, services from service_groups where key = $1 and is_active`, ["transport_cfa_office"]],

  // ---------- Control listing must not offer a company plan to a seeker ----------
  ["control: tenants list keeps seekers out of activation",
    `select * from platform_auth.list_tenants_for_control($1)`, [null]],

  ["control: the same list still answers for a company",
    `select * from platform_auth.list_tenants_for_control($1)`, ["freight"]],

  // ---------- Plans ladder the bundles sit beside ----------
  ["plans: the ladder is unchanged",
    `select key, name, seat_limit, price_monthly from plans where is_active
      order by price_monthly`, []]
];

const shapeChecks: [string, string, (rows: any[]) => boolean][] = [
  ["user_type now admits seeker and lost nothing it had", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'users'::regclass and conname = 'users_user_type_check'`,
    (r) => {
      const def = String(r[0]?.def ?? "");
      const wanted = ["platform","director","staff","driver","trainee","shipper","customer_temp","seeker"];
      return wanted.every(v => def.includes(`'${v}'`));
    }],

  ["tenants.type admits seeker alongside the three it had", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'tenants'::regclass and conname = 'tenants_type_check'`,
    (r) => {
      const def = String(r[0]?.def ?? "");
      return ["transporter","shipper","platform","seeker"].every(v => def.includes(`'${v}'`));
    }],

  ["both new tables enforce RLS", `
     select relname, relrowsecurity from pg_class
     where relname in ('seekers','service_groups')`,
    (r) => r.length === 2 && r.every((x: any) => x.relrowsecurity === true)],

  ["seekers is tenant-scoped on every write", `
     select cmd, roles, qual, with_check from pg_policies where tablename = 'seekers'`,
    (r) => r.length === 1 && r[0].cmd === "ALL" && r[0].roles === "{app_runtime}"
      && /tenant_id = \(?nullif\(current_setting\('app\.tenant_id'/i.test(r[0].qual)
      && /tenant_id = \(?nullif\(current_setting\('app\.tenant_id'/i.test(r[0].with_check)],

  ["service_groups is platform-wide read and write for the runtime role only", `
     select policyname, cmd, roles, qual, with_check from pg_policies
     where tablename = 'service_groups'`,
    (r) => r.length === 3 && r.every((x: any) => x.roles === "{app_runtime}"
      && (x.qual === "true" || x.with_check === "true"))
      && r.some((x: any) => x.policyname === "service_groups_read" && x.cmd === "SELECT")
      && r.some((x: any) => x.policyname === "service_groups_insert" && x.cmd === "INSERT")
      && r.some((x: any) => x.policyname === "service_groups_update" && x.cmd === "UPDATE")],

  ["seekers can never be hard-deleted", `
     select privilege_type from information_schema.role_table_grants
     where grantee = 'app_runtime' and table_name = 'seekers'`,
    (r) => r.map((x: any) => x.privilege_type).sort().join(",") === "INSERT,SELECT,UPDATE"],

  ["service_groups is read and priced, never deleted away", `
     select privilege_type from information_schema.role_table_grants
     where grantee = 'app_runtime' and table_name = 'service_groups'`,
    (r) => r.map((x: any) => x.privilege_type).sort().join(",") === "INSERT,SELECT,UPDATE"],

  // service_role is deliberately excluded: 051 left its defaults intact for
  // operator tooling and made the owner-of-everything argument explicit, so the
  // roles that must never appear here are the three a browser can present.
  ["no browser role reaches either new table", `
     select table_name, grantee from information_schema.role_table_grants
     where table_name in ('seekers','service_groups')
       and grantee in ('anon','authenticated','public')`,
    (r) => r.length === 0],

  ["one seeker row per user and per tenant, live rows only", `
     select indexname, indexdef from pg_indexes
     where indexname in ('seekers_user_uq','seekers_tenant_uq')`,
    (r) => r.length === 2 && r.every((x: any) => /deleted_at is null/i.test(x.indexdef))],

  ["the bundle is a closed vocabulary, one to three of them", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'service_groups'::regclass
       and pg_get_constraintdef(oid) ilike '%services%'`,
    (r) => r.length >= 1 && r.some((x: any) =>
      /<@ ARRAY\['transport'/i.test(String(x.def))
      && /'cfa'/.test(String(x.def)) && /'office'/.test(String(x.def)))
      && r.some((x: any) => /array_length\(services, 1\) >= 1/i.test(String(x.def))
        && /array_length\(services, 1\) <= 3/i.test(String(x.def)))],

  ["looking_for is only ever transporter or cfa", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'seekers'::regclass and pg_get_constraintdef(oid) ilike '%looking_for%'`,
    (r) => r.some((x: any) => /<@ ARRAY\['transporter'::text, 'cfa'::text\]/i.test(String(x.def)))],

  ["names are required and bounded on both halves", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'seekers'::regclass
       and (pg_get_constraintdef(oid) ilike '%first_name%' or pg_get_constraintdef(oid) ilike '%last_name%')`,
    (r) => r.length === 2 && r.every((x: any) => {
      const def = String(x.def);
      return /char_length\(TRIM\(BOTH FROM (first|last)_name\)\) >= 1/i.test(def)
        && /char_length\(TRIM\(BOTH FROM (first|last)_name\)\) <= 60/i.test(def);
    })],

  ["prices are exact decimals in one currency, never a float", `
     select column_name, data_type, numeric_precision, numeric_scale
     from information_schema.columns
     where table_name = 'service_groups'
       and column_name in ('price_monthly','price_quarterly','price_annual')`,
    (r) => r.length === 3 && r.every((x: any) => x.data_type === "numeric"
      && x.numeric_precision === 12 && x.numeric_scale === 2)],

  ["the subscription carries the bundle, and it is optional", `
     select is_nullable from information_schema.columns
     where table_name = 'subscriptions' and column_name = 'service_group_id'`,
    (r) => r.length === 1 && r[0].is_nullable === "YES"],

  ["that column points only at service_groups", `
     select confrelid::regclass::text as target from pg_constraint
     where conrelid = 'subscriptions'::regclass
       and conname = 'subscriptions_service_group_id_fkey'`,
    (r) => r.length === 1 && String(r[0].target) === "service_groups"],

  ["the three bundles the user named are seeded, in order", `
     select key, services, sort, is_active from service_groups order by sort`,
    (r) => {
      const keys = r.map((x: any) => x.key);
      const same = (a: string[], b: string[]) => a.slice().sort().join() === b.slice().sort().join();
      return keys.join(",") === "transport_cfa_office,transport_office,cfa_office"
        && same(r[0].services, ["transport","cfa","office"])
        && same(r[1].services, ["transport","office"])
        && same(r[2].services, ["cfa","office"])
        && r.every((x: any) => x.is_active === true);
    }],

  ["every bundle includes OFFICE, as the user specified", `
     select key, services from service_groups`,
    (r) => r.length === 3 && r.every((x: any) => x.services.includes("office"))],

  ["the seeded prices follow the ladder plans already uses", `
     select key, price_monthly, price_quarterly, price_annual from service_groups`,
    (r) => r.every((x: any) => {
      const m = Number(x.price_monthly), q = Number(x.price_quarterly), a = Number(x.price_annual);
      return Math.abs(q - m * 3 * 0.95) < 0.005 && Math.abs(a - m * 10) < 0.005;
    })],

  ["no bundle is priced at zero", `
     select key from service_groups where price_monthly <= 0`,
    (r) => r.length === 0],

  ["the seeker permission keys exist and are described", `
     select key, description from permissions where key like 'seeker_profile.%'`,
    (r) => r.length === 2 && r.every((x: any) => /^Seeker Account - /i.test(x.description))],

  ["the seeker role is global and a system role", `
     select tenant_id, is_system, name from roles where key = 'seeker' and tenant_id is null`,
    (r) => r.length === 1 && r[0].is_system === true && !!r[0].name],

  ["the seeker gets its own profile and nothing else yet", `
     select p.key from roles r
     join role_permissions rp on rp.role_id = r.id
     join permissions p on p.key = rp.permission_key
     where r.key = 'seeker' and r.tenant_id is null`,
    (r) => r.map((x: any) => x.key).sort().join(",") === "seeker_profile.edit,seeker_profile.view"],

  ["the seeker role holds no company-side key at all", `
     select p.key from roles r
     join role_permissions rp on rp.role_id = r.id
     join permissions p on p.key = rp.permission_key
     where r.key = 'seeker' and r.tenant_id is null
       and p.key not like 'seeker_profile.%'`,
    (r) => r.length === 0],

  ["the pre-auth helpers are definer with a pinned search_path", `
     select p.proname, p.prosecdef, pg_get_functiondef(p.oid) as def
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth'
       and p.proname in ('check_seeker_duplicates','lookup_seeker_login',
                         'mark_seeker_verified','get_user_for_otp','list_tenants_for_control')`,
    (r) => r.length === 5 && r.every((x: any) => x.prosecdef === true
      && /SET search_path TO 'public'/i.test(x.def)
      && /SECURITY DEFINER/i.test(x.def))],

  ["the duplicate probe and the login lookup cannot see a deleted account", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth'
       and p.proname in ('check_seeker_duplicates','lookup_seeker_login')`,
    (r) => r.length === 2 && r.every((x: any) => /deleted_at is null/i.test(x.def))],

  ["the login lookup is fenced to seeker users only", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'lookup_seeker_login'`,
    (r) => /user_type = 'seeker'/i.test(String(r[0]?.def))],

  ["a transporter token cannot be read through the seeker door", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'lookup_seeker_login'`,
    (r) => !/director|'staff'/i.test(String(r[0]?.def))],

  ["resend can now reach an address, which 003 never returned", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'get_user_for_otp'`,
    (r) => /'email'/i.test(String(r[0]?.def)) && /'channel'/i.test(String(r[0]?.def))],

  ["mark_seeker_verified only accepts the two real channels", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'mark_seeker_verified'`,
    (r) => {
      const def = String(r[0]?.def);
      return /p_channel = 'sms'/i.test(def) && /p_channel = 'email'/i.test(def)
        && /'status','invalid'/i.test(def);
    }],

  ["the control tenant list keeps platform AND seekers out", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'list_tenants_for_control'`,
    (r) => /type not in \('platform','seeker'\)/i.test(String(r[0]?.def))],

  ["it still returns the same columns the control route reads", `
     select pg_get_function_result(p.oid) as sig from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'list_tenants_for_control'`,
    (r) => {
      const sig = String(r[0]?.sig);
      return ["tenant_id","name","tenant_type","status","trial_ends_at","licence_expires_at",
              "subscription_status","plan_name","seats_licensed","created_at"]
        .every(c => sig.includes(c));
    }],

  ["the runtime role can execute every helper it needs", `
     select p.proname, has_function_privilege('app_runtime', p.oid, 'execute') as can
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth'
       and p.proname in ('check_seeker_duplicates','lookup_seeker_login',
                         'mark_seeker_verified','get_user_for_otp','list_tenants_for_control')`,
    (r) => r.length === 5 && r.every((x: any) => x.can === true)],

  ["no browser role can execute the new helpers", `
     select p.proname,
            has_function_privilege('anon', p.oid, 'execute') as anon_x,
            has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
            has_function_privilege('public', p.oid, 'execute') as public_x
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth'
       and p.proname in ('check_seeker_duplicates','lookup_seeker_login','mark_seeker_verified')`,
    (r) => r.length === 3 && r.every((x: any) =>
      x.anon_x === false && x.auth_x === false && x.public_x === false)],

  ["the 047 half-fix is closed: plans has an UPDATE policy now", `
     select policyname, cmd, qual, with_check, roles from pg_policies
     where tablename = 'plans'`,
    (r) => r.some((x: any) => x.cmd === "UPDATE" && x.qual === "true" && x.with_check === "true"
      && x.roles === "{app_runtime}")],

  ["plans keeps its no-DELETE posture after that", `
     select privilege_type from information_schema.role_table_grants
     where grantee = 'app_runtime' and table_name = 'plans'`,
    (r) => !r.some((x: any) => x.privilege_type === "DELETE")],

  ["both new tables stamp updated_at", `
     select tgname from pg_trigger
     where not tgisinternal and tgrelid in ('seekers'::regclass,'service_groups'::regclass)`,
    (r) => r.length === 2 && r.every((x: any) => /_updated$/.test(x.tgname))],

  ["the seekers soft-delete guard: live rows are what the uniques bind", `
     select indexdef from pg_indexes where tablename = 'seekers'`,
    (r) => r.some((x: any) => /deleted_at is null/i.test(x.indexdef))],

  ["service_groups has no soft delete — deactivation is the lever", `
     select column_name from information_schema.columns
     where table_name = 'service_groups' and column_name = 'deleted_at'`,
    (r) => r.length === 0]
];

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL");

/** The owner role bypasses RLS, so a catalogue-only check would have passed for
 * 047's broken plans write too. Rebuild the connection as app_runtime exactly
 * the way verify-isolation.ts does, and refuse to run the probes if that role
 * turns out to bypass RLS after all. */
function appRuntimeUrl() {
  const u = new URL(url!);
  const ref = u.username.split(".")[1];
  if (!u.username.startsWith("postgres") || !process.env.APP_DB_PASSWORD) {
    return { href: u.toString(), switched: false };
  }
  u.username = "app_runtime" + (ref ? "." + ref : "");
  u.password = encodeURIComponent(process.env.APP_DB_PASSWORD);
  return { href: u.toString(), switched: true };
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  let failed = 0;

  for (const [label, sql, params] of statements) {
    try {
      await pool.query("explain " + sql, params);
      console.log("ok    ", label);
    } catch (e: any) {
      failed++;
      console.log("FAIL  ", label, "-", e.message);
    }
  }

  for (const [label, sql, ok] of shapeChecks) {
    try {
      const { rows } = await pool.query(sql);
      const pass = ok(rows);
      console.log(pass ? "ok   " : "FAIL ", label, pass ? "" : `-> ${JSON.stringify(rows).slice(0, 260)}`);
      if (!pass) failed++;
    } catch (e: any) {
      failed++;
      console.log("FAIL  ", label, "-", e.message);
    }
  }
  await pool.end();

  // ---------- Live posture as app_runtime ----------
  const app = appRuntimeUrl();
  if (!app.switched) {
    console.log("FAIL  app_runtime probes skipped — DATABASE_URL is not an owner URL and APP_DB_PASSWORD is unset");
    failed++;
  } else {
    const c = new pg.Client({ connectionString: app.href, ssl: { rejectUnauthorized: false } });
    try {
      await c.connect();
      const who = await c.query(
        `select current_user as u,
           (select rolsuper from pg_roles where rolname = current_user) as super,
           (select rolbypassrls from pg_roles where rolname = current_user) as bypass`);
      if (who.rows[0].super || who.rows[0].bypass) {
        console.log(`ABORT: role ${who.rows[0].u} bypasses RLS — the posture probes would be meaningless`);
        await c.end();
        process.exit(1);
      }
      console.log("note   running the posture probes as", who.rows[0].u);

      // 1. The bug 047 only half fixed: a granted, unpoliced UPDATE matches no rows.
      const wrote = await c.query("update plans set seat_limit = seat_limit where key = 'starter'");
      console.log(wrote.rowCount === 1
        ? "ok     plans UPDATE actually lands as app_runtime (047's grant had no policy behind it)"
        : `FAIL  plans UPDATE matched ${wrote.rowCount} rows as app_runtime — the price edit still goes nowhere`);
      if (wrote.rowCount !== 1) failed++;

      // 2. Seekers are invisible without their own tenant context.
      await c.query("select set_config('app.tenant_id', '', false)");
      const noCtx = await c.query("select count(*)::int as n from seekers");
      console.log(noCtx.rows[0].n === 0
        ? "ok     seekers reads 0 rows with no tenant context"
        : `FAIL  seekers leaked ${noCtx.rows[0].n} rows with no tenant context`);
      if (noCtx.rows[0].n !== 0) failed++;

      await c.query("select set_config('app.tenant_id', $1, false)", [FAKE_TENANT]);
      const forged = await c.query("select count(*)::int as n from seekers");
      console.log(forged.rows[0].n === 0
        ? "ok     a forged tenant id reads 0 seekers rather than erroring"
        : `FAIL  forged tenant id read ${forged.rows[0].n} seekers`);
      if (forged.rows[0].n !== 0) failed++;

      // 3. Writing for a tenant that is not yours is refused. The refusal can
      //    arrive from RLS with_check or from the FK, since neither probe row
      //    exists in either table — what must never happen is a landing.
      const otherTenant = "99999999-9999-7999-8999-999999999999";
      try {
        await c.query(
          `insert into seekers (id, tenant_id, user_id, first_name, last_name)
           values ($1,$2,$3,'Probe','Seeker')`,
          ["bbbbbbbb-1111-4111-8111-111111111111", otherTenant, FAKE_USER]);
        console.log("FAIL  a seeker row landed for a tenant the session does not hold");
        failed++;
      } catch (e: any) {
        console.log(`ok     seekers cross-tenant insert refused (${e.code ?? e.message})`);
      }

      // 4. DELETE really is gone.
      try {
        await c.query("delete from seekers where id = $1", [FAKE_SEEKER]);
        console.log("FAIL  app_runtime can hard-delete a seeker row");
        failed++;
      } catch (e: any) {
        console.log(/permission denied/i.test(e.message)
          ? "ok     seeker rows cannot be hard-deleted by the runtime role"
          : `FAIL  seeker delete failed for another reason: ${e.message}`);
        if (!/permission denied/i.test(e.message)) failed++;
      }

      // 5. The control list answers, and does not list a seeker even when one exists.
      const ctl = await c.query("select tenant_type from platform_auth.list_tenants_for_control(null)");
      console.log(ctl.rows.every((x: any) => x.tenant_type !== "seeker")
        ? `ok     list_tenants_for_control returned ${ctl.rows.length} companies and no seeker`
        : "FAIL  list_tenants_for_control still lists seekers");
      if (!ctl.rows.every((x: any) => x.tenant_type !== "seeker")) failed++;

      // 6. Service groups are readable by the runtime role (the picker needs them).
      const sg = await c.query("select key from service_groups order by sort");
      console.log(sg.rows.length === 3
        ? "ok     app_runtime reads the three bundles"
        : `FAIL  app_runtime saw ${sg.rows.length} bundles, expected 3`);
      if (sg.rows.length !== 3) failed++;
    } catch (e: any) {
      failed++;
      console.log("FAIL  app_runtime posture probe -", e.message);
    } finally {
      await c.end().catch(() => null);
    }
  }

  if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log(`seeker SQL and 060 shape valid (${statements.length} statements, ${shapeChecks.length} shape checks)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
