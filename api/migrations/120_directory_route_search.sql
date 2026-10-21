-- 120 — a seeker can search a ROUTE, not just a region (task #334).
--
-- #169 gave the seeker one box and one region picker. That is honest for "who is in
-- Arusha" and useless for the question a shipper actually asks, which is "who runs my
-- cargo from Namanga to Dar es Salaam". The transporter has been answering that question
-- with a region -> council -> ward chain since #125, so the seeker was left with a worse
-- tool than the company they are trying to hire.
--
-- Three things had to move in the database for that search to exist:
--
--   1. `directory_search` only ever took ONE region. A route is an ORDERED chain of
--      regions, so the reader takes an int array now and ranks what it finds: a company
--      covering both ends first, one covering either end next, one merely sitting along
--      the way last. The 063 body is carried over unchanged apart from that — the
--      alias-qualified settle update in particular, because FOUND is a reserved plpgsql
--      variable and the unqualified reference made every paid search a 500 once already.
--
--   2. Listings are tagged at REGION level (061), so a route whose ends are two councils
--      the company never tagged would find nothing. The route leg therefore also reads the
--      copy the company wrote for itself — corridors_served, home_base, headline — for the
--      NAME of either end. That is a deliberate widening: it is how "Dar - Arusha - Namanga"
--      in a headline earns its place at the top of the list, and it only ever looks at the
--      two ends, never at the middle of the chain, so a long corridor cannot drag in
--      everyone in Tanzania.
--
--   3. The corridor the seeker clicked has to be RECORDED. A search that says "route" in
--      the browser and "nothing" in the log is a demand fact the office cannot use, and
--      the seeker's own history page would have to lie about what they asked for. So the
--      log gains its own origin/destination columns, written by one definer, and the
--      reader for the board (which regions a main corridor crosses, and how many live
--      companies are on it) is a definer too, because the runtime role may not count
--      another tenant's listings.
--
-- The four new search options (services, verified only, licence still valid, minimum
-- declared fleet) ride along in the same signature: they are the "more options for
-- transporters and agents" the same brief asked for, and a second widening of this
-- function in a week would cost another drop-and-recreate of its grants.
--
-- Drop-and-recreate is not cosmetic busywork: Postgres matches a function by name and
-- input types, so leaving the 6-argument version in place beside an 11-argument one with
-- defaults makes every 6-argument call ambiguous ("function directory_search is not
-- unique"). The drop is why the grant and the revoke are re-stated at the bottom, the
-- same way 063 re-stated them after its CREATE OR REPLACE.
begin;

-- ============================
-- THE SEARCH LOG KEEPS THE ROUTE IT WAS ASKED FOR
-- ============================

alter table seeker_searches
  add column if not exists filter_origin_region_id int references geo_regions(id),
  add column if not exists filter_dest_region_id int references geo_regions(id),
  add column if not exists filter_origin_text text
    check (filter_origin_text is null or char_length(filter_origin_text) <= 120),
  add column if not exists filter_dest_text text
    check (filter_dest_text is null or char_length(filter_dest_text) <= 120);

create index if not exists seeker_searches_route_idx
  on seeker_searches (filter_origin_region_id, filter_dest_region_id)
  where filter_origin_region_id is not null;

-- The meter's own insert (061) knows nothing about routes, and widening
-- consume_search_credit's signature would re-open the whole credit path for a feature
-- that only needs two extra columns on a row it has already written. This is the single
-- writer, and it binds the row to the session's tenant the way every other statement in
-- this module has to — app_runtime connects as a BYPASSRLS role, so RLS is not the guard
-- here, the WHERE clause is.
create or replace function platform_auth.record_search_route(
  p_search_id uuid, p_origin_region_id int, p_dest_region_id int,
  p_origin_text text, p_dest_text text)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare
  v_updated int;
begin
  if p_origin_region_id is null and p_dest_region_id is null then
    return false;
  end if;

  update seeker_searches s
     set filter_origin_region_id = p_origin_region_id,
         filter_dest_region_id = p_dest_region_id,
         filter_origin_text = nullif(trim(coalesce(p_origin_text, '')), ''),
         filter_dest_text = nullif(trim(coalesce(p_dest_text, '')), '')
   where s.id = p_search_id
     and s.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
     and s.listing_id is null;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

-- ============================
-- THE CORRIDOR BOARD — every main corridor, top to bottom, with its chain
-- ============================

-- geo_corridor_stops (075) lists only the anchors BETWEEN the ends, so the chain a
-- search needs is origin, every stop, destination — and the same region can appear twice
-- in one chain (Babati and Manyara are both Manyara region, Makambako and Njombe are both
-- Njombe). Deduplicated on the way in, in chain order, or the reader would rank a company
-- twice for one region.
create or replace function directory_corridor_board()
returns table (
  corridor_id int, corridor text, kind text, notes text,
  origin_region_id int, origin_region text,
  dest_region_id int, dest_region text,
  region_ids int[], region_names text[], towns text[], companies bigint
)
language sql stable security definer set search_path = public as $$
  with walked as (
    select c.id as corridor_id, x.pos, x.region_id
      from geo_corridors c
      cross join lateral (
        select 0 as pos, c.origin_region_id as region_id
        union all
        select s.seq, s.region_id from geo_corridor_stops s where s.corridor_id = c.id
        union all
        select 1000, c.dest_region_id
      ) x
  ), once as (
    select corridor_id, pos, region_id,
           row_number() over (partition by corridor_id, region_id order by pos) as rn
      from walked
  ), chain as (
    select o.corridor_id,
           array_agg(o.region_id order by o.pos) as region_ids,
           array_agg(g.name_en order by o.pos) as region_names
      from once o join geo_regions g on g.id = o.region_id
     where o.rn = 1
     group by o.corridor_id
  ), stops as (
    select t.corridor_id, array_agg(t.label order by t.pos) as towns
      from (
        select s.corridor_id, s.seq as pos,
               coalesce(s.label, p.name, g.name_en) as label,
               row_number() over (partition by s.corridor_id,
                                  coalesce(s.label, p.name, g.name_en) order by s.seq) as rn
          from geo_corridor_stops s
          join geo_regions g on g.id = s.region_id
          left join geo_places p on p.id = s.place_id
      ) t
     where t.rn = 1
     group by t.corridor_id
  ), on_corridor as (
    select ch.corridor_id, count(distinct f.listing_id) as companies
      from chain ch
      join directory_listings l on l.status = 'live' and l.deleted_at is null
      join directory_listing_regions f on f.listing_id = l.id
     where f.region_id = any(ch.region_ids)
     group by ch.corridor_id
  )
  select c.id, c.name, c.kind, c.notes,
         c.origin_region_id, o.name_en,
         c.dest_region_id, d.name_en,
         ch.region_ids, ch.region_names,
         coalesce(st.towns, '{}'::text[]),
         coalesce(oc.companies, 0)
    from geo_corridors c
    join chain ch on ch.corridor_id = c.id
    join geo_regions o on o.id = c.origin_region_id
    join geo_regions d on d.id = c.dest_region_id
    left join stops st on st.corridor_id = c.id
    left join on_corridor oc on oc.corridor_id = c.id
   order by (c.kind = 'main') desc, coalesce(oc.companies, 0) desc, c.name;
$$;

-- ============================
-- THE READER — one region became an ordered chain, four filters came with it
-- ============================

drop function if exists directory_search(uuid, text, int, text, int, int);
drop function if exists
  directory_search(uuid, text, int, text, int, int, int[], text[], boolean, boolean, int);

create function directory_search(
  p_search_id uuid, p_kind text, p_region_id int, p_search text,
  p_limit int, p_offset int,
  p_route int[] default null, p_services text[] default null,
  p_verified_only boolean default null, p_licence_valid boolean default null,
  p_min_fleet int default null
) returns setof directory_card
language plpgsql volatile security definer set search_path = public as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 60);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  -- A one-region "route" is not a route, and a two-element chain is what the ranking
  -- needs both ends of. Normalising here means a shorter array can never reach the body.
  v_route int[] := case when coalesce(cardinality(p_route), 0) >= 2 then p_route end;
  v_services text[] := case when coalesce(cardinality(p_services), 0) > 0 then p_services end;
  v_first int;
  v_last int;
  v_first_name text;
  v_last_name text;
  v_total int;
begin
  if not coalesce(directory_claim_ok(p_search_id), false) then
    return;
  end if;

  if v_route is not null then
    v_first := v_route[1];
    v_last := v_route[cardinality(v_route)];
    select name_en into v_first_name from geo_regions where id = v_first;
    select name_en into v_last_name from geo_regions where id = v_last;
  end if;

  -- The count and the page below must stay identical apart from their select lists:
  -- this number is the total every card carries and the value the log row settles with,
  -- so a predicate widened in one half and not the other shows up as a result count the
  -- seeker cannot page through.
  select count(*) into v_total
    from directory_listings l
    left join lateral (
      select (exists (select 1 from directory_listing_regions f
                       where f.listing_id = l.id and f.region_id = v_first)
              or l.corridors_served ilike '%' || v_first_name || '%'
              or l.home_base ilike '%' || v_first_name || '%'
              or l.headline ilike '%' || v_first_name || '%') as at_origin,
             (exists (select 1 from directory_listing_regions f
                       where f.listing_id = l.id and f.region_id = v_last)
              or l.corridors_served ilike '%' || v_last_name || '%'
              or l.home_base ilike '%' || v_last_name || '%'
              or l.headline ilike '%' || v_last_name || '%') as at_dest
    ) ends on true
   where l.status = 'live' and l.deleted_at is null
     and (p_kind is null or l.serves && array[p_kind]::text[])
     and (p_region_id is null or exists (
            select 1 from directory_listing_regions f
             where f.listing_id = l.id and f.region_id = p_region_id))
     and (v_services is null
          or not exists (
               select 1 from unnest(v_services) as term(word)
                where position(lower(term.word) in
                        lower(coalesce(l.services_offered, '') || ' ' ||
                              coalesce(l.description, ''))) = 0))
     and (p_verified_only is distinct from true or l.is_verified)
     and (p_licence_valid is distinct from true
          or (l.licence_valid_to is not null and l.licence_valid_to >= current_date))
     and (p_min_fleet is null or coalesce(l.fleet_size_declared, 0) >= p_min_fleet)
     and (v_route is null
          or ends.at_origin or ends.at_dest
          or exists (select 1 from directory_listing_regions f
                      where f.listing_id = l.id and f.region_id = any(v_route)))
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
  -- search re-read it but never rewrite it. Alias-qualified: 061's unqualified `found`
  -- read as plpgsql's own status variable and raised 42702 on every list search (063).
  update seeker_searches s set found = v_total
   where s.id = p_search_id and s.found is null;

  return query
    with hits as (
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
             v_total as total,
             -- Both ends, then either end, then somewhere along the way. A route the
             -- seeker never chose scores nothing, so an ordinary search keeps the order
             -- 061 gave it: verified first, newest publish next, then the name.
             case
               when v_route is null then 0
               when ends.at_origin and ends.at_dest then 3
               when ends.at_origin or ends.at_dest then 2
               else 1
             end as route_score
        from directory_listings l
        left join (
          select dlr.listing_id, array_agg(g.name_en order by g.name_en) as names
            from directory_listing_regions dlr
            join geo_regions g on g.id = dlr.region_id
           group by dlr.listing_id
        ) rg on rg.listing_id = l.id
        left join lateral (
          select (exists (select 1 from directory_listing_regions f
                           where f.listing_id = l.id and f.region_id = v_first)
                  or l.corridors_served ilike '%' || v_first_name || '%'
                  or l.home_base ilike '%' || v_first_name || '%'
                  or l.headline ilike '%' || v_first_name || '%') as at_origin,
                 (exists (select 1 from directory_listing_regions f
                           where f.listing_id = l.id and f.region_id = v_last)
                  or l.corridors_served ilike '%' || v_last_name || '%'
                  or l.home_base ilike '%' || v_last_name || '%'
                  or l.headline ilike '%' || v_last_name || '%') as at_dest
        ) ends on true
       where l.status = 'live' and l.deleted_at is null
         and (p_kind is null or l.serves && array[p_kind]::text[])
         and (p_region_id is null or exists (
                select 1 from directory_listing_regions f
                 where f.listing_id = l.id and f.region_id = p_region_id))
         and (v_services is null
              or not exists (
                    select 1 from unnest(v_services) as term(word)
                     where position(lower(term.word) in
                             lower(coalesce(l.services_offered, '') || ' ' ||
                                   coalesce(l.description, ''))) = 0))
         and (p_verified_only is distinct from true or l.is_verified)
         and (p_licence_valid is distinct from true
              or (l.licence_valid_to is not null and l.licence_valid_to >= current_date))
         and (p_min_fleet is null or coalesce(l.fleet_size_declared, 0) >= p_min_fleet)
         and (v_route is null
              or ends.at_origin or ends.at_dest
              or exists (select 1 from directory_listing_regions f
                          where f.listing_id = l.id and f.region_id = any(v_route)))
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
       order by route_score desc, l.is_verified desc,
                coalesce(l.published_at, l.created_at) desc, l.company_name
    )
    select h.id, h.company_name, h.serves, h.headline, h.description,
           h.services_offered, h.corridors_served, h.home_base, h.region_names,
           h.website, h.fleet_size_declared, h.year_established, h.licence_valid_to,
           h.licence_state, h.contact_name, h.contact_channel, h.is_verified,
           h.published_at, h.total
      from hits h limit v_limit offset v_offset;
end $$;

-- ============================
-- GRANTS AND REVOCATIONS
-- ============================

-- The drop above took 061's and 063's privileges with it, and a new function is born
-- with PUBLIC EXECUTE. Written out again rather than assumed, because a browser role that
-- could call the reader directly would read the whole directory without spending a credit.
grant execute on function
  directory_search(uuid, text, int, text, int, int, int[], text[], boolean, boolean, int),
  directory_corridor_board(),
  platform_auth.record_search_route(uuid, int, int, text, text)
to app_runtime;

revoke all on function
  directory_search(uuid, text, int, text, int, int, int[], text[], boolean, boolean, int),
  directory_corridor_board(),
  platform_auth.record_search_route(uuid, int, int, text, text)
from public, anon, authenticated, service_role;

comment on function directory_search(uuid, text, int, text, int, int, int[], text[], boolean, boolean, int) is
  'RULE 0: the only cross-tenant read of company listings. Returns directory_card columns only, and only against a claim check this tenant paid a credit for. p_route is an ordered region chain; both ends outrank either end, which outranks the middle.';
comment on function directory_corridor_board() is
  'RULE 0: aggregate public facts about WAISHA''s main corridors — the region chain each one crosses and how many live listings sit on it. No company column leaves this function.';
comment on function platform_auth.record_search_route(uuid, int, int, text, text) is
  'The only writer of the route columns on a search log row, bound to the session tenant; consume_search_credit is still the only writer of the row itself.';
comment on column seeker_searches.filter_origin_region_id is
  'Where the seeker asked to collect from, when they searched a route rather than a region.';

-- The old shape is gone, so say what the table now holds — 061's comment predates the
-- route columns and would otherwise leave the next reader looking for them in 061.
do $$ begin
  raise notice '120: directory_search takes a region chain and four filters; % corridor(s) on the board, % search log row(s) already carry a route',
    (select count(*)::int from geo_corridors),
    (select count(*)::int from seeker_searches where filter_origin_region_id is not null);
end $$;

commit;
