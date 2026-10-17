/**
 * SQL validation for migration 061 — directory listings, search passes, metering.
 *
 * Part one EXPLAINs every statement the directory routes will emit (061 ships the
 * schema before those routes exist, so this is the proof the schema accepts them).
 *
 * Part two checks the shape the migration promised. The three that matter most are
 * the directory_card allowlist — the composite's own column list IS the Rule 0
 * boundary, so a check that it holds 19 disclosure columns and no tenant_id, TIN,
 * licence number, phone or staff key is the check that a later widening cannot be
 * silent — the grant posture on the meter (the owner of a pass has SELECT only, so
 * the searches_allowed column is not editable by the person it limits), and the claim
 * checker's binding to `current_setting('app.tenant_id')`: it is SECURITY INVOKER so a
 * route can call it under RLS, and inside a definer it still filters on the session's
 * own tenant, which is what keeps a borrowed search id from opening another seeker's
 * results.
 *
 * Part three is live as app_runtime, because the dev DATABASE_URL is the owner role
 * and the owner bypasses RLS. The headline probe is the meter: call directory_search
 * with a fabricated claim id and the database must answer with nothing, so "search
 * the directory without spending a credit" is refused by the schema rather than by
 * whichever route happens to forget to check. The second headline is the opposite
 * direction: a claim that DOES exist must be answered for real, because EXPLAIN never
 * plans inside a function body and a fabricated id returns at the claim guard before
 * it reaches anything — which is exactly how 061's ambiguous `found` reference (063)
 * stayed green. Step 7 therefore builds a live listing and a paid claim and executes
 * the reader end-to-end.
 * Run: npx tsx scripts/verify-directory-sql.ts
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_LISTING = "66666666-6666-7666-8666-666666666666";
const FAKE_PASS = "77777777-7777-7777-8777-777777777777";
const FAKE_SEARCH = "88888888-8888-7888-8888-888888888888";
const FAKE_PRODUCT = "99999999-9999-7999-8999-999999999999";
const FAKE_ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "99999999-9999-7999-8999-999999999999";

const NEW_TABLES = [
  "seeker_pass_products",
  "directory_listings",
  "directory_listing_regions",
  "seeker_search_passes",
  "seeker_searches"
];

const statements: [string, string, unknown[]][] = [
  // ---------- The company publishes itself ----------
  ["listing: read own row",
    `select id, serves, status, is_verified, published_at, suspension_reason,
            licence_valid_to, company_name, headline
       from directory_listings where deleted_at is null`],

  ["listing: upsert the company card (one live row per tenant)",
    `insert into directory_listings
       (id, tenant_id, serves, company_name, headline, description, services_offered,
        corridors_served, home_base, website, fleet_size_declared, year_established,
        licence_valid_to, contact_name, contact_channel, status, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'draft',$16,$16)
     on conflict (tenant_id) where deleted_at is null
     do update set serves = excluded.serves, company_name = excluded.company_name,
       headline = excluded.headline, description = excluded.description,
       services_offered = excluded.services_offered, corridors_served = excluded.corridors_served,
       home_base = excluded.home_base, website = excluded.website,
       fleet_size_declared = excluded.fleet_size_declared,
       year_established = excluded.year_established,
       licence_valid_to = excluded.licence_valid_to,
       contact_name = excluded.contact_name, contact_channel = excluded.contact_channel,
       updated_by = excluded.updated_by`,
    [FAKE_LISTING, FAKE_TENANT, ["transporter", "cfa"], "Kilimanjaro Freight Ltd",
     "Dar to Arusha, weekly departures", "We carry containers inland.",
     "Container haulage, bonded warehousing", "Dar — Arusha — Nairobi", "Dar es Salaam",
     "https://example.co.tz", 24, 2011, "2026-12-31", "Amina Juma", "+255 700 000 000",
     FAKE_USER]],

  ["listing: publish (fires the tenant eligibility guard)",
    `update directory_listings set status = 'live', updated_by = $2
      where id = $1 and deleted_at is null`, [FAKE_LISTING, FAKE_USER]],

  ["listing: withdraw — a status change, never a delete",
    `update directory_listings set status = 'draft', updated_by = $2
      where id = $1 and deleted_at is null`, [FAKE_LISTING, FAKE_USER]],

  // ---------- The region set, rewritten whole ----------
  ["regions: clear the set",
    `delete from directory_listing_regions where listing_id = $1 and tenant_id = $2`,
    [FAKE_LISTING, FAKE_TENANT]],

  ["regions: write the set from validated ids",
    `insert into directory_listing_regions (listing_id, region_id, tenant_id)
     select $1, g.id, $2 from geo_regions g where g.id = any($3::int[]) and g.is_active`,
    [FAKE_LISTING, FAKE_TENANT, [1, 2, 3]]],

  ["regions: read the set back for the editor",
    `select region_id from directory_listing_regions
      where listing_id = $1 and tenant_id = $2 order by region_id`,
    [FAKE_LISTING, FAKE_TENANT]],

  // ---------- The seeker's meter ----------
  ["pass state in one read",
    `select platform_auth.seeker_pass_state($1) as r`, [FAKE_USER]],

  ["claim today's free search",
    `select platform_auth.claim_free_search($1) as r`, [FAKE_USER]],

  ["record a weekly pass reference (creates an unverifiable-by-themself pass)",
    `select platform_auth.record_weekly_pass($1,$2,$3) as r`,
    [FAKE_USER, "TRX/2026/0451", "mpesa"]],

  ["own pass history — the row they can read but not edit",
    `select id, kind, status, searches_allowed, searches_used, starts_at, expires_at,
            amount, currency, payment_method, payment_reference, verification_note
       from seeker_search_passes where deleted_at is null
      order by created_at desc limit 40`],

  ["own search log",
    `select id, created_at, query, filter_kind, filter_region_id, listing_id, found,
            credits_left
       from seeker_searches order by created_at desc limit 50`],

  // ---------- Spend, then read ----------
  ["spend one credit and get the claim check",
    `select platform_auth.consume_search_credit($1,$2,$3,$4,$5,$6,$7) as r`,
    [FAKE_USER, FAKE_PASS, FAKE_LISTING, "container arusha", "transporter", 4, "41.220.0.1"]],

  ["search the directory against the claim",
    `select * from directory_search($1,$2,$3,$4,$5,$6)`,
    [FAKE_SEARCH, "transporter", 4, "container", 20, 0]],

  ["page two of the same claim costs nothing",
    `select * from directory_search($1,$2,$3,$4,$5,$6)`,
    [FAKE_SEARCH, null, null, null, 60, 20]],

  ["open one card, same claim",
    `select * from directory_card_for($1,$2)`, [FAKE_LISTING, FAKE_SEARCH]],

  ["the region filter only offers regions that hold companies",
    `select region_id, region_name, companies from directory_region_counts()`],

  // ---------- Control: verify money, moderate the board ----------
  ["control: the pending payment queue",
    `select * from platform_auth.list_pending_passes()`],

  ["control: approve a recorded pass (re-bases the week on the approval instant)",
    `select platform_auth.verify_search_pass($1,$2,true,$3) as r`,
    [FAKE_PASS, FAKE_ACTOR, "Seen in the bank statement 12 Oct"]],

  ["control: refuse a recorded pass",
    `select platform_auth.verify_search_pass($1,$2,false,$3) as r`,
    [FAKE_PASS, FAKE_ACTOR, "Reference does not match any credit"]],

  ["control: the whole register with demand counts",
    `select * from platform_auth.list_directory_for_control($1)`, ["freight"]],

  ["control: suspend a listing",
    `select platform_auth.moderate_listing($1,$2,'suspend',$3) as r`,
    [FAKE_LISTING, FAKE_ACTOR, "Contact number belongs to a third party"]],

  ["control: reinstate, verify, unverify",
    `select platform_auth.moderate_listing($1,$2,'reinstate',null) as r`,
    [FAKE_LISTING, FAKE_ACTOR]],

  ["control: pass products, priced by the platform",
    `select key, name, description, window_hours, searches_allowed, price, currency, is_active, sort
       from seeker_pass_products order by sort`],

  ["control: reprice a pass product",
    `update seeker_pass_products set price = $2, updated_by = $3 where key = $1`,
    ["weekly", "3500.00", FAKE_ACTOR]],

  // ---------- Demand analytics the admin panel will read ----------
  ["analytics: searches per day",
    `select date_trunc('day', created_at) as day, count(*)::int as searches,
            count(*) filter (where found > 0)::int as with_results
       from seeker_searches
      where created_at > now() - interval '90 days'
      group by 1 order by 1`],

  ["analytics: what seekers are looking for",
    `select coalesce(filter_kind,'any') as kind, count(*)::int as n
       from seeker_searches group by 1 order by 2 desc`],

  ["analytics: the regions with demand but no supply",
    `select g.id, g.name_en,
            count(s.id)::int as searches,
            (select count(*)::int from directory_listing_regions r
               join directory_listings l on l.id = r.listing_id
              where r.region_id = g.id and l.status = 'live' and l.deleted_at is null) as listed
       from seeker_searches s join geo_regions g on g.id = s.filter_region_id
      where s.created_at > now() - interval '30 days'
      group by g.id, g.name_en order by searches desc, listed asc limit 20`],

  ["analytics: revenue recorded from passes, by month and kind",
    `select date_trunc('month', verified_at) as month, kind,
            sum(amount)::numeric(14,2) as recorded, max(currency) as currency,
            count(*)::int as passes
       from seeker_search_passes
      where status = 'live' and verified_at is not null
      group by 1, 2 order by 1 desc nulls last`],

  ["analytics: the free-to-paid funnel",
    `select count(*) filter (where kind = 'free')::int as free_passes,
            count(*) filter (where kind = 'weekly')::int as weekly_passes,
            count(*) filter (where kind = 'weekly' and status = 'live')::int as converted
       from seeker_search_passes where deleted_at is null`],

  ["analytics: top companies by searches that reached them",
    `select l.company_name, count(s.id)::int as views,
            max(s.created_at) as last_view
       from seeker_searches s join directory_listings l on l.id = s.listing_id
      where s.created_at > now() - interval '30 days'
      group by l.company_name order by views desc limit 15`],

  ["analytics: credits spent against credits sold",
    `select p.kind, sum(p.searches_allowed)::int as sold,
            sum(p.searches_used)::int as used, count(*)::int as passes
       from seeker_search_passes p where p.deleted_at is null group by 1`],

  ["analytics: a seeker's account, verification channels and what they want",
    `select sk.id, sk.first_name, sk.last_name, sk.industry, sk.country,
            sk.looking_for, sk.phone_verified_at, sk.email_verified_at,
            u.email, u.status as user_status, t.status as tenant_status,
            u.created_at as joined_at
       from seekers sk
       join users u on u.id = sk.user_id
       join tenants t on t.id = sk.tenant_id
      where sk.deleted_at is null
      order by sk.created_at desc limit 200`],

  ["analytics: listing funnel by status",
    `select status, count(*)::int as listings,
            count(*) filter (where is_verified)::int as verified
       from directory_listings where deleted_at is null group by 1`],

  ["listing: own row plus its search count (the company's view of its ad)",
    `select l.id, l.status, l.is_verified, l.published_at,
            (select count(*)::int from seeker_searches s
               join directory_listings d on d.id = s.listing_id
              where d.tenant_id = l.tenant_id) as searches
       from directory_listings l where l.deleted_at is null`]
];

type Check = [string, string, (rows: any[]) => boolean, unknown[]?];

const shapeChecks: Check[] = [
  // ---------- Every new table is RLS-scoped ----------
  ["all five new tables have RLS enabled", `
     select c.relname, c.relrowsecurity from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any($1::text[])`,
    (rows) => rows.length === 5 && rows.every((r) => r.relrowsecurity === true), [NEW_TABLES]],

  ["every one of them has at least one policy bound to app_runtime", `
     select tablename, count(*)::int as n from pg_policies
     where schemaname = 'public' and tablename = any($1::text[]) and roles = '{app_runtime}'
     group by 1`,
    (rows) => rows.length === 5 && rows.every((r) => r.n >= 1), [NEW_TABLES]],

  // ---------- The meter is not editable by the person it limits ----------
  ["seeker_search_passes gives the tenant SELECT and nothing else", `
     select privilege_type from information_schema.role_table_grants
     where grantee = 'app_runtime' and table_name = 'seeker_search_passes'`,
    (rows) => rows.length === 1 && rows[0].privilege_type === "SELECT"],

  ["its policy is a SELECT policy, so no write path exists at relation level", `
     select cmd from pg_policies where tablename = 'seeker_search_passes'`,
    (rows) => rows.length === 1 && rows[0].cmd === "SELECT"],

  ["the search log is SELECT-only too — consume is the only writer", `
     select privilege_type from information_schema.role_table_grants
     where grantee = 'app_runtime' and table_name = 'seeker_searches'`,
    (rows) => rows.length === 1 && rows[0].privilege_type === "SELECT"],

  ["seeker_searches is append-only: no updated_at, no deleted_at", `
     select column_name from information_schema.columns
     where table_name = 'seeker_searches' and column_name in ('updated_at','deleted_at')`,
    (rows) => rows.length === 0],

  ["its found column is nullable — an abandoned search must not read as zero results", `
     select is_nullable from information_schema.columns
     where table_name = 'seeker_searches' and column_name = 'found'`,
    (rows) => rows.length === 1 && rows[0].is_nullable === "YES"],

  ["directory_listings cannot be hard-deleted by the runtime role", `
     select privilege_type from information_schema.role_table_grants
     where grantee = 'app_runtime' and table_name = 'directory_listings'`,
    (rows) => rows.map((r) => r.privilege_type).sort().join(",") === "INSERT,SELECT,UPDATE"],

  ["the region set is the one hard delete in the module, and it cannot be UPDATEd", `
     select privilege_type from information_schema.role_table_grants
     where grantee = 'app_runtime' and table_name = 'directory_listing_regions'`,
    (rows) => rows.map((r) => r.privilege_type).sort().join(",") === "DELETE,INSERT,SELECT"],

  ["products keep DELETE away (deactivation is is_active)", `
     select privilege_type from information_schema.role_table_grants
     where grantee = 'app_runtime' and table_name = 'seeker_pass_products'`,
    (rows) => !rows.some((r) => r.privilege_type === "DELETE")],

  // ---------- Rule 0: the composite IS the allowlist ----------
  ["directory_card is exactly the 19 published disclosure columns", `
     select a.attname from pg_type t
     join pg_class c on c.oid = t.typrelid
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0
     where t.typname = 'directory_card' order by a.attnum`,
    (rows) => rows.map((r) => r.attname).join(",") === [
      "id", "company_name", "serves", "headline", "description", "services_offered",
      "corridors_served", "home_base", "region_names", "website", "fleet_size_declared",
      "year_established", "licence_valid_to", "licence_state", "contact_name",
      "contact_channel", "is_verified", "published_at", "total"].join(",")],

  ["and holds none of the keys Rule 0 forbids", `
     select a.attname from pg_type t
     join pg_class c on c.oid = t.typrelid
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0
     where t.typname = 'directory_card'
       and a.attname ~ '(tenant|user|tin|brla|vat|licence_number|phone|email|status|staff|cost|margin|amount|deleted)'`,
    (rows) => rows.length === 0],

  ["licence_valid_to crosses as text, so no date object leaks the column type", `
     select format_type(a.atttypid, a.atttypmod) as t from pg_type t
     join pg_class c on c.oid = t.typrelid
     join pg_attribute a on a.attrelid = c.oid and a.attname = 'licence_valid_to'
     where t.typname = 'directory_card'`,
    (rows) => rows.length === 1 && rows[0].t === "text"],

  ["there is no view over the directory — 046's rule, readers are functions", `
     select v.viewname from pg_views v
     join pg_class c on c.relname = v.viewname
     where v.schemaname = 'public'
       and pg_get_viewdef(c.oid) ilike '%directory_listings%'`  ,
    (rows) => rows.length === 0],

  // ---------- The guard that decides who may be findable ----------
  ["the eligibility guard is a BEFORE row trigger on directory_listings", `
     select tgname, tgtype, tgenabled from pg_trigger
     where not tgisinternal and tgrelid = 'directory_listings'::regclass
       and tgname = 'trg_directory_listing_guard'`,
    (rows) => rows.length === 1 && (rows[0].tgtype & 1) === 1 && (rows[0].tgtype & 2) === 2
      && rows[0].tgenabled === "O"],

  ["it is SECURITY INVOKER — it must read tenants under the caller's own rights", `
     select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'directory_listing_tenant_guard'`,
    (rows) => rows.length === 1 && rows[0].prosecdef === false],

  ["its body refuses non-transporter tenants and dead accounts, as P0001", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'directory_listing_tenant_guard'`,
    (rows) => rows.length === 1
      && /new\.status <> 'live'/.test(rows[0].def)
      && /<> 'transporter'/.test(rows[0].def)
      && /not in \('trial','active','grace'\)/.test(rows[0].def)
      && (rows[0].def.match(/errcode = 'P0001'/g) ?? []).length === 3
      && /new\.published_at := now\(\)/.test(rows[0].def)],

  ["the runtime role can actually read tenants, so the guard cannot 42501 on publish", `
     select has_table_privilege('app_runtime','tenants','select') as can`,
    (rows) => rows[0].can === true],

  // ---------- Readers ----------
  ["directory_claim_ok is SECURITY INVOKER — a route can call it directly under RLS, and from inside a definer it still binds to the session's own tenant id", `
     select p.prosecdef, p.provolatile from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'directory_claim_ok'`,
    (rows) => rows.length === 1 && rows[0].prosecdef === false && rows[0].provolatile === "s"],

  ["its body binds the claim to this tenant and to five minutes", `
     select pg_get_functiondef(p.oid) as def from pg_proc p where p.proname = 'directory_claim_ok'`,
    (rows) => /current_setting\('app\.tenant_id', true\)/.test(rows[0].def)
      && /interval '5 minutes'/.test(rows[0].def)
      && /seeker_searches/.test(rows[0].def)],

  ["both directory readers are definers with a pinned search_path", `
     select p.proname, p.prosecdef, pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('directory_search','directory_card_for','directory_region_counts')`,
    (rows) => rows.length === 3 && rows.every((r) =>
      r.prosecdef === true && /SECURITY DEFINER/.test(r.def) && /SET search_path TO 'public'/.test(r.def))],

  ["the list reader gates on the claim before it counts anything", `
     select pg_get_functiondef(p.oid) as def from pg_proc p where p.proname = 'directory_search'`,
    (rows) => /directory_claim_ok\(p_search_id\)/.test(rows[0].def)
      && /if not coalesce/.test(rows[0].def)
      && /return;/.test(rows[0].def)],

  ["and it settles the log row's found count exactly once", `
     select pg_get_functiondef(p.oid) as def from pg_proc p where p.proname = 'directory_search'`,
    (rows) => /update seeker_searches s set found = v_total/.test(rows[0].def)
      && /where s\.id = p_search_id and s\.found is null/.test(rows[0].def)],

  ["the settle update is alias-qualified, because FOUND is a reserved plpgsql variable", `
     select pg_get_functiondef(p.oid) as def from pg_proc p where p.proname = 'directory_search'`,
    // 061 wrote `where id = p_search_id and found is null`, plpgsql read `found` as its
    // own status variable and the statement died with 42702 on every list search.
    // EXPLAIN cannot catch this (it never plans inside a function body), so the shape of
    // the text is checked here and the live settle probe below runs it for real.
    (rows) => !/and found is null/.test(rows[0].def)
      && !/with found as/.test(rows[0].def)],

  ["licence_state is derived at read time, never stored", `
     select pg_get_functiondef(p.oid) as def from pg_proc p where p.proname = 'directory_search'`,
    (rows) => /when l\.licence_valid_to < current_date \+ 60 then 'expiring_soon'/.test(rows[0].def)
      && (rows[0].def.match(/not_declared|expired|expiring_soon|'valid'/g) ?? []).length >= 4],

  ["the list reader only joins global reference data", `
     select pg_get_functiondef(p.oid) as def from pg_proc p where p.proname = 'directory_search'`,
    (rows) => /geo_regions/.test(rows[0].def)
      && !/from users|join users|from seekers|join seekers|audit_logs|freight_invoices|cargo_files/.test(rows[0].def)],

  ["the meter locks the pass row before deciding", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'consume_search_credit'`,
    (rows) => /for update;/.test(rows[0].def)
      && /searches_used = searches_used \+ 1/.test(rows[0].def)
      && /nullif\(p_ip, ''\)::inet/.test(rows[0].def)],

  ["every refusal the meter can answer with is present", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'consume_search_credit'`,
    (rows) => ["no_seeker", "not_verified", "no_pass", "not_mine", "awaiting_verification",
      "not_live", "expired", "exhausted"].every((reason) =>
        new RegExp(`'reason',\\s*'${reason}'`).test(rows[0].def))],

  ["an expired pass is stamped expired as it is refused", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'consume_search_credit'`,
    (rows) => /set status = 'expired'/.test(rows[0].def)],

  ["verification writes its audit row inside the same transaction", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'verify_search_pass'`,
    (rows) => /insert into audit_logs/.test(rows[0].def)
      && /seeker_pass\.verified/.test(rows[0].def)
      && /seeker_pass\.rejected/.test(rows[0].def)
      && /status <> 'awaiting_verification'/.test(rows[0].def)],

  ["approving re-bases the week on the approval instant", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'verify_search_pass'`,
    (rows) => /starts_at = now\(\)/.test(rows[0].def)
      && /make_interval\(hours => coalesce\(v_product\.window_hours, 168\)\)/.test(rows[0].def)],

  ["moderation assigns its locals after the select, not in DECLARE", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'moderate_listing'`,
    (rows) => !/v_status text :=/.test(rows[0].def)
      && !/v_verified boolean :=/.test(rows[0].def)
      && /v_status := v_listing\.status;/.test(rows[0].def)
      && /v_verified := v_listing\.is_verified;/.test(rows[0].def)
      && /'directory\.' \|\| p_action/.test(rows[0].def)],

  ["a suspension cannot be issued without a reason", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'moderate_listing'`,
    (rows) => /char_length\(coalesce\(trim\(p_note\), ''\)\) < 4/.test(rows[0].def)],

  ["a reinstate runs back through the guard, so a dead tenant stays unpublished", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'moderate_listing'`,
    (rows) => /v_status := 'live';/.test(rows[0].def)],

  ["the free credit is anchored on the claim, not the search", `
     select pg_get_functiondef(p.oid) as def from pg_proc p where p.proname = 'claim_free_search'`,
    (rows) => /v_recent\.created_at > now\(\) - interval '24 hours'/.test(rows[0].def)
      && /'reason', 'wait'/.test(rows[0].def)
      && /'reason', 'has_live_pass'/.test(rows[0].def)],

  ["recording a payment demands a reference and a method, and cannot create a live pass", `
     select pg_get_functiondef(p.oid) as def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'record_weekly_pass'`,
    (rows) => /char_length\(v_ref\) < 4/.test(rows[0].def)
      && /p_method is null/.test(rows[0].def)
      && /'awaiting_verification'/.test(rows[0].def)
      && !/'status', 'live'/.test(rows[0].def)],

  // ---------- Vocabularies ----------
  ["the four vocabularies are closed CHECKs read from the catalogue", `
     select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
       from pg_constraint where contype = 'c'
       and conrelid::regclass::text = any($1::text[])`,
    (rows) => {
      const find = (t: string, c: string) => rows.find((r) => r.tbl === t && r.conname === c)?.def ?? "";
      return /ARRAY\['transporter'::text, 'cfa'::text\]/.test(find("directory_listings", "directory_listings_serves_check"))
        && /ARRAY\['draft'::text, 'live'::text, 'suspended'::text\]/.test(find("directory_listings", "directory_listings_status_check"))
        && /ARRAY\['free'::text, 'weekly'::text\]/.test(find("seeker_search_passes", "seeker_search_passes_kind_check"))
        && /awaiting_verification/.test(find("seeker_search_passes", "seeker_search_passes_status_check"))
        && /cancelled/.test(find("seeker_search_passes", "seeker_search_passes_status_check"))
        && /bank_transfer/.test(find("seeker_search_passes", "seeker_search_passes_payment_method_check"))
        && /ARRAY\['transporter'::text, 'cfa'::text\]/.test(find("seeker_searches", "seeker_searches_filter_kind_check"));
    }, [["directory_listings", "seeker_search_passes", "seeker_searches", "seeker_pass_products"]]],

  ["a pass can never be over-spent — the invariant is in the table, not the route", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conname = 'seeker_search_passes_check'`,
    (rows) => rows.length === 1 && /expires_at > starts_at/.test(rows[0].def)
      && /searches_used <= searches_allowed/.test(rows[0].def)],

  ["money is exact decimal in one declared currency, on both sides", `
     select table_name, column_name, data_type, numeric_precision, numeric_scale
       from information_schema.columns
      where table_name in ('seeker_pass_products','seeker_search_passes')
        and column_name in ('price','amount','currency')
      order by table_name, column_name`,
    (rows) => rows.length === 4
      && rows.filter((r) => r.data_type === "numeric").every((r) => r.numeric_precision === 12 && r.numeric_scale === 2)
      && rows.every((r) => r.data_type !== "double precision" && r.data_type !== "real")],

  ["both currency columns are pinned to TZS by a CHECK", `
     select conname, pg_get_constraintdef(oid) as def from pg_constraint where contype = 'c'
       and conname in ('seeker_pass_products_currency_check','seeker_search_passes_currency_check')`,
    (rows) => rows.length === 2 && rows.every((r) => /currency = 'TZS'/.test(r.def))],

  // ---------- Seeds ----------
  ["the two products match the brief: one free search a day, 30 searches for 3,000 TZS a week", `
     select key, window_hours, searches_allowed, price, currency, is_active from seeker_pass_products order by sort`,
    (rows) => rows.length === 2
      && rows[0].key === "free" && rows[0].window_hours === 24 && rows[0].searches_allowed === 1
      && String(rows[0].price) === "0.00" && rows[0].currency === "TZS"
      && rows[1].key === "weekly" && rows[1].window_hours === 168 && rows[1].searches_allowed === 30
      && String(rows[1].price) === "3000.00" && rows[1].currency === "TZS"],

  // ---------- Indexes ----------
  ["one live listing per tenant, enforced where deleted_at is null", `
     select indexdef from pg_indexes where tablename = 'directory_listings'
       and indexname = 'directory_listings_tenant_uq'`,
    (rows) => rows.length === 1 && /UNIQUE INDEX/.test(rows[0].indexdef)
      && /btree \(tenant_id\)/.test(rows[0].indexdef) && /deleted_at IS NULL/.test(rows[0].indexdef)],

  ["the serves filter is a GIN scan over the live slice only", `
     select indexdef from pg_indexes where indexname = 'directory_live_serves_idx'`,
    (rows) => rows.length === 1 && /gin \(serves\)/.test(rows[0].indexdef)
      && /status = 'live'/.test(rows[0].indexdef)],

  ["the pending payment queue is a partial index, not a scan of every pass", `
     select indexdef from pg_indexes where indexname = 'seeker_search_passes_pending_idx'`,
    (rows) => rows.length === 1 && /status = 'awaiting_verification'/.test(rows[0].indexdef)],

  ["a duplicate region on one listing is refused by the database", `
     select indexdef from pg_indexes where indexname = 'directory_listing_regions_uq'`,
    (rows) => rows.length === 1 && /btree \(listing_id, region_id\)/.test(rows[0].indexdef)],

  ["regions are real foreign keys, not an int array", `
     select confrelid::regclass::text as refs from pg_constraint
     where contype = 'f' and conrelid = 'directory_listing_regions'::regclass`,
    (rows) => ["directory_listings", "geo_regions", "tenants"]
      .every((t) => rows.some((r) => r.refs === t))],

  ["the cascade that cleans the region set with its listing", `
     select confdeltype from pg_constraint
     where contype = 'f' and conrelid = 'directory_listing_regions'::regclass
       and confrelid = 'directory_listings'::regclass`,
    (rows) => rows.length === 1 && rows[0].confdeltype === "c"],

  // ---------- Privilege posture ----------
  ["every new function is reachable by app_runtime", `
     select p.proname, has_function_privilege('app_runtime', p.oid, 'execute') as can
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname = 'public' and p.proname in
               ('directory_search','directory_card_for','directory_region_counts','directory_claim_ok'))
         or (n.nspname = 'platform_auth' and p.proname in
               ('claim_free_search','record_weekly_pass','consume_search_credit','seeker_pass_state',
                'verify_search_pass','moderate_listing','list_pending_passes','list_directory_for_control'))`,
    (rows) => rows.length === 12 && rows.every((r) => r.can === true)],

  ["directory_claim_ok is EXECUTE-able even though it is not a definer", `
     select has_function_privilege('app_runtime','directory_claim_ok(uuid)','execute') as can`,
    (rows) => rows[0].can === true],

  ["no browser role can call any of them — PUBLIC EXECUTE swept here, not only by 051", `
     select p.proname,
            has_function_privilege('anon', p.oid, 'execute') as anon_x,
            has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
            has_function_privilege('public', p.oid, 'execute') as public_x,
            has_function_privilege('service_role', p.oid, 'execute') as svc_x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname = 'public' and p.proname in
               ('directory_search','directory_card_for','directory_region_counts','directory_claim_ok'))
         or (n.nspname = 'platform_auth' and p.proname in
               ('claim_free_search','record_weekly_pass','consume_search_credit','seeker_pass_state',
                'verify_search_pass','moderate_listing','list_pending_passes','list_directory_for_control'))`,
    (rows) => rows.length === 12 && rows.every((r) =>
      r.anon_x === false && r.auth_x === false && r.public_x === false && r.svc_x === false)],

  ["the trigger function is not callable by a session at all", `
     select has_function_privilege('anon','directory_listing_tenant_guard()','execute') as anon_x,
            has_function_privilege('public','directory_listing_tenant_guard()','execute') as public_x,
            has_function_privilege('app_runtime','directory_listing_tenant_guard()','execute') as ar_x`,
    (rows) => rows[0].anon_x === false && rows[0].public_x === false && rows[0].ar_x === false],

  ["no browser role holds a table privilege on any of the five", `
     select grantee, table_name, privilege_type from information_schema.role_table_grants
      where grantee in ('anon','authenticated')
        and table_name = any($1::text[])`,
    (rows) => rows.length === 0, [NEW_TABLES]],

  // ---------- Permissions ----------
  ["the five new permission keys exist with directory descriptions", `
     select key from permissions where key like 'directory.%' or key like 'seeker_pass.%' order by key`,
    (rows) => rows.map((r) => r.key).join(",") ===
      "directory.manage,directory.search,directory.view,seeker_pass.create,seeker_pass.view"],

  ["the seeker role holds exactly what 060 deferred — search and its own meter", `
     select rp.permission_key from role_permissions rp join roles r on r.id = rp.role_id
      where r.key = 'seeker' and r.tenant_id is null order by 1`,
    (rows) => rows.map((r) => r.permission_key).join(",") ===
      "directory.search,seeker_pass.create,seeker_pass.view,seeker_profile.edit,seeker_profile.view"],

  ["the seeker role holds none of the company-side keys", `
     select rp.permission_key from role_permissions rp join roles r on r.id = rp.role_id
      where r.key = 'seeker' and r.tenant_id is null
        and rp.permission_key in ('directory.view','directory.manage')`,
    (rows) => rows.length === 0],

  ["only director can publish; the two managers can view their own listing", `
     select r.key, rp.permission_key from role_permissions rp
      join roles r on r.id = rp.role_id
      where r.tenant_id is null and rp.permission_key like 'directory%'
      order by r.key, rp.permission_key`,
    (rows) => {
      const has = (role: string, key: string) =>
        rows.some((r) => r.key === role && r.permission_key === key);
      return has("director", "directory.manage") && has("director", "directory.view")
        && has("general_manager", "directory.view") && has("operations_manager", "directory.view")
        && !has("general_manager", "directory.manage") && !has("operations_manager", "directory.manage")
        && !rows.some((r) => r.key === "shipper_portal");
    }],

  ["updated_at is stamped on the two tables that can change", `
     select tgname from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal and c.relname in
       ('directory_listings','seeker_pass_products','seeker_search_passes')
       and t.tgname like '%_updated'`,
    (rows) => rows.length === 3],

  ["the log and the region set have no updated_at — neither is edited", `
     select table_name, column_name from information_schema.columns
      where column_name = 'updated_at' and table_name in ('seeker_searches','directory_listing_regions')`,
    (rows) => rows.length === 0],

  ["the listing carries no financial or identity column for a reader to reach", `
     select column_name from information_schema.columns
      where table_name = 'directory_listings'
        and column_name ~ '(tin|brla|vat|phone|email|bank|cost|margin|invoice)'`,
    (rows) => rows.length === 0]
];

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL");

/** The dev URL connects as the owner role, which bypasses RLS — so every posture
 *  assertion below has to run as app_runtime for real. Same rebuild as
 *  verify-seeker-sql.ts and verify-isolation.ts. */
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

/** FK-ordered removal of one probe tenant and everything the probe hung off it. The
 *  script never writes through the app, so it writes no audit row and leaves nothing
 *  an append-only trigger can complain about. */
async function reapProbeTenant(oi: pg.Client, tenantId: string) {
  for (const t of ["seeker_searches", "seeker_search_passes", "directory_listing_regions",
    "directory_listings", "users"]) {
    await oi.query(`delete from ${t} where tenant_id = $1`, [tenantId]).catch(() => null);
  }
  await oi.query("delete from tenants where id = $1", [tenantId]).catch(() => null);
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  let failed = 0;

  for (const [label, sql, params = []] of statements) {
    try {
      await pool.query("explain " + sql, params);
      console.log("ok    ", label);
    } catch (e: any) {
      failed++;
      console.log("FAIL  ", label, "-", e.message);
    }
  }

  for (const [label, sql, ok, params = []] of shapeChecks) {
    try {
      const { rows } = await pool.query(sql, params);
      const pass = ok(rows);
      console.log(pass ? "ok   " : "FAIL ", label, pass ? "" : `-> ${JSON.stringify(rows).slice(0, 300)}`);
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

      // 1. THE HEADLINE. The read path answers for a claim this tenant paid for and
      //    for nothing else — no token, no route logic, just the database.
      await c.query("select set_config('app.tenant_id', $1, false)", [FAKE_TENANT]);
      const noClaim = await c.query(
        `select count(*)::int as n from directory_search($1, null, null, null, 20, 0)`,
        [FAKE_SEARCH]);
      console.log(noClaim.rows[0].n === 0
        ? "ok     directory_search returns nothing for a fabricated claim id"
        : `FAIL  directory_search returned ${noClaim.rows[0].n} rows without a paid credit`);
      if (noClaim.rows[0].n !== 0) failed++;

      const card = await c.query(
        `select directory_card_for($1, $2) as card`, [FAKE_LISTING, FAKE_SEARCH]);
      // directory_card_for is a scalar definer, so "refused" arrives as a NULL
      // composite rather than as an absent row — the whole card must be gone.
      console.log(card.rows[0].card === null
        ? "ok     directory_card_for returns a null card for a fabricated claim id"
        : `FAIL  directory_card_for answered without a claim: ${JSON.stringify(card.rows[0].card).slice(0, 140)}`);
      if (card.rows[0].card !== null) failed++;

      // 2. No context at all -> the claim checker itself sees no log rows.
      await c.query("select set_config('app.tenant_id', '', false)");
      const claim = await c.query("select directory_claim_ok($1) as ok", [FAKE_SEARCH]);
      console.log(claim.rows[0].ok === false
        ? "ok     directory_claim_ok is false with no tenant context"
        : "FAIL  directory_claim_ok passed with no tenant context");
      if (claim.rows[0].ok !== false) failed++;

      // 3. The meter is not editable by the account it limits. Every one of these must
      //    fail at the privilege check, before RLS or a CHECK ever gets a say.
      const forbidden: [string, string, unknown[]][] = [
        ["UPDATE seeker_search_passes",
          `update seeker_search_passes set searches_allowed = 500 where id = $1`, [FAKE_PASS]],
        ["INSERT seeker_search_passes",
          `insert into seeker_search_passes (tenant_id, user_id, product_id, kind,
             searches_allowed, expires_at)
           values ($1,$2,$3,'weekly',500, now() + interval '7 days')`,
          [FAKE_TENANT, FAKE_USER, FAKE_PRODUCT]],
        ["DELETE seeker_search_passes",
          `delete from seeker_search_passes where id = $1`, [FAKE_PASS]],
        ["UPDATE seeker_searches",
          `update seeker_searches set found = 999 where id = $1`, [FAKE_SEARCH]],
        ["INSERT seeker_searches",
          `insert into seeker_searches (tenant_id, user_id, pass_id, credits_left)
           values ($1,$2,$3,500)`, [FAKE_TENANT, FAKE_USER, FAKE_PASS]],
        ["DELETE seeker_searches",
          `delete from seeker_searches where id = $1`, [FAKE_SEARCH]],
        ["DELETE directory_listings",
          `delete from directory_listings where id = $1`, [FAKE_LISTING]]
      ];
      for (const [what, sql, params] of forbidden) {
        try {
          await c.query(sql, params);
          console.log(`FAIL  app_runtime can ${what}`);
          failed++;
        } catch (e: any) {
          console.log(/permission denied/i.test(e.message)
            ? `ok     ${what} refused to the runtime role`
            : `FAIL  ${what} failed for another reason: ${e.message}`);
          if (!/permission denied/i.test(e.message)) failed++;
        }
      }

      // 4. A listing for a tenant the session does not hold cannot be written. The
      //    refusal can arrive from the RLS with_check or from the FK to tenants, since
      //    neither probe tenant exists — what must never happen is a landing.
      await c.query("select set_config('app.tenant_id', $1, false)", [FAKE_TENANT]);
      try {
        await c.query(
          `insert into directory_listings (id, tenant_id, serves, company_name,
             contact_name, contact_channel, status)
           values ($1,$2,'{transporter}','Probe Freight','Probe Contact','+255 700 000 000','draft')`,
          ["cccccccc-1111-4111-8111-111111111111", OTHER_TENANT]);
        console.log("FAIL  a directory listing landed for a tenant the session does not hold");
        failed++;
      } catch (e: any) {
        console.log(`ok     cross-tenant listing insert refused (${e.code ?? e.message})`);
      }

      // 5. Positive controls — the revocations must not have cost the app anything.
      const prod = await c.query("select count(*)::int as n from seeker_pass_products");
      console.log(prod.rows[0].n === 2
        ? "ok     app_runtime reads both pass products"
        : `FAIL  app_runtime saw ${prod.rows[0].n} pass products, expected 2`);
      if (prod.rows[0].n !== 2) failed++;

      const state = await c.query("select platform_auth.seeker_pass_state($1) as r", [FAKE_USER]);
      const st = state.rows[0].r;
      console.log(st?.found === false
        ? "ok     seeker_pass_state is reachable and fail-closed for an unknown user"
        : `FAIL  seeker_pass_state answered ${JSON.stringify(st).slice(0, 160)}`);
      if (st?.found !== false) failed++;

      const counts = await c.query("select count(*)::int as n from directory_region_counts()");
      console.log(typeof counts.rows[0].n === "number"
        ? "ok     directory_region_counts executes for the runtime role"
        : "FAIL  directory_region_counts is not callable");
      if (typeof counts.rows[0].n !== "number") failed++;

      const spend = await c.query(
        `select (platform_auth.consume_search_credit($1,$2,null,null,null,null,null)->>'reason') as r`,
        [FAKE_USER, FAKE_PASS]);
      console.log(spend.rows[0].r === "no_seeker"
        ? "ok     the meter answers no_seeker for an unknown user rather than erroring"
        : `FAIL  the meter answered ${spend.rows[0].r}`);
      if (spend.rows[0].r !== "no_seeker") failed++;

      const pending = await c.query("select count(*)::int as n from platform_auth.list_pending_passes()");
      const register = await c.query("select count(*)::int as n from platform_auth.list_directory_for_control(null)");
      console.log(pending.rows[0].n >= 0 && register.rows[0].n >= 0
        ? `ok     control readers answer (pending=${pending.rows[0].n} register=${register.rows[0].n})`
        : "FAIL  a control reader is broken");
      if (!(pending.rows[0].n >= 0 && register.rows[0].n >= 0)) failed++;

      // 6. Nothing of this belongs to an anon session.
      await c.query("select set_config('app.tenant_id', '', false)");
      const orphan = await c.query("select count(*)::int as n from directory_listings");
      console.log(orphan.rows[0].n === 0
        ? "ok     directory_listings reads 0 rows with no tenant context"
        : `FAIL  directory_listings leaked ${orphan.rows[0].n} rows with no tenant context`);
      if (orphan.rows[0].n !== 0) failed++;

      // 7. THE OPPOSITE DIRECTION — a claim that really exists must be answered, and
      //    answered by executing the body. Steps 1-6 can only ever see the first line
      //    of directory_search: with a fabricated id the claim guard returns before
      //    the count, the settle update and the page are reached, so a raise anywhere
      //    past that guard is invisible to them. This is the probe that catches 061's
      //    ambiguous `found` reference — the bug that made every paid search a 500.
      const stamp = Date.now().toString(36);
      const pTenant = randomUUID();
      const pUser = randomUUID();
      const pPass = randomUUID();
      const pSearch = randomUUID();
      const pListing = randomUUID();
      const oi = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
      let built = false;
      try {
        await oi.connect();
        built = true;
        // A run that died mid-probe left its fixtures behind, so the script reaps its
        // own history before it starts rather than accumulating live listings.
        const stale = await oi.query("select id from tenants where name like 'Probe Directory %'");
        for (const r of stale.rows) await reapProbeTenant(oi, r.id);
        const free = await oi.query("select id from seeker_pass_products where key = 'free'");
        const reg = await oi.query("select id from geo_regions where is_active order by id limit 1");
        await oi.query(
          `insert into tenants (id, type, name, status)
           values ($1,'transporter',$2,'active')`, [pTenant, `Probe Directory ${stamp}`]);
        await oi.query(
          `insert into users (id, tenant_id, user_type, full_name, status, email)
           values ($1,$2,'staff','Probe Seeker','active',$3)`,
          [pUser, pTenant, `dir.probe.${stamp}@waisha.test`]);
        await oi.query(
          `insert into seeker_search_passes (id, tenant_id, user_id, product_id, kind, status,
             searches_allowed, searches_used, expires_at)
           values ($1,$2,$3,$4,'free','live',1,1, now() + interval '20 hours')`,
          [pPass, pTenant, pUser, free.rows[0].id]);
        // found is left NULL on purpose: settling it is the thing under test.
        await oi.query(
          `insert into seeker_searches (id, tenant_id, user_id, pass_id, query, credits_left)
           values ($1,$2,$3,$4,'probe settle',0)`, [pSearch, pTenant, pUser, pPass]);
        // The listing goes in live straight from the owner role, so the 061 eligibility
        // guard runs for real on this insert — it only lands because the tenant is a
        // live transporter.
        await oi.query(
          `insert into directory_listings (id, tenant_id, serves, company_name, headline,
             home_base, contact_name, contact_channel, status)
           values ($1,$2,'{transporter}',$3,'Probe fixture card','Dar es Salaam',
                   'Probe Contact','+255 700 000 111','live')`,
          [pListing, pTenant, `Probe Directory Co ${stamp}`]);
        await oi.query(
          `insert into directory_listing_regions (listing_id, region_id, tenant_id)
           values ($1,$2,$3)`, [pListing, reg.rows[0].id, pTenant]);

        await c.query("select set_config('app.tenant_id', $1, false)", [pTenant]);
        const page1 = await c.query(
          `select count(*)::int as n, min(total)::int as total
             from directory_search($1, null, null, 'probe', 20, 0)`, [pSearch]);
        console.log(page1.rows[0].n === 1 && page1.rows[0].total === 1
          ? "ok     directory_search executes end-to-end for a paid claim"
          : `FAIL  directory_search on a real claim returned ${page1.rows[0].n} rows, total=${page1.rows[0].total}`);
        if (!(page1.rows[0].n === 1 && page1.rows[0].total === 1)) failed++;

        const settled = await c.query("select found from seeker_searches where id = $1", [pSearch]);
        console.log(settled.rows[0].found === 1
          ? "ok     the first read settled the log row with its result count"
          : `FAIL  the log row settled as ${settled.rows[0].found} — the settle update raised or skipped`);
        if (settled.rows[0].found !== 1) failed++;

        const page2 = await c.query(
          `select count(*)::int as n from directory_search($1, null, null, 'probe', 20, 20)`, [pSearch]);
        const restamped = await c.query("select found from seeker_searches where id = $1", [pSearch]);
        console.log(page2.rows[0].n === 0 && restamped.rows[0].found === 1
          ? "ok     page two is free and leaves the settled count alone"
          : `FAIL  page two read ${page2.rows[0].n} rows and left found=${restamped.rows[0].found}`);
        if (!(page2.rows[0].n === 0 && restamped.rows[0].found === 1)) failed++;
      } catch (e: any) {
        failed++;
        console.log("FAIL  settle-path probe -", e.code ? `${e.code} ${e.message}` : e.message);
      } finally {
        if (built) {
          await reapProbeTenant(oi, pTenant);
          // Checked by name, not by this run's ids: a previous crashed run's fixtures
          // would otherwise pass for residue this run never made.
          const residue = await oi.query(
            `select (select count(*) from tenants t where t.name like 'Probe Directory %') as tenants,
                    (select count(*) from directory_listings l
                       where l.company_name like 'Probe Directory Co %') as listings,
                    (select count(*) from seeker_searches s where s.query = 'probe settle') as searches,
                    (select count(*) from users u where u.full_name = 'Probe Seeker') as users`).catch(() => null);
          const clean = !!residue && Object.values(residue.rows[0]).every((n: any) => Number(n) === 0);
          console.log(clean
            ? "ok     probe fixtures cleaned up"
            : `FAIL  probe residue: ${JSON.stringify(residue?.rows?.[0] ?? "residue query failed")}`);
          if (!clean) failed++;
          await oi.end().catch(() => null);
        }
      }
    } catch (e: any) {
      failed++;
      console.log("FAIL  app_runtime posture probe -", e.message);
    } finally {
      await c.end().catch(() => null);
    }
  }

  if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log(`directory SQL and 061 shape valid (${statements.length} statements, ${shapeChecks.length} shape checks)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
