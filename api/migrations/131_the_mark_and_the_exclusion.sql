-- 131 — the mark a company earns, and the hold that takes it off the board (task #343).
--
-- The directory has shipped since 061 and its route filter since 120, but the two things a
-- marketplace is actually judged on are missing from it. A seeker who pays for a search, opens a
-- card and then discovers that three other people were left waiting at the port has nowhere to say
-- it, and the office that knows a company is trading on stolen fuel has nowhere to write that down
-- with a date on it. This migration builds both.
--
-- **The mark.** A rating is only worth anything if it can be traced to a transaction, so a mark is
-- allowed to stand on exactly two things: a booking that was actually confirmed (048), or a card a
-- seeker opened off their own paid search (061's log row). There is no third basis and no way to
-- post an anonymous opinion, because the failure mode of a directory rating is not too few marks,
-- it is a company's competitor filling the board. Which company is being marked is never sent by
-- the caller either — it is worked out of the booking by a trigger, from the *other* party to the
-- job, so a seat cannot rate itself and cannot rate a bystander.
--
-- **The hold.** Blacklisting is a ban, so 121's rule applies to it in full: two seats, one
-- signature, and the window (the number of days) inside the payload that gets hashed. A hold takes
-- effect by suspending the company's listing through the column 061 already gave it, which is the
-- whole reason this file does not touch `directory_search`: 120's ~160-line reader and 061's
-- `directory_card` composite type both filter on `status = 'live'` already, so an excluded company
-- leaves the board the moment the signature is spent, and returns the moment the hold is lifted,
-- with no second copy of the search to keep in step.
--
-- What a vehicle or driver hold does is stated rather than implied: it stops the assignment
-- register (092) opening a new handover, and the desk says out loud that it does not stop the
-- owner from putting that plate on its own trip. 128's lesson — a rule is worth exactly what the
-- register can prove about it, so say the limit beside the effect rather than let a reader
-- invent one.
begin;

-- ============================================================
-- 1. the mark
-- ============================================================

create table if not exists directory_ratings (
  id uuid primary key default gen_random_uuid(),

  -- Both of these are written by the trigger below, never by the caller. The card is what a
  -- seeker was shown, the tenant is who stands behind it, and the name is copied so the register
  -- can be read two years from now without trusting that the card still says the same thing.
  listing_id uuid not null references directory_listings(id),
  listed_tenant_id uuid not null references tenants(id),
  listed_name text not null check (char_length(trim(listed_name)) between 2 and 200),

  -- The two allowed proofs. `booking` = a job that was confirmed between two companies;
  -- `engagement` = a seeker opened this card off their own metered search. Exactly one, and the
  -- pairing is a CHECK rather than a convention so the next handler cannot invent a third basis
  -- by leaving both null.
  basis text not null check (basis in ('booking','engagement')),
  booking_id uuid references transport_bookings(id),
  search_id uuid references seeker_searches(id),

  rater_tenant_id uuid not null references tenants(id),
  rater_user_id uuid not null references users(id),
  rater_kind text not null check (rater_kind in ('company','seeker')),
  -- What a reader is told about the person who marked. A company is named, because the board
  -- already names both parties to every job it carries. A seeker is never named: the register
  -- holds their user id, the board holds only that they were one.
  rater_name text not null check (char_length(trim(rater_name)) between 2 and 200),

  stars int not null check (stars between 1 and 5),
  comment text check (comment is null or char_length(trim(comment)) between 8 and 600),

  -- The company's own answer, written once, beside the mark it answers. Same bounds as 127's
  -- note: a reply exists to be read by the next seeker, so "noted" is refused by the floor.
  reply text check (reply is null or char_length(trim(reply)) between 8 and 600),
  replied_by uuid references users(id),
  replied_at timestamptz,

  -- The office can take a mark off the board. It cannot delete it: a hidden mark keeps its stars,
  -- its author and its reason, which is the only way "we removed that review" can be answered
  -- later with a row instead of a memory.
  hidden_at timestamptz,
  hidden_by uuid references users(id),
  hidden_reason text check (hidden_reason is null
                     or char_length(trim(hidden_reason)) between 8 and 600),

  withdrawn_at timestamptz,
  withdrawn_by uuid references users(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Nobody marks their own card, and a mark states its proof.
  check (rater_tenant_id <> listed_tenant_id),
  check ((basis = 'booking') = (booking_id is not null)),
  check ((basis = 'engagement') = (search_id is not null)),
  -- The basis decides who is speaking: a job is rated by a company that was on it, a card
  -- opened from a metered search by the seeker whose search it was.
  check ((basis = 'booking') = (rater_kind = 'company')),
  check ((replied_by is null) = (replied_at is null)),
  check ((hidden_by is null) = (hidden_at is null)),
  check ((hidden_at is null) or hidden_reason is not null),
  check ((withdrawn_by is null) = (withdrawn_at is null))
);

-- One mark per job, ever, whichever seat at the winning company typed it. One mark per person per
-- card. Both are unconditional rather than "while not withdrawn" — a withdrawn mark keeps its slot,
-- because the alternative is that deleting a review is how you get a free second one.
create unique index directory_ratings_one_per_job
  on directory_ratings (booking_id) where booking_id is not null;
create unique index directory_ratings_one_per_person
  on directory_ratings (listing_id, rater_user_id) where search_id is not null;
create index directory_ratings_listing_idx on directory_ratings (listing_id, created_at desc);
create index directory_ratings_tenant_idx on directory_ratings (listed_tenant_id, created_at desc);
create trigger trg_directory_ratings_updated before update on directory_ratings
  for each row execute function public.set_updated_at();

-- Both sides read their own marks: the seat that wrote one, and the company standing under it.
-- Every other reader — the seekers' board, the office's register — goes through a definer below,
-- which is Rule 0 as 061 and 046 already draw it.
alter table directory_ratings enable row level security;
create policy directory_ratings_read on directory_ratings
  for select to app_runtime
  using (rater_tenant_id  = nullif(current_setting('app.tenant_id', true), '')::uuid
      or listed_tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on directory_ratings to app_runtime;
revoke all on directory_ratings from public, anon, authenticated, service_role;

comment on column directory_ratings.search_id is
  'The seeker''s own metered search row that this mark answers. One mark per person per card, and the proof is 061''s log, not a claim.';
comment on column directory_ratings.hidden_at is
  'Taken off the board by the office. The row and its stars stay: a deleted review cannot be answered later, a hidden one can.';

-- ============================================================
-- 2. who is being marked is worked out, never accepted
-- ============================================================

create or replace function platform_auth.rating_names_a_real_job()
returns trigger language plpgsql set search_path = public as $$ declare
  v_listing directory_listings%rowtype;
  v_booking transport_bookings%rowtype;
  v_request transport_requests%rowtype;
  v_search seeker_searches%rowtype;
  v_rater_type text;
  v_rater_name text;
  v_other uuid;
begin
  select type, name into v_rater_type, v_rater_name from tenants where id = new.rater_tenant_id;
  if v_rater_type is null then
    raise exception 'directory_ratings: no account stands behind tenant %',
      new.rater_tenant_id using errcode = 'P0001';
  end if;

  if new.basis = 'booking' then
    select * into v_booking from transport_bookings where id = new.booking_id;
    if not found then
      raise exception 'directory_ratings: no booking % to mark', new.booking_id
        using errcode = 'P0001';
    end if;
    -- `released` is a temp hold the publisher gave back and `expired` a hold that ran out:
    -- neither is a job anybody did. 048's state list, read the same way the timer reads it.
    if v_booking.status <> 'confirmed' then
      raise exception
        'directory_ratings: booking % is "%". Only a job that was actually booked can be marked.',
        v_booking.id, v_booking.status using errcode = 'P0001';
    end if;
    select * into v_request from transport_requests where id = v_booking.request_id;
    if not found then
      raise exception 'directory_ratings: booking % has no request', v_booking.id
        using errcode = 'P0001';
    end if;
    if new.rater_tenant_id = v_booking.tenant_id then
      v_other := v_request.tenant_id;
    elsif new.rater_tenant_id = v_request.tenant_id then
      v_other := v_booking.tenant_id;
    else
      raise exception
        'directory_ratings: only the two companies on that job can mark it, and this seat is neither'
        using errcode = 'P0001';
    end if;
    new.rater_kind := 'company';
    -- The card marked is the one the other party trades under, and it is read out of the job
    -- rather than typed by the desk: a seat cannot aim a bad mark at a company that was not on
    -- its booking by naming a listing. Neither side of 048's confirmed pair is a card, so the
    -- counterparty is looked up by tenant, which is the same join the board's own reader runs.
    select l.id into new.listing_id from directory_listings l
      where l.tenant_id = v_other and l.deleted_at is null;
    if new.listing_id is null then
      raise exception
        'directory_ratings: the company on the other side of that job has no directory card to mark'
        using errcode = 'P0001';
    end if;
  else
    select * into v_search from seeker_searches where id = new.search_id;
    if not found or v_search.user_id <> new.rater_user_id
                  or v_search.tenant_id <> new.rater_tenant_id then
      raise exception
        'directory_ratings: a seeker can only mark a card found through their own search'
        using errcode = 'P0001';
    end if;
    -- 061 records a null listing_id for "a list, not a single card". Nobody saw that company, so
    -- nobody can report what it was like to deal with.
    if v_search.listing_id is null then
      raise exception
        'directory_ratings: that search opened a list, not a company''s card' using errcode = 'P0001';
    end if;
    if v_rater_type <> 'seeker' then
      raise exception
        'directory_ratings: an opened-card mark is a seeker''s answer, not a company''s'
        using errcode = 'P0001';
    end if;
    new.listing_id := v_search.listing_id;
    new.rater_kind := 'seeker';
  end if;

  select * into v_listing from directory_listings
   where id = new.listing_id and deleted_at is null;
  if not found then
    raise exception 'directory_ratings: no directory card under %', new.listing_id
      using errcode = 'P0001';
  end if;
  -- The company may have withdrawn its card since. The mark still belongs on the register — it is
  -- a record of what was said about who was listed — but it cannot be aimed at somebody else's
  -- card, so the tenant is taken from the listing and asserted against, never from the caller.
  if v_listing.tenant_id = new.rater_tenant_id then
    raise exception 'directory_ratings: a company cannot mark its own card' using errcode = 'P0001';
  end if;
  if new.basis = 'booking' and v_listing.tenant_id <> v_other then
    raise exception
      'directory_ratings: the company behind that card is not the other party to that job'
      using errcode = 'P0001';
  end if;

  new.listed_tenant_id := v_listing.tenant_id;
  new.listed_name := v_listing.company_name;
  new.rater_name := case when new.rater_kind = 'seeker'
                         then 'a seeker on WAISHA' else v_rater_name end;
  return new;
end $$;

-- Runs on insert, and again if anybody touches the columns that decide who marked what. The
-- keeper trigger below refuses such a touch on an existing row; this one is the belt that makes
-- sure the derived columns could never be written by hand even if the keeper were dropped.
create trigger directory_rating_names_a_real_job
  before insert or update of basis, booking_id, search_id, listing_id,
    rater_tenant_id, rater_user_id, rater_kind
  on directory_ratings for each row
  execute function platform_auth.rating_names_a_real_job();

-- What a mark may become after it is written.
--
-- The proof never changes — a job that happened is not reassignable. A mark may be edited by its
-- author until the company answers it, because an answer written against words that have since
-- been retyped is not an answer. A reply is written once. A withdrawn mark is finished.
create or replace function platform_auth.rating_is_kept_not_rewritten()
returns trigger language plpgsql set search_path = public as $$ begin
  if new.basis is distinct from old.basis
     or new.booking_id is distinct from old.booking_id
     or new.search_id is distinct from old.search_id
     or new.listing_id is distinct from old.listing_id
     or new.rater_tenant_id is distinct from old.rater_tenant_id
     or new.rater_user_id is distinct from old.rater_user_id then
    raise exception
      'directory_ratings: % is a mark on a job that happened - the proof cannot be moved',
      old.id using errcode = '23514';
  end if;
  if old.replied_at is not null
     and (new.stars is distinct from old.stars or new.comment is distinct from old.comment) then
    raise exception
      'directory_ratings: % has been answered - the answer stands against the words it answers, so the mark cannot be retyped',
      old.id using errcode = '23514';
  end if;
  if old.replied_at is not null
     and (new.reply is distinct from old.reply or new.replied_by is distinct from old.replied_by) then
    raise exception 'directory_ratings: % already carries its one reply', old.id
      using errcode = '23514';
  end if;
  if old.withdrawn_at is not null
     and (new.withdrawn_at is distinct from old.withdrawn_at
          or new.stars is distinct from old.stars
          or new.comment is distinct from old.comment
          or new.reply is distinct from old.reply) then
    raise exception 'directory_ratings: % was withdrawn by its author and stays withdrawn', old.id
      using errcode = '23514';
  end if;
  if old.hidden_at is not null and new.hidden_at is null
     and (new.stars is distinct from old.stars or new.comment is distinct from old.comment) then
    raise exception
      'directory_ratings: % was hidden for a reason - put the reason right first, then bring it back',
      old.id using errcode = '23514';
  end if;
  return new;
end $$;

create trigger directory_rating_is_kept_not_rewritten
  before update on directory_ratings for each row
  execute function platform_auth.rating_is_kept_not_rewritten();

-- ============================================================
-- 3. the doors on the mark
-- ============================================================

-- Write a mark. Exactly one of the two proofs, and the definer works out from it which company is
-- being marked: the caller never gets to name the target.
create or replace function platform_auth.rate_directory_company(
  p_booking_id uuid,
  p_search_id uuid,
  p_stars int,
  p_comment text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_actor_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_user users%rowtype;
  v_comment text;
  v_id uuid;
  v_open uuid;
  v_listing uuid;
begin
  select * into v_user from users where id = p_actor_user_id and deleted_at is null;
  if not found or v_user.status <> 'active' then
    return jsonb_build_object('status','invalid',
      'message','Only a live seat can put a mark on the board.');
  end if;
  if p_stars is null or p_stars < 1 or p_stars > 5 then
    return jsonb_build_object('status','invalid',
      'message','Stars are one to five.');
  end if;
  v_comment := nullif(trim(coalesce(p_comment, '')), '');
  if v_comment is not null and char_length(v_comment) < 8 then
    return jsonb_build_object('status','invalid',
      'message','A comment is either at least eight characters or not written at all.');
  end if;
  if (p_booking_id is null) = (p_search_id is null) then
    return jsonb_build_object('status','invalid',
      'message','A mark stands on one job or one opened card, and on exactly one of them.');
  end if;

  begin
    insert into directory_ratings (id, basis, booking_id, search_id, listing_id,
        rater_tenant_id, rater_user_id, stars, comment)
    values (gen_random_uuid(),
      case when p_booking_id is not null then 'booking' else 'engagement' end,
      p_booking_id, p_search_id,
      -- The trigger overwrites this from the proof; a placeholder keeps the column not-null on
      -- the statement that has not been derived yet.
      coalesce(p_search_id, p_booking_id),
      v_user.tenant_id, v_user.id, p_stars, v_comment)
    returning id into v_id;
  exception when unique_violation then
    -- The named slot is the honest answer, and the two slots are different questions. A job has one
    -- mark, whoever at the winning company typed it; a card has one mark per person, and the second
    -- one is refused even when it arrives through a different search — so the seeker's clash is
    -- looked for on the card and the author, not on the search row that happens to be in hand.
    select r.id, r.listing_id into v_open, v_listing from directory_ratings r
      where (p_booking_id is not null and r.booking_id = p_booking_id)
         or (p_booking_id is null and r.rater_user_id = p_actor_user_id
             and r.listing_id = (select s.listing_id from seeker_searches s
                                  where s.id = p_search_id))
      order by r.created_at limit 1;
    return jsonb_build_object('status','conflict', 'rating_id', v_open, 'listing_id', v_listing,
      'message', case when p_booking_id is not null
        then 'That job is already marked. A booking is marked once, by whichever seat answers for the company.'
        else 'You have already marked this company. One mark per person per card, and withdrawing the first does not free the slot.'
      end);
  end;

  select listing_id into v_listing from directory_ratings where id = v_id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, after)
  values (gen_random_uuid(), v_user.tenant_id, v_user.id, p_actor_role, p_actor_ip,
      'directory_ratings', v_id, 'directory.rated',
      jsonb_build_object('stars', p_stars, 'comment', v_comment, 'basis',
        case when p_booking_id is not null then 'booking' else 'engagement' end,
        'booking_id', p_booking_id, 'search_id', p_search_id, 'listing_id', v_listing));

  return jsonb_build_object('status','ok', 'rating_id', v_id, 'listing_id', v_listing);
end $$;

-- The company's answer, once, and only from the desk that stands under the card.
create or replace function platform_auth.reply_to_rating(
  p_rating_id uuid, p_reply text,
  p_actor_user_id uuid, p_actor_role text, p_actor_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_r directory_ratings%rowtype;
  v_user users%rowtype;
  v_reply text;
begin
  v_reply := trim(coalesce(p_reply, ''));
  if char_length(v_reply) < 8 or char_length(v_reply) > 600 then
    return jsonb_build_object('status','invalid',
      'message','A reply is 8-600 characters: the next seeker reads it to decide who to call.');
  end if;
  select * into v_r from directory_ratings where id = p_rating_id;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_r.withdrawn_at is not null then
    return jsonb_build_object('status','conflict',
      'message','That mark was withdrawn by the person who wrote it. Nothing is left to answer.');
  end if;
  if v_r.replied_at is not null then
    return jsonb_build_object('status','conflict',
      'message','This mark already carries its answer.');
  end if;
  select * into v_user from users where id = p_actor_user_id and deleted_at is null;
  if not found or v_user.tenant_id <> v_r.listed_tenant_id then
    return jsonb_build_object('status','unauthorised',
      'message','Only the company that card belongs to can answer a mark on it.');
  end if;

  update directory_ratings
     set reply = v_reply, replied_by = v_user.id, replied_at = now(), updated_at = now()
   where id = v_r.id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), v_r.listed_tenant_id, v_user.id, p_actor_role, p_actor_ip,
      'directory_ratings', v_r.id, 'directory.rating_replied',
      jsonb_build_object('reply', null, 'replied_at', null),
      jsonb_build_object('reply', v_reply, 'replied_at', now(), 'listed_name', v_r.listed_name));

  return jsonb_build_object('status','ok', 'rating_id', v_r.id, 'replied_at', now());
end $$;

-- The author takes their own mark off the board. The row stays, the slot stays taken.
create or replace function platform_auth.withdraw_rating(
  p_rating_id uuid,
  p_actor_user_id uuid, p_actor_role text, p_actor_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_r directory_ratings%rowtype;
begin
  select * into v_r from directory_ratings where id = p_rating_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_r.rater_user_id <> p_actor_user_id then
    return jsonb_build_object('status','unauthorised',
      'message','Only the person who wrote a mark can withdraw it.');
  end if;
  if v_r.withdrawn_at is not null then
    return jsonb_build_object('status','ok', 'rating_id', v_r.id,
      'withdrawn_at', v_r.withdrawn_at, 'already', true);
  end if;

  update directory_ratings
     set withdrawn_at = now(), withdrawn_by = p_actor_user_id, updated_at = now()
   where id = v_r.id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), v_r.rater_tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      'directory_ratings', v_r.id, 'directory.rating_withdrawn',
      jsonb_build_object('stars', v_r.stars, 'comment', v_r.comment, 'withdrawn_at', null),
      jsonb_build_object('stars', v_r.stars, 'withdrawn_at', now(),
        'listed_name', v_r.listed_name, 'reply', v_r.reply));

  return jsonb_build_object('status','ok', 'rating_id', v_r.id, 'withdrawn_at', now());
end $$;

-- The author's own words, retyped. The keeper trigger above already refuses this on a mark the
-- company has answered, so the door only has to name the author and check the shape — and without a
-- door at all, the edit the schema allows would be reachable by nobody, since app_runtime holds
-- SELECT on this table and nothing more.
create or replace function platform_auth.edit_rating(
  p_rating_id uuid, p_stars int, p_comment text,
  p_actor_user_id uuid, p_actor_role text, p_actor_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_r directory_ratings%rowtype;
  v_comment text;
begin
  select * into v_r from directory_ratings where id = p_rating_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_r.rater_user_id <> p_actor_user_id then
    return jsonb_build_object('status','unauthorised',
      'message','Only the person who wrote a mark can retype it.');
  end if;
  if v_r.withdrawn_at is not null then
    return jsonb_build_object('status','conflict',
      'message','That mark was withdrawn, and a withdrawn mark stays as its author left it.');
  end if;
  if v_r.replied_at is not null then
    return jsonb_build_object('status','conflict',
      'message','The company has answered this mark: the answer stands against these words.');
  end if;
  if p_stars is null or p_stars < 1 or p_stars > 5 then
    return jsonb_build_object('status','invalid','message','Stars are one to five.');
  end if;
  v_comment := nullif(trim(coalesce(p_comment, '')), '');
  if v_comment is not null and char_length(v_comment) < 8 then
    return jsonb_build_object('status','invalid',
      'message','A comment is either at least eight characters or not written at all.');
  end if;

  update directory_ratings
     set stars = p_stars, comment = v_comment, updated_at = now()
   where id = v_r.id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), v_r.rater_tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      'directory_ratings', v_r.id, 'directory.rating_edited',
      jsonb_build_object('stars', v_r.stars, 'comment', v_r.comment),
      jsonb_build_object('stars', p_stars, 'comment', v_comment,
        'listed_name', v_r.listed_name));

  return jsonb_build_object('status','ok', 'rating_id', v_r.id, 'stars', p_stars,
    'comment', v_comment, 'listing_id', v_r.listing_id);
end $$;

-- The office's moderation of a mark: take it off the board, or put it back. Both need the sentence
-- that says why, and the second one needs it too — a return with no reason is how a hidden review
-- comes back because somebody remembered the author.
create or replace function platform_auth.moderate_rating(
  p_rating_id uuid, p_action text, p_reason text,
  p_actor_user_id uuid, p_actor_role text, p_actor_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_r directory_ratings%rowtype;
  v_seat text;
  v_reason text;
begin
  v_seat := platform_auth.approval_seat(p_actor_user_id);
  if v_seat is null then
    return jsonb_build_object('status','invalid',
      'message','Only a live platform seat can moderate a mark.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('status','invalid',
      'message','The register needs the reason in the record, in 8-600 characters.');
  end if;
  if p_action not in ('hide','unhide') then
    return jsonb_build_object('status','invalid','reason','Unknown moderation action.');
  end if;
  select * into v_r from directory_ratings where id = p_rating_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if p_action = 'hide' and v_r.hidden_at is not null then
    return jsonb_build_object('status','conflict', 'hidden_at', v_r.hidden_at,
      'message','That mark is already off the board.');
  end if;
  if p_action = 'unhide' and v_r.hidden_at is null then
    return jsonb_build_object('status','conflict',
      'message','That mark is on the board already.');
  end if;

  update directory_ratings
     set hidden_at = case when p_action = 'hide' then now() else null end,
         hidden_by = case when p_action = 'hide' then p_actor_user_id else null end,
         hidden_reason = case when p_action = 'hide' then v_reason else null end,
         updated_at = now()
   where id = v_r.id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), v_r.listed_tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      'directory_ratings', v_r.id, 'directory.rating_' || p_action,
      jsonb_build_object('hidden_at', v_r.hidden_at, 'hidden_reason', v_r.hidden_reason),
      jsonb_build_object('hidden_at', case when p_action = 'hide' then now() else null end,
        'hidden_reason', case when p_action = 'hide' then v_reason else null end,
        'listed_name', v_r.listed_name, 'stars', v_r.stars, 'by', v_seat));

  return jsonb_build_object('status','ok', 'rating_id', v_r.id, 'action', p_action,
    'hidden_at', case when p_action = 'hide' then now() else null end, 'reason', v_reason);
end $$;

-- ============================================================
-- 4. what the mark adds up to, and what a seeker is allowed to read
-- ============================================================

-- Marks that count: written, not withdrawn, not hidden. Every aggregate in this module is measured
-- on that one predicate, so the mean beside a card and the number on the office's board cannot
-- disagree with the rows under them.
create or replace function platform_auth.directory_rating_summary(p_listing_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'listing_id', p_listing_id,
    'marks', count(*),
    'mean', coalesce(round(avg(r.stars)::numeric, 1), 0),
    'five', count(*) filter (where r.stars = 5),
    'four', count(*) filter (where r.stars = 4),
    'three', count(*) filter (where r.stars = 3),
    'two', count(*) filter (where r.stars = 2),
    'one', count(*) filter (where r.stars = 1),
    'from_companies', count(*) filter (where r.rater_kind = 'company'),
    'from_seekers', count(*) filter (where r.rater_kind = 'seeker'),
    'answered', count(*) filter (where r.replied_at is not null),
    'since', min(r.created_at))
    from directory_ratings r
   where r.listing_id = p_listing_id
     and r.withdrawn_at is null and r.hidden_at is null;
$$;

-- The marks a seeker may read beside a card. Gated on the same claim check 061 gates the card on,
-- because otherwise the board built from paid searches becomes free for the taking by whoever
-- writes a loop. Nothing here names a seeker: `rater_name` is the constant for that basis.
create or replace function platform_auth.directory_ratings_for(
  p_listing_id uuid, p_search_id uuid, p_limit int, p_offset int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_ok boolean;
  v_rows jsonb;
begin
  -- 061's claim check lives in `public`, which this function's pinned path already sees, and a
  -- definer can read the log row across tenants that an app_runtime session cannot.
  select coalesce(directory_claim_ok(p_search_id), false) into v_ok;
  if not v_ok then
    return jsonb_build_object('status','claim_expired');
  end if;

  select coalesce(jsonb_agg(json_build_object(
      'id', q.id, 'stars', q.stars, 'comment', q.comment, 'basis', q.basis,
      'rater_name', q.rater_name, 'rater_kind', q.rater_kind, 'created_at', q.created_at,
      'reply', q.reply, 'replied_at', q.replied_at) order by q.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select r.id, r.stars, r.comment, r.basis, r.rater_name, r.rater_kind, r.created_at,
             r.reply, r.replied_at
        from directory_ratings r
       where r.listing_id = p_listing_id
         and r.withdrawn_at is null and r.hidden_at is null
       order by r.created_at desc
       limit least(greatest(coalesce(p_limit, 20), 1), 50)
      offset greatest(coalesce(p_offset, 0), 0)) q;

  return jsonb_build_object('status','ok', 'rows', v_rows,
    'summary', platform_auth.directory_rating_summary(p_listing_id));
end $$;

-- The office's marks register: every mark on the platform, with both names and the moderation
-- state, so "which companies are being answered and which are being ignored" is one read.
create or replace function platform_auth.directory_ratings_board(
  p_state text, p_search text, p_limit int, p_offset int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_rows jsonb;
  v_counts jsonb;
begin
  select coalesce(jsonb_agg(json_build_object(
      'id', q.id, 'listing_id', q.listing_id, 'listed_name', q.listed_name,
      'listed_tenant_id', q.listed_tenant_id, 'stars', q.stars, 'comment', q.comment,
      'basis', q.basis, 'booking_id', q.booking_id, 'search_id', q.search_id,
      'rater_name', q.rater_name, 'rater_kind', q.rater_kind,
      'rater_email', q.rater_email, 'created_at', q.created_at,
      'reply', q.reply, 'replied_at', q.replied_at, 'replied_name', q.replied_name,
      'hidden_at', q.hidden_at, 'hidden_reason', q.hidden_reason,
      'hidden_name', q.hidden_name, 'withdrawn_at', q.withdrawn_at, 'total', q.total)
      order by q.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select r.id, r.listing_id, r.listed_name, r.listed_tenant_id, r.stars, r.comment, r.basis,
             r.booking_id, r.search_id, r.rater_name, r.rater_kind, r.created_at,
             r.reply, r.replied_at, r.hidden_at, r.hidden_reason, r.withdrawn_at,
             count(*) over ()::int as total,
             u.email as rater_email,
             ru.full_name as replied_name, hu.full_name as hidden_name
        from directory_ratings r
        left join users u on u.id = r.rater_user_id
        left join users ru on ru.id = r.replied_by
        left join users hu on hu.id = r.hidden_by
       where (p_state is null or p_state = 'all'
              or (p_state = 'live'    and r.withdrawn_at is null and r.hidden_at is null)
              or (p_state = 'answered' and r.withdrawn_at is null and r.replied_at is null)
              or (p_state = 'replied'  and r.replied_at is not null)
              or (p_state = 'hidden'   and r.hidden_at is not null)
              or (p_state = 'withdrawn' and r.withdrawn_at is not null))
         and (p_search is null or btrim(p_search) = ''
              or r.listed_name ilike '%' || btrim(p_search) || '%'
              or r.comment ilike '%' || btrim(p_search) || '%'
              or r.reply ilike '%' || btrim(p_search) || '%')
       order by r.created_at desc
       limit least(greatest(coalesce(p_limit, 30), 1), 100)
      offset greatest(coalesce(p_offset, 0), 0)) q;

  select jsonb_build_object(
           'live', count(*) filter (where withdrawn_at is null and hidden_at is null),
           'mean', coalesce(round(avg(stars) filter (
                    where withdrawn_at is null and hidden_at is null)::numeric, 2), 0),
           'awaiting_answer', count(*) filter (where withdrawn_at is null and hidden_at is null
                                                 and replied_at is null),
           'replied', count(*) filter (where replied_at is not null),
           'hidden', count(*) filter (where hidden_at is not null),
           'withdrawn', count(*) filter (where withdrawn_at is not null),
           'companies', count(*) filter (where rater_kind = 'company'),
           'seekers', count(*) filter (where rater_kind = 'seeker'),
           'total', count(*))
    into v_counts
    from directory_ratings r;

  return jsonb_build_object('rows', coalesce(v_rows, '[]'::jsonb), 'counts', v_counts);
end $$;

-- ============================================================
-- 5. the hold: a dated exclusion of a company, a vehicle or a driver
-- ============================================================

create sequence if not exists directory_exclusion_number_seq;
grant usage, select on sequence directory_exclusion_number_seq to app_runtime;

-- The listing's own flag, so a suspension can say which of the two hands made it. 061's
-- `suspension_reason` already carries the sentence; this carries the fact that the sentence came
-- from a signed exclusion and may not be undone by a desk pressing "reinstate".
alter table directory_listings
  add column if not exists held_by_exclusion boolean not null default false;

alter table directory_listings
  drop constraint if exists directory_listings_hold_check;
alter table directory_listings
  add constraint directory_listings_hold_check
  check (held_by_exclusion = false or status = 'suspended');

comment on column directory_listings.held_by_exclusion is
  'This card is off the board because a signed exclusion holds it. moderate_listing cannot clear it; only lifting the exclusion can.';

create table if not exists directory_exclusions (
  id uuid primary key default gen_random_uuid(),
  -- The platform tenant owns the register, as in 101, 125 and 126. The company the paper is about
  -- is kept beside it, and is never the tenant RLS is measured against.
  tenant_id uuid not null references tenants(id),
  -- BL-2026-00001. Quoted on the phone the way CS- and RF- are, from its own global sequence.
  ref text not null unique check (ref ~ '^BL-[0-9]{4}-[0-9]{5,}$'),

  subject_kind text not null check (subject_kind in ('company','vehicle','driver')),
  -- A polymorphic subject has no single table to point a foreign key at, so the kind and the id
  -- are checked against each other by a trigger, which reads the named table and copies what it
  -- finds. Nothing about the subject is typed by the desk that raises the paper.
  subject_id uuid not null,
  subject_name text not null check (char_length(trim(subject_name)) between 2 and 200),
  subject_label text not null check (char_length(trim(subject_label)) between 2 and 200),
  -- Whose account the subject stands on, derived from the subject itself.
  subject_tenant_id uuid not null references tenants(id),
  -- Only a company hold names a card: a vehicle and a driver belong to a company but are not
  -- listed themselves.
  listing_id uuid references directory_listings(id),
  company_name text not null check (char_length(trim(company_name)) between 2 and 200),

  -- 121's reason vocabulary, unchanged: the desk that already picks a reason for a company ban
  -- picks the same word here, and a second register with its own list of near-synonyms is how
  -- two boards stop being countable against each other.
  reason_code text not null check (reason_code in (
    'terms_violation','long_idle','payment_default','abuse','complaint','security','other')),
  -- The sentence the second seat signs, and the sentence the company is told. Two fields because
  -- 121 found they are not the same text, and are kept apart for the same reason.
  reason text not null check (char_length(trim(reason)) between 8 and 600),
  note text not null check (char_length(trim(note)) between 8 and 600),
  -- The window, signed as part of the payload. There is no open-ended hold on this register: a
  -- ban without a date is a fact nobody is ever asked to re-check.
  days int not null check (days between 1 and 1095),

  status text not null default 'raised' check (status in (
    'raised','pending_signature','active','lifted','refused')),
  raised_by uuid not null references users(id),
  raised_at timestamptz not null default now(),
  approval_id uuid references platform_approvals(id),
  starts_at timestamptz,
  ends_at timestamptz,
  activated_by uuid references users(id),
  activated_at timestamptz,
  lifted_by uuid references users(id),
  lifted_at timestamptz,
  lifted_note text check (lifted_note is null
                          or char_length(trim(lifted_note)) between 8 and 600),
  refused_by uuid references users(id),
  refused_at timestamptz,
  refused_note text check (refused_note is null
                           or char_length(trim(refused_note)) between 8 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check ((subject_kind = 'company') = (listing_id is not null)),
  check (status <> 'pending_signature' or approval_id is not null),
  check (((status = 'active') or (status = 'lifted')) = (starts_at is not null)),
  check (ends_at is null or ends_at > starts_at),
  check (status <> 'active'
         or (approval_id is not null and activated_by is not null and activated_at is not null)),
  check (status <> 'lifted'
         or (lifted_by is not null and lifted_at is not null
             and char_length(trim(coalesce(lifted_note, ''))) >= 8)),
  check (status <> 'refused'
         or (refused_by is not null and refused_at is not null
             and char_length(trim(coalesce(refused_note, ''))) >= 8))
);

create index directory_exclusions_queue on directory_exclusions (status, raised_at desc);
create index directory_exclusions_subject on directory_exclusions (subject_kind, subject_id);
create index directory_exclusions_tenant on directory_exclusions (subject_tenant_id);
create trigger trg_directory_exclusions_updated before update on directory_exclusions
  for each row execute function public.set_updated_at();

-- A company is held off the board by at most one live paper, and one signature buys one paper.
create unique index directory_exclusions_one_live
  on directory_exclusions (subject_kind, subject_id) where status = 'active';
create unique index if not exists directory_exclusions_one_approval
  on directory_exclusions (approval_id) where approval_id is not null;

alter table directory_exclusions enable row level security;
create policy directory_exclusions_tenant on directory_exclusions
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on directory_exclusions to app_runtime;
revoke all on directory_exclusions from public, anon, authenticated, service_role;

comment on column directory_exclusions.days is
  'The window the second seat signed. Ends when the hold ends; an expiry reminder is not raised for a hold, which is why it has a date instead of a phone call.';

-- Read the subject out of the table the kind names, and copy what the register will need to be
-- legible later. Runs on every write, so a plate that is retyped on the vehicle cannot leave the
-- exclusion pointing at a name the vehicle no longer has.
create or replace function platform_auth.exclusion_names_its_subject()
returns trigger language plpgsql set search_path = public as $$ declare
  v_listing directory_listings%rowtype;
  v_vessel vessels%rowtype;
  v_driver drivers%rowtype;
  v_owner tenants%rowtype;
begin
  if new.subject_kind = 'company' then
    select * into v_listing from directory_listings
     where id = new.subject_id and deleted_at is null;
    if not found then
      raise exception 'directory_exclusions: no directory card %', new.subject_id
        using errcode = 'P0001';
    end if;
    new.listing_id := v_listing.id;
    new.subject_tenant_id := v_listing.tenant_id;
    new.subject_name := v_listing.company_name;
    new.subject_label := array_to_string(v_listing.serves, ' + ');
    select * into v_owner from tenants where id = v_listing.tenant_id;
    new.company_name := v_owner.name;

  elsif new.subject_kind = 'vehicle' then
    select * into v_vessel from vessels where id = new.subject_id and deleted_at is null;
    if not found then
      raise exception 'directory_exclusions: no vehicle %', new.subject_id using errcode = 'P0001';
    end if;
    new.subject_tenant_id := v_vessel.tenant_id;
    -- A plate, not the VIN or the engine number: the register is read over the phone.
    new.subject_name := coalesce(nullif(trim(v_vessel.name), ''), v_vessel.plate_number);
    new.subject_label := v_vessel.plate_number || ' · ' || v_vessel.vessel_type;
    select * into v_owner from tenants where id = v_vessel.tenant_id;
    new.company_name := v_owner.name;

  else
    select * into v_driver from drivers where id = new.subject_id and deleted_at is null;
    if not found then
      raise exception 'directory_exclusions: no driver %', new.subject_id using errcode = 'P0001';
    end if;
    new.listing_id := null;
    new.subject_tenant_id := v_driver.tenant_id;
    new.subject_name := v_driver.full_name;
    -- Deliberately not the NIDA number or the phone: those are sealed columns, and nothing that
    -- answers a desk may echo them for a subject the register only has to be able to name.
    new.subject_label := coalesce(nullif(trim(v_driver.licence_class), ''), 'class not on file')
      || ' · ' || v_driver.status;
    select * into v_owner from tenants where id = v_driver.tenant_id;
    new.company_name := v_owner.name;
  end if;

  if v_owner.type <> 'transporter' then
    raise exception
      'directory_exclusions: % belongs to a "%" account, which the directory does not carry',
      new.subject_name, v_owner.type using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger directory_exclusion_names_its_subject
  before insert or update of subject_kind, subject_id, listing_id
  on directory_exclusions for each row
  execute function platform_auth.exclusion_names_its_subject();

-- The rule 121 was built for, in the place a ban is actually written.
create or replace function platform_auth.exclusion_needs_two_seats()
returns trigger language plpgsql set search_path = public as $$ declare
  v_signed int;
begin
  if new.status <> 'active' then return new; end if;
  select count(*) into v_signed from platform_approvals a
    where a.id = new.approval_id
      and a.status in ('approved','applied')
      and a.action = 'directory.exclusion'
      and a.target_kind = 'directory_exclusion'
      and a.target_id = new.id::text
      and a.decided_by = new.activated_by;
  if v_signed = 0 then
    raise exception
      'directory_exclusions: % cannot take effect without a second seat''s signature on this paper (approval_id)',
      new.ref using errcode = '23514';
  end if;
  return new;
end $$;

create trigger directory_exclusions_two_seats
  before insert or update on directory_exclusions for each row
  execute function platform_auth.exclusion_needs_two_seats();

-- A hold that has started keeps its window; a finished paper is finished.
--
-- The window is the thing the second seat agreed to, so a desk cannot raise a thirty-day hold,
-- get it signed, then quietly make it a year.
create or replace function platform_auth.exclusion_window_is_kept()
returns trigger language plpgsql set search_path = public as $$ begin
  if old.status = 'active' and (new.days is distinct from old.days
       or new.starts_at is distinct from old.starts_at
       or new.reason is distinct from old.reason
       or new.reason_code is distinct from old.reason_code
       or new.subject_kind is distinct from old.subject_kind
       or new.subject_id is distinct from old.subject_id) then
    raise exception
      'directory_exclusions: % is running on the sentence a second seat signed - the window or the reason cannot move under it',
      old.ref using errcode = '23514';
  end if;
  if old.status = 'active' and new.status not in ('active','lifted') then
    raise exception 'directory_exclusions: a running hold is lifted with a note, not deleted'
      using errcode = '23514';
  end if;
  if old.status in ('lifted','refused') and new.status is distinct from old.status then
    raise exception 'directory_exclusions: % is % and stays %',
      old.ref, old.status, old.status using errcode = '23514';
  end if;
  -- Before it runs, the desk may still fix the sentence and the window — but not the subject,
  -- because a signature is asked for a named company and must not be walked to another one.
  if old.status in ('raised','pending_signature')
     and (new.subject_kind is distinct from old.subject_kind
          or new.subject_id is distinct from old.subject_id) then
    raise exception
      'directory_exclusions: % is aimed at % - raise a new paper for anybody else',
      old.ref, old.subject_name using errcode = '23514';
  end if;
  if old.status = 'pending_signature' and new.days is distinct from old.days then
    raise exception
      'directory_exclusions: % is waiting on a %-day signature - the window cannot move under it',
      old.ref, old.days using errcode = '23514';
  end if;
  return new;
end $$;

create trigger directory_exclusions_window_kept
  before update on directory_exclusions for each row
  execute function platform_auth.exclusion_window_is_kept();

-- The listing feels the hold.
--
-- Two statements, one per direction. A card cannot come back while a company hold runs on it, and
-- the flag cannot be set or cleared by a desk that has no exclusion to stand on — which is what
-- makes the flag evidence rather than a note.
create or replace function platform_auth.held_listing_stays_down()
returns trigger language plpgsql set search_path = public as $$ declare
  v_hold directory_exclusions%rowtype;
begin
  select * into v_hold from directory_exclusions e
    where e.subject_kind = 'company' and e.subject_tenant_id = new.tenant_id
      and e.status = 'active' and e.ends_at > now()
    order by e.ends_at desc limit 1;
  if found then
    if new.status <> 'suspended' then
      raise exception
        'directory_listings: % is held off the board by exclusion % until % - lift the exclusion first',
        new.company_name, v_hold.ref, v_hold.ends_at using errcode = '23514';
    end if;
    if not new.held_by_exclusion then
      raise exception
        'directory_listings: the hold on % comes from exclusion %, not from this desk',
        new.company_name, v_hold.ref using errcode = '23514';
    end if;
  elsif new.held_by_exclusion then
    raise exception
      'directory_listings: no live exclusion holds %, so the flag has nothing behind it',
      new.company_name using errcode = '23514';
  end if;
  return new;
end $$;

create trigger directory_listing_exclusion_hold
  before insert or update on directory_listings for each row
  execute function platform_auth.held_listing_stays_down();

-- What a vehicle or driver hold stops: the assignment register opening a new handover.
--
-- It does not stop the owner running the plate on its own trip, and the desk says so on the paper
-- rather than leaving the next reader to assume a reach the database never made. The check runs on
-- the row being opened, so ending or editing an old handover is never blocked by a hold raised
-- after it.
create or replace function platform_auth.assignment_refuses_a_held_subject()
returns trigger language plpgsql set search_path = public as $$ declare
  v_hold directory_exclusions%rowtype;
begin
  if new.status <> 'active' then return new; end if;
  select * into v_hold from directory_exclusions e
    where e.status = 'active' and e.ends_at > now()
      and ((e.subject_kind = 'vehicle' and e.subject_id = new.vessel_id)
        or (e.subject_kind = 'driver'  and e.subject_id = new.driver_id))
    order by e.ends_at desc limit 1;
  if found then
    raise exception
      'vessel_assignments: % (%) is held by exclusion % until % - no new handover can be opened on it',
      v_hold.subject_name, v_hold.subject_kind, v_hold.ref, v_hold.ends_at
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger vessel_assignment_refuses_a_held_subject
  before insert or update of status, vessel_id, driver_id on vessel_assignments
  for each row execute function platform_auth.assignment_refuses_a_held_subject();

-- ============================================================
-- 6. the doors on the hold
-- ============================================================

-- Raise the paper. Nothing is suspended by this call: it writes the sentence, the subject and the
-- window, and the desk is told to go and ask for a second signature.
create or replace function platform_auth.raise_directory_exclusion(
  p_subject_kind text, p_subject_id uuid, p_reason_code text, p_reason text, p_note text,
  p_days int, p_actor_user_id uuid, p_actor_role text, p_actor_ip text, p_actor_ua text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_seat text;
  v_reg text;
  v_platform uuid;
  v_ref text;
  v_id uuid;
begin
  v_seat := platform_auth.approval_seat(p_actor_user_id);
  if v_seat is null then
    return jsonb_build_object('status','invalid',
      'message','Only a live platform seat can put somebody on the register.');
  end if;
  -- The register belongs to the office's own tenant, and a seat that is not standing on it has no
  -- business writing to it. 129 asks the same question of a data paper before it will raise one.
  select u.tenant_id, t.type into v_platform, v_reg
    from users u join tenants t on t.id = u.tenant_id
   where u.id = p_actor_user_id;
  if v_reg is null or v_reg <> 'platform' then
    return jsonb_build_object('status','invalid',
      'message','A hold is raised on the office''s own register, not from a company account.');
  end if;
  if p_subject_kind not in ('company','vehicle','driver') then
    return jsonb_build_object('status','invalid',
      'message','A hold is aimed at a company, a vehicle or a driver.');
  end if;
  if p_days is null or p_days < 1 or p_days > 1095 then
    return jsonb_build_object('status','invalid',
      'message','A hold needs a window of 1 to 1095 days. Nothing here is banned forever.');
  end if;
  if char_length(trim(coalesce(p_reason, ''))) < 8
     or char_length(trim(coalesce(p_note, ''))) < 8 then
    return jsonb_build_object('status','invalid',
      'message','Both the sentence the second seat signs and the sentence the company is told '
        'need at least eight characters.');
  end if;

  v_ref := 'BL-' || to_char(now(), 'YYYY') || '-' ||
    lpad(nextval('directory_exclusion_number_seq')::text, 5, '0');
  insert into directory_exclusions (id, tenant_id, ref, subject_kind, subject_id, reason_code,
      reason, note, days, status, raised_by, raised_at)
  values (gen_random_uuid(), v_platform, v_ref, p_subject_kind, p_subject_id, p_reason_code,
      trim(p_reason), trim(p_note), p_days, 'raised', p_actor_user_id, now())
  returning id into v_id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, user_agent, entity,
      entity_id, action, after)
  values (gen_random_uuid(), v_platform, p_actor_user_id, p_actor_role, p_actor_ip,
      left(coalesce(p_actor_ua, ''), 300), 'directory_exclusions', v_id,
      'directory.exclusion_raised',
      jsonb_build_object('ref', v_ref, 'subject_kind', p_subject_kind, 'subject_id', p_subject_id,
        'reason_code', p_reason_code, 'reason', trim(p_reason), 'days', p_days));

  return jsonb_build_object('status','ok', 'exclusion_id', v_id, 'ref', v_ref,
    'state', 'raised', 'days', p_days);
end $$;

-- Ask for the second seat, exactly as 126 does it: the payload is read out of the row by the
-- definer and hashed, so the bytes signed are provably the paper and a figure or a window cannot
-- be typed into a body by whoever is holding the button.
create or replace function platform_auth.propose_directory_exclusion(
  p_exclusion_id uuid, p_reason text,
  p_actor_user_id uuid, p_actor_role text, p_actor_ip text, p_actor_ua text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_name text;
  v_e directory_exclusions%rowtype;
  v_a platform_approvals%rowtype;
  v_reason text;
  v_payload jsonb;
  v_sha text;
  v_expiry timestamptz;
  v_id uuid;
  v_open uuid;
begin
  v_name := platform_auth.approval_seat(p_actor_user_id);
  if v_name is null then
    return jsonb_build_object('status','invalid',
      'message','Only a live platform seat can ask for a signature.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('status','invalid',
      'message','The reason must be 8-600 characters: it is the sentence the second seat signs.');
  end if;

  select * into v_e from directory_exclusions where id = p_exclusion_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_e.status not in ('raised','pending_signature') then
    return jsonb_build_object('status','conflict', 'exclusion_status', v_e.status,
      'message','This paper is finished.');
  end if;
  -- A lapsed or refused signature does not close the paper out: re-asking is the only way out of
  -- an expired window, and 121's one-open-per-target index will keep the slot otherwise.
  if v_e.status = 'pending_signature' then
    select * into v_a from platform_approvals where id = v_e.approval_id;
    if found and v_a.status not in ('lapsed','rejected') then
      return jsonb_build_object('status','conflict', 'approval_status', v_a.status,
        'open_id', v_a.id, 'message','This paper already stands open on a signature.');
    end if;
  end if;

  v_payload := jsonb_build_object('exclusion_id', v_e.id, 'ref', v_e.ref,
    'subject_kind', v_e.subject_kind, 'subject_id', v_e.subject_id,
    'subject_name', v_e.subject_name, 'subject_label', v_e.subject_label,
    'company_name', v_e.company_name, 'company_tenant_id', v_e.subject_tenant_id,
    'listing_id', v_e.listing_id, 'reason_code', v_e.reason_code, 'reason', v_e.reason,
    'note', v_e.note, 'days', v_e.days);
  v_sha := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');
  v_expiry := now() + interval '7 days';

  begin
    insert into platform_approvals (id, action, target_kind, target_id, payload, payload_sha256,
        reason, status, proposed_by, proposed_role, proposed_ip, proposed_ua, expires_at)
    values (gen_random_uuid(), 'directory.exclusion', 'directory_exclusion', v_e.id::text,
        v_payload, v_sha, v_reason, 'pending', p_actor_user_id, p_actor_role, p_actor_ip,
        left(coalesce(p_actor_ua, ''), 300), v_expiry)
    returning id into v_id;
  exception when unique_violation then
    select a.id into v_open from platform_approvals a
     where a.action = 'directory.exclusion' and a.target_kind = 'directory_exclusion'
       and a.target_id = v_e.id::text and a.status = 'pending'
     order by a.created_at desc limit 1;
    return jsonb_build_object('status','conflict',
      'message','A signature for this hold is already open and waiting for a second seat.',
      'open_id', v_open);
  end;

  update directory_exclusions
     set status = 'pending_signature', approval_id = v_id, updated_at = now()
   where id = v_e.id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, user_agent, entity,
      entity_id, action, before, after)
  values (gen_random_uuid(), v_e.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      left(coalesce(p_actor_ua, ''), 300), 'directory_exclusions', v_e.id,
      'directory.exclusion_proposed',
      jsonb_build_object('status', v_e.status, 'approval_id', v_e.approval_id),
      jsonb_build_object('ref', v_e.ref, 'subject', v_e.subject_name,
        'subject_kind', v_e.subject_kind, 'company_name', v_e.company_name,
        'reason', v_reason, 'days', v_e.days, 'approval_id', v_id,
        'payload_sha256', v_sha, 'status', 'pending_signature', 'expires_at', v_expiry,
        'proposed_name', v_name));

  return jsonb_build_object('status','ok', 'approval_id', v_id, 'action', 'directory.exclusion',
    'target_kind', 'directory_exclusion', 'target_id', v_e.id, 'ref', v_e.ref,
    'subject_name', v_e.subject_name, 'days', v_e.days, 'payload_sha256', v_sha,
    'exclusion_status', 'pending_signature', 'expires_at', v_expiry);
end $$;

-- Spend the signature: the hold starts, and a company hold takes its card off the board in the
-- same statement. The window replayed is the window that was signed — read back off the
-- approval's payload, never from the call.
create or replace function platform_auth.apply_directory_exclusion(
  p_approval_id uuid, p_actor_user_id uuid, p_actor_role text, p_actor_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_a platform_approvals%rowtype;
  v_e directory_exclusions%rowtype;
  v_days int;
  v_start timestamptz;
  v_end timestamptz;
  v_state text;
begin
  select * into v_a from platform_approvals where id = p_approval_id;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_a.action <> 'directory.exclusion' or v_a.target_kind <> 'directory_exclusion' then
    return jsonb_build_object('status','invalid',
      'message','That signature is not a hold on the directory.');
  end if;
  if v_a.status <> 'applied' then
    return jsonb_build_object('status','conflict', 'approval_status', v_a.status,
      'message','The signature was not spent by this call.');
  end if;
  if v_a.decided_by <> p_actor_user_id then
    return jsonb_build_object('status','unauthorised',
      'message','Only the seat that released a signature may spend it.');
  end if;

  select * into v_e from directory_exclusions where id = v_a.target_id::uuid for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_e.status = 'active' then
    return jsonb_build_object('status','conflict', 'ref', v_e.ref,
      'message','This hold is already running.');
  end if;
  if v_e.status <> 'pending_signature' then
    return jsonb_build_object('status','conflict', 'exclusion_status', v_e.status,
      'message','This paper is not waiting for that signature.');
  end if;

  v_days := (v_a.payload->>'days')::int;
  if v_days is distinct from v_e.days then
    return jsonb_build_object('status','conflict', 'signed_days', v_days, 'days', v_e.days,
      'message','The window on the paper is not the window that was signed.');
  end if;
  v_start := now();
  v_end := v_start + make_interval(days => v_days);

  update directory_exclusions
     set status = 'active', approval_id = v_a.id, starts_at = v_start, ends_at = v_end,
         activated_by = p_actor_user_id, activated_at = v_start, updated_at = now()
   where id = v_e.id
   returning status into v_state;

  -- The company hold. A vehicle or driver hold changes nothing on the board: it stops the next
  -- handover, which the trigger on the assignment register enforces when it is asked for.
  if v_e.subject_kind = 'company' and v_e.listing_id is not null then
    update directory_listings
       set status = 'suspended', suspension_reason = v_e.note, held_by_exclusion = true,
           updated_by = p_actor_user_id
     where id = v_e.listing_id and deleted_at is null;
  end if;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), v_e.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      'directory_exclusions', v_e.id, 'directory.exclusion_applied',
      jsonb_build_object('status', v_e.status, 'raised_by', v_e.raised_by),
      jsonb_build_object('status', v_state, 'ref', v_e.ref, 'subject', v_e.subject_name,
        'subject_kind', v_e.subject_kind, 'company_name', v_e.company_name,
        'starts_at', v_start, 'ends_at', v_end, 'days', v_days, 'approval_id', v_a.id,
        'raised_by', v_e.raised_by, 'activated_by', p_actor_user_id,
        'payload_sha256', v_a.payload_sha256));

  return jsonb_build_object('status','ok', 'exclusion_id', v_e.id, 'ref', v_e.ref,
    'subject_kind', v_e.subject_kind, 'subject_id', v_e.subject_id,
    'subject_name', v_e.subject_name, 'company_name', v_e.company_name,
    'company_tenant_id', v_e.subject_tenant_id, 'listing_id', v_e.listing_id,
    'exclusion_status', v_state, 'starts_at', v_start, 'ends_at', v_end, 'days', v_days,
    'approval_id', v_a.id, 'raised_by', v_e.raised_by, 'activated_by', p_actor_user_id);
end $$;

-- Refuse the paper. The signature is answered first, so a seat that says no to the hold cannot
-- leave a live proposal standing on the register for the next desk to press by accident.
create or replace function platform_auth.refuse_directory_exclusion(
  p_exclusion_id uuid, p_note text,
  p_actor_user_id uuid, p_actor_role text, p_actor_ip text, p_actor_ua text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_e directory_exclusions%rowtype;
  v_seat text;
  v_note text;
begin
  v_seat := platform_auth.approval_seat(p_actor_user_id);
  if v_seat is null then
    return jsonb_build_object('status','invalid',
      'message','Only a live platform seat can put a paper down.');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('status','invalid',
      'message','The next person at this desk has to be able to read why.');
  end if;
  select * into v_e from directory_exclusions where id = p_exclusion_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_e.status = 'refused' then
    return jsonb_build_object('status','ok', 'exclusion_id', v_e.id, 'ref', v_e.ref,
      'already', true, 'refused_at', v_e.refused_at);
  end if;
  if v_e.status = 'active' then
    return jsonb_build_object('status','conflict',
      'message','This hold is running. Lift it — a refusal is not a release.');
  end if;
  if v_e.status not in ('raised','pending_signature') then
    return jsonb_build_object('status','conflict', 'exclusion_status', v_e.status,
      'message','This paper is finished.');
  end if;

  -- The signature, if one was asked for, is closed by the same hand that is putting the paper
  -- down. Only a pending row can be decided, so a lapsed one is left as the register left it.
  --
  -- 121's two-seat rule is not only a route check — it is CHECK (decided_by <> proposed_by) on the
  -- signature row, and the seat that puts a paper down is allowed to be the seat that asked for the
  -- signature (the door costs `control.directory.exclusion`, which is exactly the duty that
  -- proposes). Writing `rejected` with this actor as its decider would therefore break the CHECK and
  -- the desk would read a 500 for a refusal it is entitled to make. So: when the hand is a different
  -- one, the signature is recorded as rejected by it; when it is the proposer's own hand, the
  -- signature closes undecided — `lapsed`, the only status 121 lets carry no decider — and the
  -- refusal lives on the paper, in refused_by, refused_at and refused_note, which is where a desk
  -- reads it anyway.
  if v_e.approval_id is not null then
    update platform_approvals a
       set status = case when a.proposed_by = p_actor_user_id then 'lapsed' else 'rejected' end,
           decided_by   = case when a.proposed_by <> p_actor_user_id then p_actor_user_id end,
           decided_role = case when a.proposed_by <> p_actor_user_id then p_actor_role end,
           decided_note = case when a.proposed_by <> p_actor_user_id then v_note end,
           decided_ip   = case when a.proposed_by <> p_actor_user_id then p_actor_ip end,
           decided_ua   = case when a.proposed_by <> p_actor_user_id
                               then left(coalesce(p_actor_ua, ''), 300) end,
           decided_at   = case when a.proposed_by <> p_actor_user_id then now() end
     where a.id = v_e.approval_id and a.status = 'pending'
       and a.decided_by is null;
  end if;

  update directory_exclusions
     set status = 'refused', refused_by = p_actor_user_id, refused_at = now(),
         refused_note = v_note, updated_at = now()
   where id = v_e.id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, user_agent, entity,
      entity_id, action, before, after)
  values (gen_random_uuid(), v_e.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      left(coalesce(p_actor_ua, ''), 300), 'directory_exclusions', v_e.id,
      'directory.exclusion_refused',
      jsonb_build_object('status', v_e.status),
      jsonb_build_object('status', 'refused', 'ref', v_e.ref, 'subject', v_e.subject_name,
        'company_name', v_e.company_name, 'note', v_note, 'by', v_seat));

  return jsonb_build_object('status','ok', 'exclusion_id', v_e.id, 'ref', v_e.ref,
    'exclusion_status', 'refused', 'refused_at', now());
end $$;

-- Lift the hold. One seat is enough: 121's rule guards the hand that puts a company out of
-- trading, not the one that lets it back in — which is how 078's unblock has always worked.
--
-- The card does not simply come back. If the account behind it is no longer publishable, the
-- company stays suspended and the answer says so, because a lift that quietly re-published an
-- expired account would be the directory republishing a company the licence gate has already shut.
create or replace function platform_auth.lift_directory_exclusion(
  p_exclusion_id uuid, p_note text,
  p_actor_user_id uuid, p_actor_role text, p_actor_ip text, p_actor_ua text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_e directory_exclusions%rowtype;
  v_seat text;
  v_note text;
  v_other int;
  v_type text;
  v_status text;
  v_restored boolean := false;
begin
  v_seat := platform_auth.approval_seat(p_actor_user_id);
  if v_seat is null then
    return jsonb_build_object('status','invalid',
      'message','Only a live platform seat can lift a hold.');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('status','invalid',
      'message','A hold comes off the register with the sentence that says why.');
  end if;
  select * into v_e from directory_exclusions where id = p_exclusion_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_e.status = 'lifted' then
    return jsonb_build_object('status','ok', 'exclusion_id', v_e.id, 'ref', v_e.ref,
      'already', true, 'lifted_at', v_e.lifted_at);
  end if;
  if v_e.status <> 'active' then
    return jsonb_build_object('status','conflict', 'exclusion_status', v_e.status,
      'message','Only a running hold can be lifted.');
  end if;

  update directory_exclusions
     set status = 'lifted', lifted_by = p_actor_user_id, lifted_at = now(), lifted_note = v_note,
         updated_at = now()
   where id = v_e.id;

  if v_e.subject_kind = 'company' and v_e.listing_id is not null then
    select count(*) into v_other from directory_exclusions e
     where e.subject_kind = 'company' and e.subject_tenant_id = v_e.subject_tenant_id
       and e.status = 'active' and e.ends_at > now() and e.id <> v_e.id;
    select type, status into v_type, v_status from tenants where id = v_e.subject_tenant_id;
    if v_other = 0 and v_type = 'transporter'
       and v_status in ('trial','active','grace') then
      update directory_listings
         set status = 'live', suspension_reason = null, held_by_exclusion = false,
             updated_by = p_actor_user_id
       where id = v_e.listing_id and deleted_at is null;
      v_restored := true;
    else
      -- The hold is off the register; the card stays down for the other reason, and the other
      -- reason is restated on it so the desk is not left comparing two columns.
      update directory_listings
         set held_by_exclusion = false,
             suspension_reason = case when v_other > 0
               then 'Held off the board by another exclusion on this company.'
               else 'No paid licence is current on this account, so it cannot be published.' end,
             updated_by = p_actor_user_id
       where id = v_e.listing_id and deleted_at is null;
    end if;
  end if;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, user_agent, entity,
      entity_id, action, before, after)
  values (gen_random_uuid(), v_e.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      left(coalesce(p_actor_ua, ''), 300), 'directory_exclusions', v_e.id,
      'directory.exclusion_lifted',
      jsonb_build_object('status', v_e.status, 'ends_at', v_e.ends_at),
      jsonb_build_object('status', 'lifted', 'ref', v_e.ref, 'subject', v_e.subject_name,
        'subject_kind', v_e.subject_kind, 'company_name', v_e.company_name,
        'note', v_note, 'by', v_seat, 'card_restored', v_restored));

  return jsonb_build_object('status','ok', 'exclusion_id', v_e.id, 'ref', v_e.ref,
    'exclusion_status', 'lifted', 'lifted_at', now(), 'card_restored', v_restored,
    'subject_kind', v_e.subject_kind, 'subject_name', v_e.subject_name,
    'company_name', v_e.company_name, 'company_tenant_id', v_e.subject_tenant_id);
end $$;

-- The register, with the signature attached, as 126's refund board does it.
create or replace function platform_auth.directory_exclusions_board(
  p_state text, p_kind text, p_search text, p_limit int, p_offset int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_rows jsonb;
  v_counts jsonb;
begin
  select coalesce(jsonb_agg(json_build_object(
      'id', q.id, 'ref', q.ref, 'subject_kind', q.subject_kind, 'subject_id', q.subject_id,
      'subject_name', q.subject_name, 'subject_label', q.subject_label,
      'company_name', q.company_name, 'company_tenant_id', q.subject_tenant_id,
      'listing_id', q.listing_id, 'reason_code', q.reason_code, 'reason', q.reason,
      'note', q.note, 'days', q.days, 'exclusion_status', q.status,
      'raised_name', q.raised_name, 'raised_at', q.raised_at,
      'approval_id', q.approval_id, 'approval_status', q.approval_status,
      'signed_name', q.signed_name, 'approval_expires_at', q.approval_expires_at,
      'payload_sha256', q.payload_sha256,
      'starts_at', q.starts_at, 'ends_at', q.ends_at, 'days_left', q.days_left,
      'lifted_name', q.lifted_name, 'lifted_at', q.lifted_at, 'lifted_note', q.lifted_note,
      'refused_name', q.refused_name, 'refused_at', q.refused_at, 'refused_note', q.refused_note,
      'total', q.total) order by q.raised_at desc), '[]'::jsonb)
    into v_rows
    from (
      select e.id, e.ref, e.subject_kind, e.subject_id, e.subject_name, e.subject_label,
             e.company_name, e.subject_tenant_id, e.listing_id, e.reason_code, e.reason, e.note,
             e.days, e.status, e.raised_at, e.approval_id, e.starts_at, e.ends_at,
             e.lifted_at, e.lifted_note, e.refused_at, e.refused_note,
             greatest(0, ceiling(extract(epoch from (e.ends_at - now())) / 86400))::int
               as days_left,
             count(*) over ()::int as total,
             ru.full_name as raised_name, lu.full_name as lifted_name,
             fu.full_name as refused_name, au.status as approval_status,
             au.expires_at as approval_expires_at, au.payload_sha256,
             du.full_name as signed_name
        from directory_exclusions e
        left join platform_approvals au on au.id = e.approval_id
        left join users ru on ru.id = e.raised_by
        left join users lu on lu.id = e.lifted_by
        left join users fu on fu.id = e.refused_by
        left join users du on du.id = au.decided_by
       where (p_state is null or p_state = 'all'
              or (p_state = 'live'   and e.status = 'active' and e.ends_at > now())
              or (p_state = 'running' and e.status = 'active')
              or (p_state = 'waiting' and e.status = 'pending_signature')
              or (p_state = 'raised'  and e.status = 'raised')
              or (p_state = 'lifted'  and e.status = 'lifted')
              or (p_state = 'refused' and e.status = 'refused'))
         and (p_kind is null or p_kind = 'all' or e.subject_kind = p_kind)
         and (p_search is null or btrim(p_search) = ''
              or e.ref ilike '%' || btrim(p_search) || '%'
              or e.subject_name ilike '%' || btrim(p_search) || '%'
              or e.subject_label ilike '%' || btrim(p_search) || '%'
              or e.company_name ilike '%' || btrim(p_search) || '%'
              or e.reason ilike '%' || btrim(p_search) || '%')
       order by e.raised_at desc
       limit least(greatest(coalesce(p_limit, 30), 1), 100)
      offset greatest(coalesce(p_offset, 0), 0)) q;

  select jsonb_build_object(
           'running', count(*) filter (where status = 'active' and ends_at > now()),
           'expired_hold', count(*) filter (where status = 'active' and ends_at <= now()),
           'awaiting', count(*) filter (where status = 'pending_signature'),
           'raised', count(*) filter (where status = 'raised'),
           'lifted', count(*) filter (where status = 'lifted'),
           'refused', count(*) filter (where status = 'refused'),
           'companies', count(*) filter (where subject_kind = 'company'),
           'vehicles', count(*) filter (where subject_kind = 'vehicle'),
           'drivers', count(*) filter (where subject_kind = 'driver'),
           'total', count(*))
    into v_counts
    from directory_exclusions;

  return jsonb_build_object('rows', coalesce(v_rows, '[]'::jsonb), 'counts', v_counts);
end $$;

-- Everything one hold is made of, for the desk that has to answer "on whose word, and until when".
create or replace function platform_auth.directory_exclusion_detail(p_exclusion_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'exclusion', (select to_jsonb(e) - 'tenant_id' from directory_exclusions e where e.id = p_exclusion_id),
    'approval', (select json_build_object('id', a.id, 'status', a.status, 'reason', a.reason,
        'payload', a.payload, 'payload_sha256', a.payload_sha256, 'expires_at', a.expires_at,
        'proposed_at', a.proposed_at, 'proposed_name', pu.full_name,
        'decided_at', a.decided_at, 'decided_name', du.full_name, 'decided_note', a.decided_note,
        'applied_at', a.applied_at, 'result', a.result)
        from platform_approvals a
        left join users pu on pu.id = a.proposed_by
        left join users du on du.id = a.decided_by
       where a.id = (select approval_id from directory_exclusions where id = p_exclusion_id)),
    'card', (select json_build_object('id', l.id, 'status', l.status, 'is_verified', l.is_verified,
        'suspension_reason', l.suspension_reason, 'held_by_exclusion', l.held_by_exclusion,
        'serves', l.serves, 'published_at', l.published_at)
        from directory_listings l
       where l.id = (select listing_id from directory_exclusions where id = p_exclusion_id)),
    'marks', (select coalesce(jsonb_build_object(
        'marks', count(*), 'mean', coalesce(round(avg(r.stars)::numeric, 1), 0),
        'one', count(*) filter (where r.stars = 1),
        'awaiting_answer', count(*) filter (where r.replied_at is null
                                              and r.withdrawn_at is null and r.hidden_at is null)
        ), '{}'::jsonb)
        from directory_ratings r
       where r.listing_id = (select listing_id from directory_exclusions where id = p_exclusion_id)
         and r.withdrawn_at is null and r.hidden_at is null),
    'holds', (select coalesce(jsonb_agg(json_build_object(
        'ref', e.ref, 'subject_kind', e.subject_kind, 'subject_name', e.subject_name,
        'starts_at', e.starts_at, 'ends_at', e.ends_at) order by e.starts_at desc), '[]'::jsonb)
        from directory_exclusions e
       where e.subject_tenant_id = (select subject_tenant_id from directory_exclusions
                                     where id = p_exclusion_id)
         and e.id <> p_exclusion_id
         and e.status in ('active','lifted')
       limit 20))
   where exists (select 1 from directory_exclusions where id = p_exclusion_id);
$$;

-- Is this subject currently held? One statement so the desk that shows a vehicle or a driver can
-- say it on the same read that lists them, instead of a second query that can answer a moment
-- later against a moment-earlier list.
create or replace function platform_auth.directory_subject_is_held(p_kind text, p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('ref', e.ref, 'ends_at', e.ends_at,
        'reason_code', e.reason_code, 'company_name', e.company_name,
        'subject_name', e.subject_name)
      from directory_exclusions e
     where e.status = 'active' and e.ends_at > now()
       and e.subject_kind = p_kind and e.subject_id = p_id
     limit 1), 'null'::jsonb);
$$;

-- ============================================================
-- 7. the licence gate keeps its word about a held card
-- ============================================================

-- 061's `moderate_listing` answers a desk that presses reinstate on a held company, and verify on
-- one too. Both refusals come back as a status, not as the hold trigger's exception, because a
-- register that answers 500 is a register a desk stops using. Same signature, so the ACL 079
-- pinned for this function survives the replace.
create or replace function platform_auth.moderate_listing(
  p_listing_id uuid, p_actor uuid, p_action text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_listing directory_listings%rowtype;
  v_hold directory_exclusions%rowtype;
  v_status text;
  v_verified boolean;
begin
  select * into v_listing from directory_listings where id = p_listing_id and deleted_at is null;
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  v_status := v_listing.status;
  v_verified := v_listing.is_verified;

  if p_action in ('reinstate','verify') then
    select * into v_hold from directory_exclusions e
      where e.subject_kind = 'company' and e.subject_tenant_id = v_listing.tenant_id
        and e.status = 'active' and e.ends_at > now()
      order by e.ends_at desc limit 1;
    if found then
      return jsonb_build_object('status', 'held', 'ref', v_hold.ref,
        'ends_at', v_hold.ends_at, 'reason_code', v_hold.reason_code,
        'reason', 'This company is held off the board by exclusion ' || v_hold.ref ||
          ' until ' || to_char(v_hold.ends_at at time zone 'UTC', 'YYYY-MM-DD') ||
          '. Lift the exclusion first.');
    end if;
  end if;

  if p_action = 'suspend' then
    if char_length(coalesce(trim(p_note), '')) < 4 then
      return jsonb_build_object('status', 'invalid',
        'reason', 'A suspension needs a reason the company can act on.');
    end if;
    if v_listing.held_by_exclusion then
      return jsonb_build_object('status', 'held',
        'reason', 'This card is already down on an exclusion''s word.');
    end if;
    v_status := 'suspended';
  elsif p_action = 'reinstate' then
    if v_listing.held_by_exclusion then
      return jsonb_build_object('status', 'held',
        'reason', 'This card is down on an exclusion''s word. Lift the exclusion.');
    end if;
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

-- ============================================================
-- 8. the duties this desk runs on
-- ============================================================

-- The four control routes 061 minted were gated by `hasLicenceRole` (super_admin, billing_admin),
-- which is a role test rather than a duty, and 061 said so out loud: no key was invented for a
-- table whose routes did not read one. They read one now. The three keys below are drawn so that
-- nobody who can use the desk today loses anything — billing_admin keeps the pass confirmation and
-- the moderation it already did, and gains no power to ban a company, which is the one thing on
-- this page that a seat paid to move money should not hold.
insert into permissions (key, description) values
  ('control.directory.view',
   'Control - Read the marketplace desk: listings, marks, holds, passes and the register of who is held'),
  ('control.directory.moderate',
   'Control - Moderate the directory: verify or suspend a card, confirm a seeker''s payment reference, hide a mark'),
  ('control.directory.exclusion',
   'Control - Raise, refuse or lift a dated exclusion on a company, a vehicle or a driver')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join permissions p on p.key in ('control.directory.view', 'control.directory.moderate')
where r.tenant_id is null and r.key in ('super_admin','billing_admin')
on conflict do nothing;

-- The desk that already checks a company's paperwork is the desk that reads the marks and the
-- holds, and the one that may put a company off the board.
insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join permissions p on p.key in ('control.directory.view', 'control.directory.moderate',
                                'control.directory.exclusion')
where r.tenant_id is null and r.key = 'compliance_officer'
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.directory.view' from roles r
where r.tenant_id is null and r.key in ('platform_analyst','support_engineer',
                                        'customer_service_agent')
on conflict do nothing;

-- Asking for a hold to be signed costs `control.directory.exclusion`; signing it costs
-- `control.approvals.decide`, the same key that signs a company ban (121) and a refund (126). No
-- fourth signature key is minted here, for 126's reason: the seats that can already sign a company
-- out of trading are the seats that may sign a company off the board.

-- ============================================================
-- 9. grants and revocations
-- ============================================================

grant execute on function
  platform_auth.rate_directory_company(uuid, uuid, int, text, uuid, text, text),
  platform_auth.reply_to_rating(uuid, text, uuid, text, text),
  platform_auth.withdraw_rating(uuid, uuid, text, text),
  platform_auth.edit_rating(uuid, int, text, uuid, text, text),
  platform_auth.moderate_rating(uuid, text, text, uuid, text, text),
  platform_auth.directory_rating_summary(uuid),
  platform_auth.directory_ratings_for(uuid, uuid, int, int),
  platform_auth.directory_ratings_board(text, text, int, int),
  platform_auth.raise_directory_exclusion(text, uuid, text, text, text, int, uuid, text, text, text),
  platform_auth.propose_directory_exclusion(uuid, text, uuid, text, text, text),
  platform_auth.apply_directory_exclusion(uuid, uuid, text, text),
  platform_auth.refuse_directory_exclusion(uuid, text, uuid, text, text, text),
  platform_auth.lift_directory_exclusion(uuid, text, uuid, text, text, text),
  platform_auth.directory_exclusions_board(text, text, text, int, int),
  platform_auth.directory_exclusion_detail(uuid),
  platform_auth.directory_subject_is_held(text, uuid),
  platform_auth.moderate_listing(uuid, uuid, text, text)
to app_runtime;

revoke all on function
  platform_auth.rate_directory_company(uuid, uuid, int, text, uuid, text, text),
  platform_auth.reply_to_rating(uuid, text, uuid, text, text),
  platform_auth.withdraw_rating(uuid, uuid, text, text),
  platform_auth.edit_rating(uuid, int, text, uuid, text, text),
  platform_auth.moderate_rating(uuid, text, text, uuid, text, text),
  platform_auth.directory_rating_summary(uuid),
  platform_auth.directory_ratings_for(uuid, uuid, int, int),
  platform_auth.directory_ratings_board(text, text, int, int),
  platform_auth.raise_directory_exclusion(text, uuid, text, text, text, int, uuid, text, text, text),
  platform_auth.propose_directory_exclusion(uuid, text, uuid, text, text, text),
  platform_auth.apply_directory_exclusion(uuid, uuid, text, text),
  platform_auth.refuse_directory_exclusion(uuid, text, uuid, text, text, text),
  platform_auth.lift_directory_exclusion(uuid, text, uuid, text, text, text),
  platform_auth.directory_exclusions_board(text, text, text, int, int),
  platform_auth.directory_exclusion_detail(uuid),
  platform_auth.directory_subject_is_held(text, uuid),
  platform_auth.moderate_listing(uuid, uuid, text, text)
from public, anon, authenticated, service_role;

-- A trigger body is fired, never called.
revoke all on function
  platform_auth.rating_names_a_real_job(),
  platform_auth.rating_is_kept_not_rewritten(),
  platform_auth.exclusion_names_its_subject(),
  platform_auth.exclusion_needs_two_seats(),
  platform_auth.exclusion_window_is_kept(),
  platform_auth.held_listing_stays_down(),
  platform_auth.assignment_refuses_a_held_subject()
from public, anon, authenticated, app_runtime;

-- ============================================================
-- 10. say what this leaves the platform in
-- ============================================================

do $$ declare
  v_marks int;
  v_holds int;
  v_live int;
  v_held_cards int;
begin
  select count(*) into v_marks from directory_ratings;
  select count(*) into v_holds from directory_exclusions;
  select count(*) into v_live from directory_exclusions
    where status = 'active' and ends_at > now();
  select count(*) into v_held_cards from directory_listings
    where held_by_exclusion and deleted_at is null;
  if v_held_cards > (select count(*) from directory_exclusions
                      where status = 'active' and ends_at > now()
                        and subject_kind = 'company') then
    raise exception
      'directory_listings: % cards are flagged as held but only % company holds run - the flag and the register disagree',
      v_held_cards, (select count(*) from directory_exclusions
                      where status = 'active' and ends_at > now() and subject_kind = 'company');
  end if;
  if (select count(*) from directory_ratings r
        join directory_listings l on l.id = r.listing_id
       where r.listed_tenant_id <> l.tenant_id) > 0 then
    raise exception 'directory_ratings: a mark is filed against a card that is not its target';
  end if;
  raise notice '131: % marks on the board, % holds on the register (% running), % cards held down',
    v_marks, v_holds, v_live, v_held_cards;
end $$;

commit;
