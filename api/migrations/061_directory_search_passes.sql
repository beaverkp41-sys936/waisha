-- 061: The company directory, seeker search passes and the metering that spends them.
--
-- 060 built the seeker ACCOUNT. This builds the thing they came for: a list of
-- transporters and clearing agents they can search, and the meter that decides how
-- often they may.
--
-- ============================
-- RULE 0, AGAIN, IN THE SAME SHAPE AS 046
-- ============================
--
-- A seeker must be able to read companies that are not theirs, and nothing else in
-- this schema lets any role read another tenant's rows. So the directory does not
-- get a wider policy on company_profiles — it gets a published COPY.
--
-- directory_listings holds the fields the company chose to publish, written when it
-- publishes. The read path is one SECURITY DEFINER function returning a fixed
-- composite (directory_card), EXECUTE-granted to app_runtime and revoked from every
-- browser role. It joins only geo_regions, which is global reference data.
-- company_profiles, branches, users, tenants, invoices and documents are not
-- reachable from it, exactly as the board's board_card works.
--
-- What that buys, concretely: TIN, BRLA and VAT numbers, the licence NUMBER, the
-- tenant id, encrypted phones, staff rosters and every financial figure stay out of
-- the directory because they are not columns of directory_card. Adding one is a
-- visible migration, not a forgotten WHERE clause. A company that edits its profile
-- re-publishes its listing; the two copies are allowed to differ for as long as it
-- does not, which is why published_at exists and why the admin panel can see it.
--
-- The licence is published as a STATE (valid / expiring_soon / expired /
-- not_declared) derived from a copied expiry date at read time, never as the number.
-- A seeker vetting a carrier needs to know the licence is live; they do not need the
-- register entry, and the board's own card (044/046) never published it either.
--
-- "serves" uses the same closed vocabulary as seekers.looking_for from 060
-- (transporter | cfa) so a match is one array overlap and the two ends of the
-- marketplace cannot drift apart into different words for the same thing.
--
-- ============================
-- METERING: THE PASS TABLE IS READ-ONLY FOR ITS OWNER
-- ============================
--
-- A search costs a credit. credits live in seeker_search_passes, and the tenant that
-- owns them is granted SELECT ONLY. Every mutation — claiming a free credit,
-- recording a payment reference, spending a credit, an admin approving one — is a
-- definer function. The reason is the same one 048 had for refusing to let clients
-- set a booking status: if the account holder can UPDATE the row, they can edit
-- searches_allowed to 500 and the meter is decoration.
--
-- Spend is a single guarded statement under a row lock, so two searches fired in the
-- same instant resolve to one winner and one 'exhausted' — the transport_book_request
-- pattern, applied to a counter instead of a status. The spend returns a claim check
-- (the seeker_searches row id) and the read path will not answer without it, so the
-- meter cannot be skipped by a route that forgets to call consume first.
--
-- ============================
-- MONEY IS RECORDED, NEVER COLLECTED
-- ============================
--
-- The 3,000 TZS weekly pass is priced in seeker_pass_products (admin-editable, like
-- the 060 bundles and the plans ladder) and copied onto the pass at claim time. What
-- the seeker supplies is a typed reference — a mobile money transaction code, a bank
-- slip number — and nothing else. No provider, no API call, no credentials, no card
-- or PIN in any column. The pass stays 'awaiting_verification' until a person who
-- has actually seen the money flips it in the control panel, and that flip is audited
-- inside the same transaction as the change (010's idiom).
--
-- Prices are numeric(12,2) with an explicit currency, as plans and service_groups
-- already do — exact decimal, never a float.

begin;

-- ============================
-- PASS PRODUCTS (platform-owned reference data, 047/060 posture)
-- ============================

-- The two things a seeker can hold, priced and bounded by the platform rather than
-- hard-coded in the functions that issue them. window_hours is one column instead of
-- a free text '24 hours' / '7 days' pair so the claim and the verification paths
-- cannot disagree about how long a pass lasts.
create table if not exists seeker_pass_products (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key in ('free','weekly')),
  name text not null,
  description text,
  window_hours int not null check (window_hours between 1 and 8760),
  searches_allowed int not null check (searches_allowed between 1 and 500),
  price numeric(12,2) not null default 0 check (price >= 0),
  currency text not null default 'TZS' check (currency = 'TZS'),
  is_active boolean not null default true,
  sort int not null default 0,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_seeker_pass_products_active
  on seeker_pass_products (sort) where is_active;

alter table seeker_pass_products enable row level security;
grant select, insert, update on seeker_pass_products to app_runtime;
create policy seeker_pass_products_read on seeker_pass_products
  for select to app_runtime using (true);
create policy seeker_pass_products_insert on seeker_pass_products
  for insert to app_runtime with check (true);
create policy seeker_pass_products_update on seeker_pass_products
  for update to app_runtime using (true) with check (true);

create trigger trg_seeker_pass_products_updated before update on seeker_pass_products
  for each row execute function public.set_updated_at();

insert into seeker_pass_products
  (key, name, description, window_hours, searches_allowed, price, sort)
values
  ('free', 'One free search',
   'One search of the directory, available once every 24 hours. Costs nothing and needs no payment reference.',
   24, 1, 0.00, 1),
  ('weekly', 'Weekly search pass',
   'Searches for 7 days from the moment the payment is confirmed, at 3,000 TZS. Payment is recorded with your reference and confirmed by the WAISHA office — nothing is charged inside the app.',
   168, 30, 3000.00, 2)
on conflict (key) do nothing;

-- ============================
-- DIRECTORY LISTINGS
-- ============================

create table if not exists directory_listings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- Declared, not derived: a company says whether it carries freight, clears it, or
  -- both. tenants.type cannot answer this (transporter and CFA work happen in one
  -- tenant, the dual-role decision from step 4) and a CHECK cannot read another table.
  serves text[] not null
    check (serves <@ array['transporter','cfa']
           and array_length(serves, 1) between 1 and 2),

  -- Published copy of the company card. Bounds mirror transport_requests (044), which
  -- already carries these same disclosures to other companies.
  company_name text not null check (char_length(trim(company_name)) between 2 and 200),
  headline text check (headline is null or char_length(trim(headline)) between 6 and 140),
  description text check (description is null or char_length(description) <= 1200),
  services_offered text check (services_offered is null or char_length(services_offered) <= 600),
  corridors_served text check (corridors_served is null or char_length(corridors_served) <= 600),
  home_base text check (home_base is null or char_length(trim(home_base)) between 2 and 200),
  website text check (website is null or char_length(website) <= 300),
  fleet_size_declared int check (fleet_size_declared is null or fleet_size_declared between 0 and 20000),
  year_established int check (year_established is null or year_established between 1900 and 2100),
  -- Copied from company_profiles.transport_licence_expiry at publish time. The number
  -- itself is deliberately absent.
  licence_valid_to date,

  -- The one named person a seeker may contact, on the one channel the company typed
  -- for publication. Same discipline as transport_requests.contact_name /
  -- _channel: never a user id, never a staff member's sealed phone.
  contact_name text not null check (char_length(trim(contact_name)) between 2 and 120),
  contact_channel text not null check (char_length(trim(contact_channel)) between 5 and 160),

  status text not null default 'draft'
    check (status in ('draft','live','suspended')),
  suspension_reason text
    check (suspension_reason is null or char_length(trim(suspension_reason)) between 4 and 400),
  -- The platform badge is separate from status: an unverified listing is still
  -- findable, and a suspended one is not findable whether or not it was verified.
  is_verified boolean not null default false,
  verified_at timestamptz,
  verified_by uuid,
  published_at timestamptz,

  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index directory_listings_tenant_uq
  on directory_listings (tenant_id) where deleted_at is null;
create index directory_live_idx on directory_listings (company_name)
  where status = 'live' and deleted_at is null;
create index directory_live_serves_idx on directory_listings using gin (serves)
  where status = 'live' and deleted_at is null;

alter table directory_listings enable row level security;
-- No DELETE: withdrawing from the directory is status='draft', not deletion, so the
-- moderation history of a company stays intact.
grant select, insert, update on directory_listings to app_runtime;
create policy directory_listings_tenant on directory_listings
  for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create trigger trg_directory_listings_updated before update on directory_listings
  for each row execute function public.set_updated_at();

-- Only a company whose account can actually operate may be findable. A
-- pending_verification tenant has not started a trial; an expired or suspended one
-- has stopped paying; a 'shipper' or 'seeker' tenant is a person, not a carrier.
-- Enforced here rather than in a CHECK because it has to read tenants.
--
-- The eligibility test runs only when the row is being MADE live. A suspension is an
-- update to a 'suspended'/'live' row by an admin, and if the guard tested eligibility
-- on every write it would refuse to suspend the very listings whose tenant has gone
-- bad — which is the one case suspension exists for.
create or replace function directory_listing_tenant_guard() returns trigger
language plpgsql as $$
declare
  v_type text;
  v_status text;
begin
  if new.status <> 'live' then
    return new;
  end if;
  select type, status into v_type, v_status from tenants where id = new.tenant_id;
  if v_type is null then
    raise exception 'This account no longer exists, so it cannot be published.'
      using errcode = 'P0001';
  end if;
  if v_type <> 'transporter' then
    raise exception 'Only a transport or clearing company can be listed in the directory.'
      using errcode = 'P0001';
  end if;
  if v_status not in ('trial','active','grace') then
    raise exception 'This company account is "%", so it cannot be published yet.', v_status
      using errcode = 'P0001';
  end if;
  -- First time on the board: stamp it here so no route has to remember to.
  if new.published_at is null then
    new.published_at := now();
  end if;
  return new;
end $$;

create trigger trg_directory_listing_guard before insert or update
  on directory_listings for each row
  execute function public.directory_listing_tenant_guard();

-- Regions the company says it works in. A child table rather than int[] so the ids
-- are real foreign keys — an array of region ids can hold 9999 and nothing notices.
-- This is the one hard delete in the module: the region set is rewritten whole on
-- every save, the same shape as quotation_items (052) and freight_invoice_items (041).
create table if not exists directory_listing_regions (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references directory_listings(id) on delete cascade,
  region_id int not null references geo_regions(id),
  tenant_id uuid not null references tenants(id),
  created_at timestamptz not null default now()
);
create unique index directory_listing_regions_uq
  on directory_listing_regions (listing_id, region_id);
create index directory_listing_regions_region_idx
  on directory_listing_regions (region_id);

alter table directory_listing_regions enable row level security;
grant select, insert, delete on directory_listing_regions to app_runtime;
create policy directory_listing_regions_tenant on directory_listing_regions
  for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ============================
-- SEARCH PASSES
-- ============================

create table if not exists seeker_search_passes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  product_id uuid not null references seeker_pass_products(id),
  -- Copied from the product at claim time so a later price change cannot rewrite the
  -- history of a pass that was already bought, and so analytics can group without a
  -- join back through products.
  kind text not null check (kind in ('free','weekly')),
  status text not null default 'live'
    check (status in ('awaiting_verification','live','rejected','expired','cancelled')),
  searches_allowed int not null check (searches_allowed between 1 and 500),
  searches_used int not null default 0 check (searches_used >= 0),
  -- An issued pass always starts inside its own allowance; only a definer spends it.
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  amount numeric(12,2) not null default 0 check (amount >= 0),
  currency text not null default 'TZS' check (currency = 'TZS'),
  payment_method text check (payment_method is null or
    payment_method in ('mpesa','airtel_money','tigo_pesa','halotel_cash','bank_transfer','cash','other')),
  payment_reference text
    check (payment_reference is null or char_length(trim(payment_reference)) between 4 and 80),
  verified_by uuid,
  verified_at timestamptz,
  verification_note text
    check (verification_note is null or char_length(verification_note) <= 400),
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (expires_at > starts_at and searches_used <= searches_allowed)
);
create index seeker_search_passes_owner_idx
  on seeker_search_passes (tenant_id, expires_at desc) where deleted_at is null;
create index seeker_search_passes_pending_idx
  on seeker_search_passes (created_at)
  where status = 'awaiting_verification' and deleted_at is null;

alter table seeker_search_passes enable row level security;
-- SELECT ONLY. The row belongs to the seeker but the meter is not theirs to set; the
-- definer functions below are the only writers.
grant select on seeker_search_passes to app_runtime;
create policy seeker_search_passes_read on seeker_search_passes
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create trigger trg_seeker_search_passes_updated before update on seeker_search_passes
  for each row execute function public.set_updated_at();

-- ============================
-- SEARCH LOG (append-only, and the demand data the admin panel reads)
-- ============================

-- Every credit spent writes one row here. It is what makes "one free search per 24
-- hours" checkable after the pass has expired, and later, what lets the admin panel
-- answer which corridors and regions seekers actually look for.
create table if not exists seeker_searches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  pass_id uuid not null references seeker_search_passes(id),
  listing_id uuid references directory_listings(id),-- null = a list, not a single card
  query text check (query is null or char_length(query) <= 200),
  filter_kind text check (filter_kind is null or filter_kind in ('transporter','cfa')),
  filter_region_id int references geo_regions(id),
  -- Nullable because the count is only known after the read has run, and settle_search
  -- writes it exactly once. A search that was consumed but never settled (the seeker
  -- closed the tab) stays null, which is the truth rather than a fabricated zero.
  found int check (found is null or found between 0 and 100000),
  credits_left int not null check (credits_left >= 0),
  ip inet,
  created_at timestamptz not null default now()
);
create index seeker_searches_tenant_idx on seeker_searches (tenant_id, created_at desc);
create index seeker_searches_demand_idx on seeker_searches (created_at desc);
create index seeker_searches_region_idx
  on seeker_searches (filter_region_id) where filter_region_id is not null;

alter table seeker_searches enable row level security;
-- SELECT only, like the passes: consume_search_credit is the writer. No updated_at,
-- no deleted_at — a log row is never edited or removed (043 posture).
grant select on seeker_searches to app_runtime;
create policy seeker_searches_read on seeker_searches
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ============================
-- THE READ PATH (046 shape: composite + definer, no view) — behind a claim check
-- ============================

do $$ begin
  if not exists (select 1 from pg_type where typname = 'directory_card') then
    execute $ty$
create type directory_card as (
  id uuid,
  company_name text,
  serves text[],
  headline text,
  description text,
  services_offered text,
  corridors_served text,
  home_base text,
  region_names text[],
  website text,
  fleet_size_declared int,
  year_established int,
  licence_valid_to text,
  licence_state text,
  contact_name text,
  contact_channel text,
  is_verified boolean,
  published_at timestamptz,
  total int
);$ty$;
  end if;
end $$;

-- The credit just spent, presented as a claim check. directory_search and
-- directory_card_for answer only for a search row this tenant created in the last
-- five minutes, so reading the directory without spending a credit is refused by the
-- database rather than by whichever route happens to call it first — which is the
-- difference between a meter and an invoice. Paging through one search stays free,
-- because the same claim covers the whole five minutes.
create or replace function directory_claim_ok(p_search_id uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from seeker_searches s
     where s.id = p_search_id
       and s.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
       and s.created_at > now() - interval '5 minutes');
$$;

-- licence_state is derived at read time from the copied date, so a listing published
-- in June is not still claiming "valid" in December because a boolean was frozen then.
create or replace function directory_search(
  p_search_id uuid, p_kind text, p_region_id int, p_search text,
  p_limit int, p_offset int
) returns setof directory_card
language plpgsql volatile security definer set search_path = public as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 60);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total int;
begin
  if not coalesce(directory_claim_ok(p_search_id), false) then
    return;
  end if;

  select count(*) into v_total
    from directory_listings l
   where l.status = 'live' and l.deleted_at is null
     and (p_kind is null or l.serves && array[p_kind]::text[])
     and (p_region_id is null or exists (
            select 1 from directory_listing_regions f
             where f.listing_id = l.id and f.region_id = p_region_id))
     and (p_search is null
          or l.company_name ilike '%' || p_search || '%'
          or l.headline ilike '%' || p_search || '%'
          or l.home_base ilike '%' || p_search || '%'
          or l.services_offered ilike '%' || p_search || '%'
          or l.corridors_served ilike '%' || p_search || '%'
          or exists (select 1 from directory_listing_regions f
                      join geo_regions g on g.id = f.region_id
                     where f.listing_id = l.id
                       and g.name_en ilike '%' || p_search || '%'));

  -- The log row is settled the first time the search is read; later pages of the same
  -- search re-read it but never rewrite it.
  update seeker_searches set found = v_total
   where id = p_search_id and found is null;

  return query
    with found as (
      select l.id, l.company_name, l.serves, l.headline, l.description,
             l.services_offered, l.corridors_served, l.home_base,
             coalesce(rg.names, '{}'::text[]) as region_names,
             l.website, l.fleet_size_declared, l.year_established,
             l.licence_valid_to::text as licence_valid_to,
             case
               when l.licence_valid_to is null then 'not_declared'
               when l.licence_valid_to < current_date then 'expired'
               when l.licence_valid_to < current_date + 60 then 'expiring_soon'
               else 'valid'
             end as licence_state,
             l.contact_name, l.contact_channel, l.is_verified, l.published_at,
             v_total as total
        from directory_listings l
        left join (
          select dlr.listing_id, array_agg(g.name_en order by g.name_en) as names
            from directory_listing_regions dlr
            join geo_regions g on g.id = dlr.region_id
           group by dlr.listing_id
        ) rg on rg.listing_id = l.id
       where l.status = 'live' and l.deleted_at is null
         and (p_kind is null or l.serves && array[p_kind]::text[])
         and (p_region_id is null or exists (
                select 1 from directory_listing_regions f
                 where f.listing_id = l.id and f.region_id = p_region_id))
         and (p_search is null
              or l.company_name ilike '%' || p_search || '%'
              or l.headline ilike '%' || p_search || '%'
              or l.home_base ilike '%' || p_search || '%'
              or l.services_offered ilike '%' || p_search || '%'
              or l.corridors_served ilike '%' || p_search || '%'
              or exists (select 1 from directory_listing_regions f
                          join geo_regions g on g.id = f.region_id
                         where f.listing_id = l.id
                           and g.name_en ilike '%' || p_search || '%'))
       order by l.is_verified desc, coalesce(l.published_at, l.created_at) desc, l.company_name
    )
    select f.* from found f limit v_limit offset v_offset;
end $$;

-- Opening one card is still a read of the directory, so it presents the same claim.
create or replace function directory_card_for(p_id uuid, p_search_id uuid)
returns directory_card
language sql stable security definer set search_path = public as $$
  select l.id, l.company_name, l.serves, l.headline, l.description,
         l.services_offered, l.corridors_served, l.home_base,
         coalesce(rg.names, '{}'::text[]), l.website, l.fleet_size_declared,
         l.year_established, l.licence_valid_to::text,
         case
           when l.licence_valid_to is null then 'not_declared'
           when l.licence_valid_to < current_date then 'expired'
           when l.licence_valid_to < current_date + 60 then 'expiring_soon'
           else 'valid'
         end,
         l.contact_name, l.contact_channel, l.is_verified, l.published_at,
         1
    from directory_listings l
    left join (
      select dlr.listing_id, array_agg(g.name_en order by g.name_en) as names
        from directory_listing_regions dlr
        join geo_regions g on g.id = dlr.region_id
       group by dlr.listing_id
    ) rg on rg.listing_id = l.id
   where l.id = p_id and l.status = 'live' and l.deleted_at is null
     and directory_claim_ok(p_search_id)
$$;

-- The region filter should not offer a region with nothing in it, and the seeker page
-- should show how many companies each one holds.
create or replace function directory_region_counts()
returns table (region_id int, region_name text, companies bigint)
language sql stable security definer set search_path = public as $$
  select g.id, g.name_en, count(*)
    from directory_listing_regions dlr
    join directory_listings l on l.id = dlr.listing_id
    join geo_regions g on g.id = dlr.region_id
   where l.status = 'live' and l.deleted_at is null and g.is_active
   group by g.id, g.name_en
   order by count(*) desc, g.name_en;
$$;

-- ============================
-- CLAIM, RECORD, SPEND
-- ============================

-- Both claim paths resolve the seeker through users -> seekers rather than trusting a
-- tenant id from the caller: the caller of a pre-session or just-signed-up flow holds
-- only a user id, and seekers is RLS-scoped, so this definer is the door (060 used the
-- same shape for mark_seeker_verified).
create or replace function platform_auth.claim_free_search(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_seeker seekers%rowtype;
  v_recent seeker_search_passes%rowtype;
  v_product seeker_pass_products%rowtype;
  v_pass uuid := gen_random_uuid();
begin
  select * into v_seeker from seekers
   where user_id = p_user_id and deleted_at is null limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_seeker'); end if;
  if v_seeker.email_verified_at is null and v_seeker.phone_verified_at is null then
    return jsonb_build_object('ok', false, 'reason', 'not_verified');
  end if;

  -- A live weekly pass already covers searching, so the free credit is not stacked on
  -- top of it — the seeker is told what they already have instead.
  select * into v_recent from seeker_search_passes
   where tenant_id = v_seeker.tenant_id and kind = 'weekly'
     and status = 'live' and expires_at > now() and deleted_at is null
   order by expires_at desc limit 1;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'has_live_pass',
      'pass_id', v_recent.id, 'expires_at', v_recent.expires_at,
      'remaining', v_recent.searches_allowed - v_recent.searches_used);
  end if;

  -- One credit per rolling 24 hours, anchored on the CLAIM rather than on the search:
  -- claiming and never searching still spends the day. Anchoring on the search would
  -- let one account claim four credits in four minutes and hold them in reserve.
  select * into v_recent from seeker_search_passes
   where tenant_id = v_seeker.tenant_id and kind = 'free'
     and deleted_at is null
   order by created_at desc limit 1;
  if found and v_recent.created_at > now() - interval '24 hours' then
    return jsonb_build_object('ok', false, 'reason', 'wait',
      'resets_at', v_recent.created_at + interval '24 hours');
  end if;

  select * into v_product from seeker_pass_products where key = 'free' and is_active;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_offered'); end if;

  insert into seeker_search_passes (id, tenant_id, user_id, product_id, kind, status,
    searches_allowed, searches_used, starts_at, expires_at, amount, currency,
    created_by, updated_by)
  values (v_pass, v_seeker.tenant_id, p_user_id, v_product.id, v_product.key, 'live',
    v_product.searches_allowed, 0, now(),
    now() + make_interval(hours => v_product.window_hours),
    v_product.price, v_product.currency, p_user_id, p_user_id);

  return jsonb_build_object('ok', true, 'pass_id', v_pass, 'kind', 'free',
    'remaining', v_product.searches_allowed,
    'expires_at', now() + make_interval(hours => v_product.window_hours));
end $$;

-- The seeker records an intention to pay and the reference they were given. This
-- creates a pass that CANNOT search: 'awaiting_verification' is refused by
-- consume_search_credit until a person confirms the money.
create or replace function platform_auth.record_weekly_pass(
  p_user_id uuid, p_reference text, p_method text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_seeker seekers%rowtype;
  v_recent seeker_search_passes%rowtype;
  v_product seeker_pass_products%rowtype;
  v_pass uuid := gen_random_uuid();
  v_ref text := nullif(trim(p_reference), '');
begin
  select * into v_seeker from seekers
   where user_id = p_user_id and deleted_at is null limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_seeker'); end if;
  if v_seeker.email_verified_at is null and v_seeker.phone_verified_at is null then
    return jsonb_build_object('ok', false, 'reason', 'not_verified');
  end if;

  select * into v_product from seeker_pass_products where key = 'weekly' and is_active;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_offered'); end if;

  -- A live weekly pass is not replaced by a second one: the seeker is told how much
  -- of the current window is left rather than quietly buying a parallel week.
  select * into v_recent from seeker_search_passes
   where tenant_id = v_seeker.tenant_id and kind = 'weekly' and deleted_at is null
     and (status = 'live' and expires_at > now() or status = 'awaiting_verification')
   order by created_at desc limit 1;
  if found then
    return jsonb_build_object('ok', false,
      'reason', case when v_recent.status = 'live' then 'has_live_pass' else 'already_recorded' end,
      'pass_id', v_recent.id, 'status', v_recent.status,
      'expires_at', v_recent.expires_at);
  end if;

  if v_ref is null or char_length(v_ref) < 4 then
    return jsonb_build_object('ok', false, 'reason', 'reference_too_short');
  end if;
  if p_method is null then
    return jsonb_build_object('ok', false, 'reason', 'method_required');
  end if;

  insert into seeker_search_passes (id, tenant_id, user_id, product_id, kind, status,
    searches_allowed, searches_used, starts_at, expires_at, amount, currency,
    payment_method, payment_reference, created_by, updated_by)
  values (v_pass, v_seeker.tenant_id, p_user_id, v_product.id, v_product.key,
    'awaiting_verification', v_product.searches_allowed, 0, now(),
    now() + make_interval(hours => v_product.window_hours),
    v_product.price, v_product.currency, p_method, v_ref, p_user_id, p_user_id);

  return jsonb_build_object('ok', true, 'pass_id', v_pass, 'status', 'awaiting_verification',
    'amount', v_product.price, 'currency', v_product.currency,
    'reference', v_ref,
    'note', 'The week starts when the office confirms your payment, not now.');
end $$;

-- The meter. One locked row decides everything: whose pass it is, whether it is live,
-- whether it is in its window, and whether a credit is left.
create or replace function platform_auth.consume_search_credit(
  p_user_id uuid, p_pass_id uuid, p_listing_id uuid, p_query text, p_kind text,
  p_region_id int, p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_seeker seekers%rowtype;
  v_pass seeker_search_passes%rowtype;
  v_search uuid := gen_random_uuid();
  v_left int;
begin
  select * into v_seeker from seekers
   where user_id = p_user_id and deleted_at is null limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_seeker'); end if;
  if v_seeker.email_verified_at is null and v_seeker.phone_verified_at is null then
    return jsonb_build_object('ok', false, 'reason', 'not_verified');
  end if;

  -- The lock is the whole concurrency story: the second searcher blocks here,
  -- re-reads the incremented counter after the first commits, and is told exhausted.
  select * into v_pass from seeker_search_passes
   where id = p_pass_id and deleted_at is null
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_pass'); end if;
  if v_pass.tenant_id <> v_seeker.tenant_id then
    return jsonb_build_object('ok', false, 'reason', 'not_mine');
  end if;
  if v_pass.status = 'awaiting_verification' then
    return jsonb_build_object('ok', false, 'reason', 'awaiting_verification');
  end if;
  if v_pass.status <> 'live' then
    return jsonb_build_object('ok', false, 'reason', 'not_live', 'status', v_pass.status);
  end if;
  if v_pass.expires_at <= now() then
    update seeker_search_passes set status = 'expired', updated_by = p_user_id
     where id = v_pass.id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_pass.searches_used >= v_pass.searches_allowed then
    return jsonb_build_object('ok', false, 'reason', 'exhausted',
      'resets_at', v_pass.expires_at);
  end if;

  v_left := v_pass.searches_allowed - v_pass.searches_used - 1;

  update seeker_search_passes
     set searches_used = searches_used + 1, updated_by = p_user_id
   where id = v_pass.id;

  insert into seeker_searches (id, tenant_id, user_id, pass_id, listing_id, query,
    filter_kind, filter_region_id, found, credits_left, ip)
  values (v_search, v_seeker.tenant_id, p_user_id, v_pass.id, p_listing_id,
    nullif(trim(p_query), ''),
    case when p_kind in ('transporter','cfa') then p_kind else null end,
    p_region_id, null, v_left,
    nullif(p_ip, '')::inet);

  return jsonb_build_object('ok', true, 'search_id', v_search, 'pass_kind', v_pass.kind,
    'remaining', v_left, 'resets_at', v_pass.expires_at);
end $$;

-- The seeker's own meter, in one read: what is live, what is left, when the next free
-- credit unlocks, and whether a recorded payment is still waiting on the office.
create or replace function platform_auth.seeker_pass_state(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_seeker seekers%rowtype;
  v_live seeker_search_passes%rowtype;
  v_free seeker_search_passes%rowtype;
  v_wait int;
begin
  select * into v_seeker from seekers
   where user_id = p_user_id and deleted_at is null limit 1;
  if not found then return jsonb_build_object('found', false); end if;

  select * into v_live from seeker_search_passes
   where tenant_id = v_seeker.tenant_id and status = 'live'
     and expires_at > now() and searches_used < searches_allowed and deleted_at is null
   order by case kind when 'weekly' then 1 else 2 end, expires_at desc limit 1;

  select * into v_free from seeker_search_passes
   where tenant_id = v_seeker.tenant_id and kind = 'free' and deleted_at is null
   order by created_at desc limit 1;

  v_wait := case
    when v_free.id is null then 0
    when v_free.created_at + interval '24 hours' <= now() then 0
    else greatest(0, floor(extract(epoch from (v_free.created_at + interval '24 hours') - now()) / 60))::int
  end;

  return jsonb_build_object(
    'found', true,
    'verified', coalesce(v_seeker.email_verified_at, v_seeker.phone_verified_at) is not null,
    'live_pass_id', v_live.id,
    'live_kind', v_live.kind,
    'live_remaining', case when v_live.id is null then null
                           else v_live.searches_allowed - v_live.searches_used end,
    'live_expires_at', v_live.expires_at,
    'free_wait_minutes', v_wait,
    'awaiting_count', (select count(*)::int from seeker_search_passes
                        where tenant_id = v_seeker.tenant_id
                          and status = 'awaiting_verification' and deleted_at is null),
    'searches_total', (select count(*)::int from seeker_searches
                        where tenant_id = v_seeker.tenant_id),
    'products', (select coalesce(jsonb_agg(jsonb_build_object(
                       'key', p.key, 'name', p.name, 'description', p.description,
                       'window_hours', p.window_hours, 'searches_allowed', p.searches_allowed,
                       'price', p.price, 'currency', p.currency)
                     order by p.sort), '[]'::jsonb)
                   from seeker_pass_products p where p.is_active));
end $$;

-- ============================
-- CONTROL: VERIFY A PASS, MODERATE A LISTING
-- ============================

-- Deliberately crosses RLS, like 010's manual_activate and 015's list helpers: the
-- office confirms money it has seen in its own bank or mobile money statement. The
-- week is re-based on the approval instant because the payment may land a day after
-- the reference was typed; charging the seeker for the waiting time would be wrong.
create or replace function platform_auth.verify_search_pass(
  p_pass_id uuid, p_actor uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_pass seeker_search_passes%rowtype;
  v_product seeker_pass_products%rowtype;
begin
  select * into v_pass from seeker_search_passes where id = p_pass_id and deleted_at is null;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_pass.status <> 'awaiting_verification' then
    return jsonb_build_object('status', 'conflict',
      'reason', 'Only a pass awaiting verification can be confirmed or refused.',
      'current_status', v_pass.status);
  end if;

  if not p_approve then
    update seeker_search_passes
       set status = 'rejected', verified_by = p_actor, verified_at = now(),
           verification_note = nullif(trim(p_note), ''), updated_by = p_actor
     where id = v_pass.id;
    insert into audit_logs (tenant_id, actor_user_id, entity, entity_id, action, after)
    values (v_pass.tenant_id, p_actor, 'seeker_search_passes', v_pass.id,
      'seeker_pass.rejected',
      jsonb_build_object('reference', v_pass.payment_reference,
        'amount', v_pass.amount, 'currency', v_pass.currency,
        'note', nullif(trim(p_note), '')));
    return jsonb_build_object('status', 'ok', 'pass_status', 'rejected',
      'pass_id', v_pass.id);
  end if;

  select * into v_product from seeker_pass_products where id = v_pass.product_id;
  update seeker_search_passes
     set status = 'live', starts_at = now(),
         expires_at = now() + make_interval(hours => coalesce(v_product.window_hours, 168)),
         searches_allowed = coalesce(v_product.searches_allowed, v_pass.searches_allowed),
         verified_by = p_actor, verified_at = now(),
         verification_note = nullif(trim(p_note), ''), updated_by = p_actor
   where id = v_pass.id;

  insert into audit_logs (tenant_id, actor_user_id, entity, entity_id, action, after)
  values (v_pass.tenant_id, p_actor, 'seeker_search_passes', v_pass.id,
    'seeker_pass.verified',
    jsonb_build_object('reference', v_pass.payment_reference,
      'amount', v_pass.amount, 'currency', v_pass.currency,
      'method', v_pass.payment_method,
      'searchesAllowed', coalesce(v_product.searches_allowed, v_pass.searches_allowed),
      'expiresAt', now() + make_interval(hours => coalesce(v_product.window_hours, 168)),
      'note', nullif(trim(p_note), '')));

  return jsonb_build_object('status', 'ok', 'pass_status', 'live', 'pass_id', v_pass.id,
    'searches_allowed', coalesce(v_product.searches_allowed, v_pass.searches_allowed),
    'expires_at', now() + make_interval(hours => coalesce(v_product.window_hours, 168)));
end $$;

-- The directory is public-facing, so the platform needs a door that is not the
-- listing owner's. Suspend / reinstate / verify / unverify, each audited.
create or replace function platform_auth.moderate_listing(
  p_listing_id uuid, p_actor uuid, p_action text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_listing directory_listings%rowtype;
  v_status text;
  v_verified boolean;
begin
  select * into v_listing from directory_listings where id = p_listing_id and deleted_at is null;
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  -- Read AFTER the select. Initialising these in the DECLARE list would read the
  -- empty record, because default expressions are evaluated before the body runs.
  v_status := v_listing.status;
  v_verified := v_listing.is_verified;

  if p_action = 'suspend' then
    if char_length(coalesce(trim(p_note), '')) < 4 then
      return jsonb_build_object('status', 'invalid',
        'reason', 'A suspension needs a reason the company can act on.');
    end if;
    v_status := 'suspended';
  elsif p_action = 'reinstate' then
    v_status := 'live';
  elsif p_action = 'verify' then
    v_verified := true;
  elsif p_action = 'unverify' then
    v_verified := false;
  else
    return jsonb_build_object('status', 'invalid', 'reason', 'Unknown moderation action.');
  end if;

  update directory_listings
     set status = v_status, is_verified = v_verified,
         suspension_reason = case when p_action = 'suspend'
                                  then trim(p_note) else null end,
         verified_by = case when p_action = 'verify' then p_actor
                           when p_action = 'unverify' then null
                           else verified_by end,
         verified_at = case when p_action = 'verify' then now()
                           when p_action = 'unverify' then null
                           else verified_at end,
         updated_by = p_actor
   where id = v_listing.id;

  insert into audit_logs (tenant_id, actor_user_id, entity, entity_id, action, after)
  values (v_listing.tenant_id, p_actor, 'directory_listings', v_listing.id,
    'directory.' || p_action,
    jsonb_build_object('company_name', v_listing.company_name,
      'status', v_status, 'is_verified', v_verified,
      'note', nullif(trim(p_note), '')));

  return jsonb_build_object('status', 'ok', 'listing_id', v_listing.id,
    'listing_status', v_status, 'is_verified', v_verified);
end $$;

-- Control needs the pending queue and the whole register, neither of which an
-- app_runtime session can read across tenants. Returned columns are fixed, like 010's.
create or replace function platform_auth.list_pending_passes()
returns table (pass_id uuid, tenant_id uuid, seeker_name text, email text, kind text,
              amount numeric, currency text, payment_method text,
              payment_reference text, recorded_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.tenant_id, u.full_name, u.email, p.kind, p.amount, p.currency,
         p.payment_method, p.payment_reference, p.created_at
    from seeker_search_passes p
    join users u on u.id = p.user_id
   where p.status = 'awaiting_verification' and p.deleted_at is null
   order by p.created_at
   limit 200;
$$;

create or replace function platform_auth.list_directory_for_control(p_search text)
returns table (listing_id uuid, tenant_id uuid, company_name text, serves text[],
              status text, is_verified boolean, region_names text[], contact_name text,
              contact_channel text, published_at timestamptz, updated_at timestamptz,
              searches bigint)
language sql stable security definer set search_path = public as $$
  select l.id, l.tenant_id, l.company_name, l.serves, l.status, l.is_verified,
         coalesce(rg.names, '{}'::text[]), l.contact_name, l.contact_channel,
         l.published_at, l.updated_at, coalesce(ss.searches, 0)
    from directory_listings l
    left join (
      select dlr.listing_id, array_agg(g.name_en order by g.name_en) as names
        from directory_listing_regions dlr
        join geo_regions g on g.id = dlr.region_id
       group by dlr.listing_id
    ) rg on rg.listing_id = l.id
    left join (
      select listing_id, count(*)::bigint as searches
        from seeker_searches group by listing_id
    ) ss on ss.listing_id = l.id
   where l.deleted_at is null
     and (p_search is null or l.company_name ilike '%' || p_search || '%')
   order by l.updated_at desc
   limit 200;
$$;

-- ============================
-- PERMISSIONS AND ROLE GRANTS
-- ============================

insert into permissions (key, description)
values
  ('directory.view', 'Company Directory - View own published listing and its search count'),
  ('directory.manage', 'Company Directory - Publish, edit or withdraw the company listing'),
  ('directory.search', 'Seeker Directory - Search listed transporters and clearing agents'),
  ('seeker_pass.view', 'Seeker Passes - View own search passes, credits and pass prices'),
  ('seeker_pass.create', 'Seeker Passes - Claim a free search and record a pass payment reference')
on conflict do nothing;

-- 060 created the seeker role and granted it only the self-profile keys, precisely so
-- no role would hold a key for a table that did not exist yet. Those keys are live now.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('directory.search', 'seeker_pass.view', 'seeker_pass.create')
where r.key = 'seeker' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('directory.view', 'directory.manage')
where r.key in ('director', 'general_manager', 'operations_manager') and r.tenant_id is null
  and not (p.key = 'directory.manage' and r.key <> 'director')
on conflict do nothing;

-- The control actions are gated by the control surface's own cookie + role helpers
-- (hasLicenceRole and friends), which is how 010, 047 and every other control route
-- works. No control.* key is minted here because the seeded control matrix is
-- enforced nowhere — inventing a key the routes do not read would be worse than
-- having none.

-- ============================
-- GRANTS AND REVOCATIONS
-- ============================

grant execute on function
  directory_search(uuid, text, int, text, int, int),
  directory_card_for(uuid, uuid),
  directory_region_counts(),
  directory_claim_ok(uuid),
  platform_auth.claim_free_search(uuid),
  platform_auth.record_weekly_pass(uuid, text, text),
  platform_auth.consume_search_credit(uuid, uuid, uuid, text, text, int, text),
  platform_auth.seeker_pass_state(uuid),
  platform_auth.verify_search_pass(uuid, uuid, boolean, text),
  platform_auth.moderate_listing(uuid, uuid, text, text),
  platform_auth.list_pending_passes(),
  platform_auth.list_directory_for_control(text)
to app_runtime;

-- Postgres grants EXECUTE on a new function to PUBLIC, and 051's sweep ran before this
-- file, so it could not have covered these. For the platform_auth set the schema USAGE
-- revoke already blocked them; the four directory readers are in `public`, which every
-- role can use, so without this revoke a browser role could call directory_search
-- directly and read the directory without ever spending a credit.
revoke all on function
  directory_search(uuid, text, int, text, int, int),
  directory_card_for(uuid, uuid),
  directory_region_counts(),
  directory_claim_ok(uuid),
  platform_auth.claim_free_search(uuid),
  platform_auth.record_weekly_pass(uuid, text, text),
  platform_auth.consume_search_credit(uuid, uuid, uuid, text, text, int, text),
  platform_auth.seeker_pass_state(uuid),
  platform_auth.verify_search_pass(uuid, uuid, boolean, text),
  platform_auth.moderate_listing(uuid, uuid, text, text),
  platform_auth.list_pending_passes(),
  platform_auth.list_directory_for_control(text)
from public, anon, authenticated, service_role;

-- Trigger functions are called by the engine, not by a session, so EXECUTE to
-- app_runtime is not needed — and this one raises eligibility errors, which no session
-- should be able to invoke on demand.
revoke all on function directory_listing_tenant_guard()
from public, anon, authenticated, service_role;

comment on function directory_search(uuid, text, int, text, int, int) is
  'RULE 0: the only cross-tenant read of company listings. Returns directory_card columns only, and only against a claim check this tenant paid a credit for.';
comment on function platform_auth.consume_search_credit(uuid, uuid, uuid, text, text, int, text) is
  'The meter: one row-locked pass decides ownership, window and credit, then logs the search as the claim check the read path needs.';
comment on table seeker_search_passes is
  'Seeker search credits. Tenant has SELECT only; every write is a platform_auth definer.';

commit;
