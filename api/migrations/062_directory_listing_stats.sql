-- 062: The one number a company needs about its own directory listing.
--
-- 061 granted `directory.view` as "view own published listing and its search count",
-- but the count lives in seeker_searches, which that tenant can never read — its RLS
-- policy scopes the row to the SEEKER's tenant, and Rule 0 says a cross-tenant read
-- goes through a definer returning fixed columns, not a wider policy. So this file
-- adds the narrow reader instead of widening anything.
--
-- It answers one question — how many times has this tenant's published card been
-- opened by a verified seeker — and returns no seeker identity, no query text, no
-- other company's row, and no tenant ids other than the caller's own. The control
-- register (061's list_directory_for_control) already carries a wider per-listing
-- search count for the office, but it is keyed on a free-text company name and
-- returns every tenant in the database, so a company route must not reuse it.
--
-- SECURITY DEFINER + the 051 revoke in the same file: a new function is EXECUTE-able
-- by PUBLIC until told otherwise, and 051's sweep ran before it existed.

begin;

create or replace function platform_auth.directory_listing_stats(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_listing directory_listings%rowtype;
begin
  -- Reads on the owner's behalf, so the caller's tenant id comes from verified
  -- session claims, never from the request body.
  select * into v_listing from directory_listings
   where tenant_id = p_tenant_id and deleted_at is null limit 1;
  if not found then
    return jsonb_build_object('listed', false);
  end if;

  return jsonb_build_object(
    'listed', true,
    'listing_id', v_listing.id,
    'status', v_listing.status,
    'is_verified', v_listing.is_verified,
    'published_at', v_listing.published_at,
    'card_opens', (select count(*)::int from seeker_searches
                    where listing_id = v_listing.id),
    'last_open_at', (select max(created_at) from seeker_searches
                      where listing_id = v_listing.id));
end $$;

grant execute on function platform_auth.directory_listing_stats(uuid) to app_runtime;
revoke all on function platform_auth.directory_listing_stats(uuid)
from public, anon, authenticated, service_role;

comment on function platform_auth.directory_listing_stats(uuid) is
  'Rule 0 reader: a company sees only how often ITS OWN published card was opened. No seeker identity, no query text, no other listing.';

commit;
