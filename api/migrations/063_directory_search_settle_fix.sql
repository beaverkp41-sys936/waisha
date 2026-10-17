-- 063: directory_search could not run. The settle step wrote
--   update seeker_searches set found = ... where id = ... and found is null
-- and FOUND is a reserved plpgsql status variable, so the unqualified reference in the
-- WHERE clause was ambiguous (SQLSTATE 42702). Every list search raised there, the
-- route's transaction rolled the credit back, and seekers were told 500 for a search
-- the meter had already paid for. Alias-qualified, so it reads as a column.
--
-- This replaces 061's function body verbatim apart from that update and the CTE, which
-- was also named "found" — a name only the parser could tell apart from the variable.
begin;

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
    select h.* from hits h limit v_limit offset v_offset;
end $$;

-- CREATE OR REPLACE keeps the function's own privileges, but the house rule is that the
-- grant and the revoke are written next to every definer, so a rebuild from 001 states
-- them here rather than relying on 061 having run first.
grant execute on function
  directory_search(uuid, text, int, text, int, int)
to app_runtime;

revoke all on function
  directory_search(uuid, text, int, text, int, int)
from public, anon, authenticated, service_role;

comment on function directory_search(uuid, text, int, text, int, int) is
  'RULE 0: the only cross-tenant read of company listings. Returns directory_card columns only, and only against a claim check this tenant paid a credit for.';

commit;
