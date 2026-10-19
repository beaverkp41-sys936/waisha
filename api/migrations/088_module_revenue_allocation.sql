-- 088 — an allocation of package income across the three offices (task #155, revenue-per-module half).
--
-- The advisory's honest-unknown card said: "invoices link to a subscription, and a bundle is
-- sold as one price, so income can be attributed to a package but never split across
-- transport, CFA and office." That is still true of the *price* — no column in this schema
-- says what the transport third of the Complete Logistics Suite costs. What the card was
-- missing is that the bundle does declare which offices it contains
-- (service_groups.services, 060, checked against the closed vocabulary transport/cfa/office)
-- and that every office records its own work (trips and bookings, cargo files and customer
-- invoices, office tasks and payroll runs). So the split cannot be *measured*, but it can be
-- *allocated* — and an allocation that names its basis on every row is a number the office
-- can argue with, which is more than a disclaimer is.
--
-- The rule, in one sentence: a company's paid invoices in the window are attributed to the
-- offices its package contains, weighted by how much work that company actually recorded in
-- each office during that same window.
--
--   ONE UNIT = ONE PIECE OF WORK RECORDED IN AN OFFICE IN THE WINDOW.
--     transport  trips + transport_bookings + freight_invoices that hang off a trip
--     cfa        cargo_shipments + freight_invoices that do not hang off a trip
--     office     office_tasks + payroll_runs that were issued
--
-- Deliberately not units, each for a reason the desk repeats:
--   * freight_invoices are counted once, in the office whose document they are, so a trip
--     invoice cannot inflate transport and the clearing side at the same time.
--   * jobs (042) are skipped: a job is the pipeline over a cargo file that is already counted.
--   * employee_attendance and employees are skipped: attendance days and headcount are not
--     the same kind of thing as a trip, and letting 30 attendance lines stand beside 2 trips
--     would make the office look like it earns the rent.
--   * transport_requests is skipped: a published request is an advertisement, not work done.
--
-- THREE AMOUNTS ARE NOT SPLIT, AND THE SAID SO ON THE ROW:
--   * the plan ladder. starter/business/enterprise have no component list at all — 005
--     prices a rung for the transporter product, so its income stays one line rather than
--     being invented across three.
--   * a bundle company with no recorded work in the offices it bought falls back to an even
--     split across exactly those offices, and lands in even_income so the desk can say how
--     much of the picture is that fall-back rather than evidence of use. A clearing-and-office
--     company that spent its window on trips is the case this catches: it bought two offices
--     and recorded work in neither, so the money is shared evenly and labelled, not dropped.
--   * a company whose window money has no subscription behind any invoice is 'no subscription'.
--     It is in the total because it is real money; it is not in any office because nothing
--     says where it goes.
--
-- Search-pass money is the one stream that needs no allocation: a weekly pass is the
-- directory and nothing else, so it is a direct line beside the split, not folded into it.
--
-- Every row carries one of four bases — 'usage', 'even', 'not split', 'no subscription' —
-- and each company's whole income sits in exactly one of them, never in two.
--
-- The totals reconcile by construction: the three office shares plus the rounding drift
-- (given whole to the office carrying the largest share, transport when they tie, so it is
-- never spread and hidden) sum to that company's income to the cent, and the six summary
-- lines sum to every paid invoice plus every confirmed pass in the window.
-- verify-control-module-sql.ts proves both, against hand-built numbers rather than against
-- itself.
--
-- Posture: two read-only definers, no new table, no new write. Nothing here is stored,
-- because an allocation recomputed later from the same data is the same allocation; storing
-- it would only let the register disagree with the invoices.

-- ---------------------------------------------------------------------------
-- 1. The engine: every company with money in the window, its units, its split.
-- ---------------------------------------------------------------------------
-- Internal. No limit, so the summary below can prove its own total; it is revoked from
-- every role including app_runtime, because an unlimited cross-tenant dump of what each
-- company pays is exactly what the desk must not be able to ask for.
drop function if exists platform_auth.module_allocation_base(int);
create or replace function platform_auth.module_allocation_base(p_days int)
returns table (
  tenant_id uuid, company_name text, company_type text,
  offering text, offering_name text, services text[],
  basis text, invoices_paid int, income numeric,
  transport_units int, cfa_units int, office_units int,
  transport_income numeric, cfa_income numeric, office_income numeric,
  transport_share numeric, cfa_share numeric, office_share numeric
) language sql stable security definer set search_path = public as $$
  with bounds as (
    select now() - make_interval(days => greatest(least(coalesce(p_days, 90), 730), 7))
           as since
  ),
  -- One row per company per office: how much work that office recorded in the window.
  activity as (
    select x.tenant_id, sum(x.n) filter (where x.office = 'transport')::int as transport_units,
           sum(x.n) filter (where x.office = 'cfa')::int                    as cfa_units,
           sum(x.n) filter (where x.office = 'office')::int                 as office_units
      from (
        select tenant_id, 'transport'::text as office, count(*)::int as n
          from trips where deleted_at is null and created_at >= (select since from bounds)
         group by tenant_id
        union all
        select tenant_id, 'transport', count(*)::int
          from transport_bookings
         where deleted_at is null and created_at >= (select since from bounds)
         group by tenant_id
        union all
        select tenant_id, 'transport', count(*)::int
          from freight_invoices
         where deleted_at is null and related_trip_id is not null
           and created_at >= (select since from bounds)
         group by tenant_id
        union all
        select tenant_id, 'cfa', count(*)::int
          from cargo_shipments
         where deleted_at is null and created_at >= (select since from bounds)
         group by tenant_id
        union all
        select tenant_id, 'cfa', count(*)::int
          from freight_invoices
         where deleted_at is null and related_trip_id is null
           and created_at >= (select since from bounds)
         group by tenant_id
        union all
        select tenant_id, 'office', count(*)::int
          from office_tasks
         where created_at >= (select since from bounds)
         group by tenant_id
        union all
        select tenant_id, 'office', count(*)::int
          from payroll_runs
         where deleted_at is null and issued_at is not null
           and issued_at >= (select since from bounds)
         group by tenant_id
      ) x
     group by x.tenant_id
  ),
  -- The money, invoice by invoice, keeping the bundle that sold it. The window is the
  -- platform's own wall clock and the fact is paid_at: 066's money clock, word for word, so
  -- this allocation and the P&L above it cannot disagree about which month a payment is in.
  each_invoice as (
    select i.tenant_id, i.amount_total, i.paid_at,
           case when s.id is null then 'none'
                when g.id is null then 'ladder'
                else 'bundle' end as sold_as,
           coalesce(g.key, p.key, 'none')  as offering,
           coalesce(g.name, p.name, 'No subscription behind the invoice') as offering_name,
           g.services
      from invoices i
      join tenants t on t.id = i.tenant_id and t.deleted_at is null and t.type <> 'platform'
      left join subscriptions s on s.id = i.subscription_id and s.deleted_at is null
      left join plans p on p.id = s.plan_id
      left join service_groups g on g.id = s.service_group_id
     where i.deleted_at is null and i.status = 'paid' and i.paid_at is not null
       and i.paid_at >= (select since from bounds)
  ),
  per_company as (
    select ei.tenant_id,
           sum(ei.amount_total)                      as income,
           count(*)::int                             as invoices_paid,
           bool_or(ei.sold_as = 'bundle')            as has_bundle,
           bool_or(ei.sold_as = 'ladder')            as has_ladder,
           -- Where a company changed package mid-window the newest package's component list
           -- is used for all of it; the desk says so rather than pretending the money
           -- arrived in three pieces at the time. A correlated limit-1 rather than
           -- array_agg(...)[1], because Postgres binds that subscript to the aggregate's
           -- *argument* and refuses to accumulate arrays of unequal length — both found the
           -- hard way, the first by a parse error, the second by a company with two bundles.
           (select e.services from each_invoice e
             where e.tenant_id = ei.tenant_id and e.sold_as = 'bundle' and e.services is not null
             order by e.paid_at desc, e.offering limit 1) as services,
           (select e.offering from each_invoice e
             where e.tenant_id = ei.tenant_id and e.sold_as = 'bundle'
             order by e.paid_at desc, e.offering limit 1)  as bundle_key,
           (select e.offering_name from each_invoice e
             where e.tenant_id = ei.tenant_id
             order by e.paid_at desc, e.offering limit 1) as offering_name
      from each_invoice ei
     group by ei.tenant_id
  ),
  weighted as (
    select m.tenant_id, m.income, m.invoices_paid, m.offering_name, m.services, m.bundle_key,
           coalesce(a.transport_units, 0) as tu,
           coalesce(a.cfa_units, 0)       as cu,
           coalesce(a.office_units, 0)    as ou,
           case when m.has_bundle then 'bundle'
                when m.has_ladder then 'ladder'
                else 'none' end           as sold_as,
           -- Only work done in an office the company actually bought can carry weight.
           coalesce(a.transport_units, 0)
             + coalesce(a.cfa_units, 0) + coalesce(a.office_units, 0) as all_units,
           case when m.has_bundle then
                  (case when 'transport' = any(m.services) then coalesce(a.transport_units, 0) else 0 end)
                + (case when 'cfa'       = any(m.services) then coalesce(a.cfa_units, 0)       else 0 end)
                + (case when 'office'    = any(m.services) then coalesce(a.office_units, 0)    else 0 end)
                else 0 end                as bought_units
      from per_company m
      left join activity a on a.tenant_id = m.tenant_id
  ),
  share_units as (
    select w.*,
           -- An office the package does not contain gets nothing, however busy it is.
           -- With work in a bought office the weight is that work; with none at all, every
           -- office the company bought carries one share and the row is labelled for it.
           case when sold_as = 'bundle' and 'transport' = any(services)
                then (case when bought_units > 0 then tu else 1 end) else 0 end as tsu,
           case when sold_as = 'bundle' and 'cfa' = any(services)
                then (case when bought_units > 0 then cu else 1 end) else 0 end as csu,
           case when sold_as = 'bundle' and 'office' = any(services)
                then (case when bought_units > 0 then ou else 1 end) else 0 end as osu
      from weighted w
  ),
  split as (
    select s.*, (tsu + csu + osu) as denom,
           case when (tsu + csu + osu) > 0
                then round(income * tsu / (tsu + csu + osu), 2) end as tr,
           case when (tsu + csu + osu) > 0
                then round(income * csu / (tsu + csu + osu), 2) end as cr,
           case when (tsu + csu + osu) > 0
                then round(income * osu / (tsu + csu + osu), 2) end as orr
      from share_units s
  ),
  drifted as (
    select p.*,
           coalesce(p.income - (coalesce(p.tr, 0) + coalesce(p.cr, 0) + coalesce(p.orr, 0)), 0)
             as drift,
           -- The last cent goes to the busiest office of the three, in the open, so the
           -- company's shares still add up to the company's money.
           case when p.tsu >= p.csu and p.tsu >= p.osu then 'transport'
                when p.csu >= p.osu then 'cfa'
                else 'office' end as drift_to
      from split p
  ),
  final as (
    select d.tenant_id, t.name as company_name, t.type as company_type,
           case d.sold_as
             when 'bundle' then d.bundle_key
             when 'ladder' then (select min(e.offering) from each_invoice e
                                  where e.tenant_id = d.tenant_id and e.sold_as = 'ladder')
             else 'none' end as offering,
           d.offering_name, d.services,
           case when d.sold_as = 'bundle' and d.bought_units > 0 then 'usage'
                when d.sold_as = 'bundle' then 'even'
                when d.sold_as = 'ladder' then 'not split'
                else 'no subscription' end as basis,
           d.invoices_paid, d.income, d.tu, d.cu, d.ou,
           case when d.denom = 0 then null else d.tr + case when d.drift_to = 'transport'
                                                             then d.drift else 0 end end as transport_income,
           case when d.denom = 0 then null else d.cr + case when d.drift_to = 'cfa'
                                                             then d.drift else 0 end end as cfa_income,
           case when d.denom = 0 then null else d.orr + case when d.drift_to = 'office'
                                                             then d.drift else 0 end end as office_income
      from drifted d
      join tenants t on t.id = d.tenant_id
  )
  select f.tenant_id, f.company_name, f.company_type, f.offering, f.offering_name, f.services,
         f.basis, f.invoices_paid, f.income, f.tu, f.cu, f.ou,
         f.transport_income, f.cfa_income, f.office_income,
         -- A share of zero and a share of "nothing was split" are different sentences, so a
         -- row that was not split prints nulls rather than three zeroes that look measured.
         case when f.income > 0 and f.transport_income is not null
              then round(f.transport_income / f.income, 4) end,
         case when f.income > 0 and f.cfa_income is not null
              then round(f.cfa_income / f.income, 4) end,
         case when f.income > 0 and f.office_income is not null
              then round(f.office_income / f.income, 4) end
    from final f
    order by f.income desc, f.company_name;
$$;

-- ---------------------------------------------------------------------------
-- 2. The desk reader: one row per company, with the weights beside the split.
-- ---------------------------------------------------------------------------
drop function if exists platform_auth.control_module_allocation_tenants(int, int);
create or replace function platform_auth.control_module_allocation_tenants(
  p_days int default 90, p_limit int default 200
) returns table (
  tenant_id uuid, company_name text, company_type text,
  offering text, offering_name text, services text[],
  basis text, invoices_paid int, income numeric,
  transport_units int, cfa_units int, office_units int,
  transport_income numeric, cfa_income numeric, office_income numeric,
  transport_share numeric, cfa_share numeric, office_share numeric,
  matched int, matched_income numeric, window_days int
) language sql stable security definer set search_path = public as $$
  select b.*,
         count(*) over ()::int,
         coalesce(sum(b.income) over (), 0),
         greatest(least(coalesce(p_days, 90), 730), 7)
    from platform_auth.module_allocation_base(
           greatest(least(coalesce(p_days, 90), 730), 7)) b
   order by b.income desc, b.company_name
   limit greatest(least(coalesce(p_limit, 200), 400), 1);
$$;

-- ---------------------------------------------------------------------------
-- 3. The summary: six lines that add up to all the money in the window.
-- ---------------------------------------------------------------------------
drop function if exists platform_auth.control_module_allocation(int);
create or replace function platform_auth.control_module_allocation(p_days int default 90)
returns table (
  module text, module_label text, basis text, customers int, units int,
  income numeric, share numeric, usage_income numeric, even_income numeric,
  platform_income numeric, window_days int, currency text
) language sql stable security definer set search_path = public as $$
  with days as (
    select greatest(least(coalesce(p_days, 90), 730), 7) as d
  ),
  base as (
    select * from platform_auth.module_allocation_base((select d from days))
  ),  passes as (
    select coalesce(sum(sp.amount), 0)::numeric            as income,
           count(distinct sp.tenant_id)::int               as customers
      from seeker_search_passes sp
     where sp.deleted_at is null
       and sp.status in ('live', 'expired')
       and sp.verified_at is not null
       and sp.verified_at >= now() - make_interval(days => (select d from days))
  ),
  subscription_money as (
    select coalesce(sum(income), 0) as amount from base
  ),
  lines as (
    select 1 as rank, 'transport'::text as module, 'Freight transport'::text as module_label,
           'allocated by recorded work'::text as basis,
           count(*) filter (where b.transport_income > 0)::int as customers,
           -- Work in an office the package never included earned nothing there, so it is not
           -- counted as work for that office either.
           coalesce(sum(b.transport_units) filter (where b.basis = 'usage'
             and 'transport' = any(b.services)), 0)::int as units,
           coalesce(sum(b.transport_income), 0) as income,
           coalesce(sum(b.transport_income) filter (where b.basis = 'usage'), 0) as usage_income,
           coalesce(sum(b.transport_income) filter (where b.basis = 'even'), 0)  as even_income
      from base b
    union all
    select 2, 'cfa', 'Clearing and forwarding', 'allocated by recorded work',
           count(*) filter (where b.cfa_income > 0)::int,
           coalesce(sum(b.cfa_units) filter (where b.basis = 'usage'
             and 'cfa' = any(b.services)), 0)::int,
           coalesce(sum(b.cfa_income), 0),
           coalesce(sum(b.cfa_income) filter (where b.basis = 'usage'), 0),
           coalesce(sum(b.cfa_income) filter (where b.basis = 'even'), 0)
      from base b
    union all
    select 3, 'office', 'Office and staff', 'allocated by recorded work',
           count(*) filter (where b.office_income > 0)::int,
           coalesce(sum(b.office_units) filter (where b.basis = 'usage'
             and 'office' = any(b.services)), 0)::int,
           coalesce(sum(b.office_income), 0),
           coalesce(sum(b.office_income) filter (where b.basis = 'usage'), 0),
           coalesce(sum(b.office_income) filter (where b.basis = 'even'), 0)
      from base b
    union all
    select 4, 'plan_ladder', 'Plan ladder (one product, never split)',
           'no component list to split',
           count(*) filter (where b.basis = 'not split')::int,
           0::int,
           coalesce(sum(b.income) filter (where b.basis = 'not split'), 0),
           0::numeric, 0::numeric
      from base b
    union all
    select 5, 'directory_search', 'Directory search passes',
           'sold as the directory alone',
           p.customers, 0::int, p.income, 0::numeric, 0::numeric
      from passes p
    union all
    select 6, 'unattributed', 'Paid with no subscription behind it',
           'cannot be placed',
           count(*) filter (where b.basis = 'no subscription')::int,
           0::int,
           coalesce(sum(b.income) filter (where b.basis = 'no subscription'), 0),
           0::numeric, 0::numeric
      from base b
  ),
  total as (
    select (select amount from subscription_money) + (select income from passes) as amount
  )
  select l.module, l.module_label, l.basis, l.customers, l.units, l.income,
         case when t.amount > 0 then round(l.income / t.amount, 4) end,
         l.usage_income, l.even_income, t.amount, (select d from days), 'TZS'::text
    from lines l cross join total t
   order by l.rank;
$$;

comment on function platform_auth.control_module_allocation(int) is
  'Allocation, not measurement: package income split across the offices the bundle contains, '
  'weighted by the work each office recorded in the window. Ladder income, search-pass income '
  'and invoices with no subscription are kept as their own lines so the six sum to the money.';

-- ---------------------------------------------------------------------------
-- 4. Posture.
-- ---------------------------------------------------------------------------
-- The runtime role gets the two desk readers. The engine stays unreachable: it has no limit,
-- and a caller that can read every company's income and unit counts at once is a cross-tenant
-- dump of what each customer pays.
grant execute on function
  platform_auth.control_module_allocation(int),
  platform_auth.control_module_allocation_tenants(int, int)
to app_runtime;

-- Postgres hands EXECUTE on a new function to PUBLIC unless told otherwise. Same revoke list
-- 060/068/086 use, plus service_role (087) — the base function is revoked from app_runtime
-- too, which is unusual enough to be worth saying why: nothing in the API should be able to
-- call it, only the two readers above, which run as their owner.
revoke all on function
  platform_auth.control_module_allocation(int),
  platform_auth.control_module_allocation_tenants(int, int)
from public, anon, authenticated, service_role;

revoke all on function platform_auth.module_allocation_base(int)
from public, anon, authenticated, service_role, app_runtime;
