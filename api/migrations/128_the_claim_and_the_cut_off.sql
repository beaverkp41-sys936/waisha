-- 128 — the claim that says two accounts are one, and the seat the office can cut off (task #342,
-- part B).
--
-- Part A (127) built the register: who an account is, what the office has checked, what it is
-- willing to say about it. This file answers the three acts the spec's Customers module still
-- asked for. Two of them are here; the third is named and left, and says why.
--
--   merge duplicates    HERE, as a CLAIM — not a merge. The reason is in section 1 and it is not
--                       caution: the recon walked the schema and found that moving an account's
--                       history onto another is refused by the database itself, not by this file.
--   force logout        HERE. `platform_auth.customer_force_logout` revokes every live session of
--                       one account and reports what it could not reach — an access token already
--                       issued is a signed JWT with no row behind it, and the desk is told that in
--                       the same response that says how many seats it just cut off.
--   GDPR export /       NOT HERE. Migration 129. An erasure is the one act in this module that
--   erasure             destroys rows rather than adding them, it needs a two-seat paper of its
--                       own raised against 121's register (121:196 hard-codes which actions may be
--                       proposed, so a new act is a new propose definer — 126's refund release is
--                       the precedent), and the honest answer to "erase everything about me" is a
--                       per-category one: some of it is legally kept (001's audit register cannot
--                       be edited by anybody, and statutory invoices outlive the account). Putting
--                       a button labelled "erase" in front of a person before that accounting
--                       exists would make a promise the platform cannot keep.
--
-- One thing this file does not change is worth stating, because it is the thing a reader looks for
-- and then distrusts everything else: **no act here shuts an account out.** Blocking and closing
-- stay 078's, with 121's second signature, on `/control/tenants`. A claim can only be written
-- *after* that has happened — the guard says so in the register's own words — and a cut-off only
-- ends sessions, which the person undoes by signing in again.
begin;

-- ============================================================
-- 1. why this is a claim and not a merge
-- ============================================================
--
-- "Merge the duplicates" reads as one act. In this schema it is about two hundred, and most of
-- them are refused before a handler runs. The recon, with the numbers that made the decision:
--
--   * ~70 tables point at `tenants(id)` with no `on delete` clause, which is Postgres' `NO
--     ACTION` — a cargo file, an invoice, a driver, a warehouse receipt. Deleting the second
--     account does not cascade anything; it stops.
--   * ~40 indexes are unique on `(tenant_id, something)` — `file_number` per company, one HQ
--     branch (012:126), one live subscription (005:52). Re-pointing rows at the survivor does not
--     work either: two accounts that both filed container `MSKU1234` produce one clash after the
--     move, and the mover has to choose which file existed.
--   * Some tables are keyed by the tenant itself, so a move is not an update at all:
--     `company_profiles.tenant_id` is unique (012:74) and `office_settings` uses it as the
--     primary key (065:27).
--   * 111's master documents, 118's warehouse register and 126's service papers each carry a
--     trigger that freezes the shape of a row once it has been answered or released — including
--     the tenant it belongs to. 127 does the same to its own checks and notes on purpose:
--     `verification_answer_is_kept` and `note_is_kept_not_rewritten` both refuse
--     `company_tenant_id` changing. An approved NIDA read off company B cannot become an approved
--     read on company A, because it never was one.
--   * And the two accounts can be duplicates *because* they hold the same identity: `users.email`
--     and `users.nida_search` are unique platform-wide, as are `tenants.tin_search` and
--     `phone_search`. A move would put one number on two rows, which the database is right to
--     refuse.
--
-- So a real merge would be a hand-written destroy-and-rebuild script whose failure mode is half a
-- company. What the office actually needs, and what the spec's queue is for, is smaller and
-- honest:
--
--   1. the fact written down — "A and B are one account; A survives, B was closed";
--   2. the *open work* not lost — B's unanswered checks would otherwise sit frozen on a closed
--      account (127 refuses to answer a check against one), so the kinds move onto A as new lines;
--   3. the file made readable — one note on A, in A's own dossier and timeline, naming B.
--
-- Everything else stays where it is, on the closed account, where it happened. That is the
-- decision the carry-forward list is built to show rather than hide: a desk can read exactly which
-- kinds moved and, in the same screen, how much did not.

-- ============================================================
-- 2. the claim
-- ============================================================

create table if not exists customer_duplicate_claims (
  id uuid primary key default gen_random_uuid(),
  -- The office's register, as 127, 126 and 101 keep it. Never either account's own tenant.
  tenant_id uuid not null references tenants(id),
  -- The account that goes on trading.
  survivor_tenant_id uuid not null references tenants(id),
  -- The account that was closed as the extra one. 078 owns the closing; this column only names it.
  loser_tenant_id uuid not null references tenants(id),
  -- What makes them one account, in the desk's own words: the same NIDA, the same TIN, the same
  -- director who signed up twice. 8 characters is 078's floor for a sentence a company is shown.
  reason text not null check (char_length(trim(reason)) between 8 and 600),
  status text not null default 'declared' check (status in ('declared','voided')),
  -- The kinds this claim actually carried onto the survivor, fixed at the moment of the write.
  -- Durable, because "did the merge lose my TIN check?" is a question that has to be answerable in
  -- three years, not re-derived from a register whose open lines have since been answered.
  -- A closed vocabulary, the same five 127's CHECK allows — 128's smoke reads both out of
  -- `pg_constraint` and insists they still say the same thing.
  carried_kinds text[] not null default '{}'
    check (carried_kinds <@ array['national_id','tin','trade_licence',
                                  'transport_licence','insurance']),
  raised_by uuid not null references users(id),
  raised_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references users(id),
  void_reason text check (void_reason is null
                          or char_length(trim(void_reason)) between 8 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The same account twice is not a duplicate, it is one account.
  check (survivor_tenant_id <> loser_tenant_id),
  check (status = 'voided'
         or (voided_at is null and voided_by is null and void_reason is null)),
  check (status <> 'voided'
         or (voided_at is not null and voided_by is not null
             and char_length(trim(void_reason)) >= 8))
);

-- A closed account is the extra one of exactly one pair — declaring it a duplicate of two
-- different survivors is two different stories about which account is real.
create unique index customer_duplicate_claims_one_per_loser
  on customer_duplicate_claims (loser_tenant_id) where status = 'declared';
-- The same pair claimed twice in the same direction is a clerk clicking Save twice.
create unique index customer_duplicate_claims_one_per_pair
  on customer_duplicate_claims (survivor_tenant_id, loser_tenant_id) where status = 'declared';
create index customer_duplicate_claims_survivor
  on customer_duplicate_claims (survivor_tenant_id, raised_at desc);
create index customer_duplicate_claims_register
  on customer_duplicate_claims (tenant_id, raised_at desc);

drop trigger if exists trg_customer_duplicate_claims_updated on customer_duplicate_claims;
create trigger trg_customer_duplicate_claims_updated before update on customer_duplicate_claims
  for each row execute function public.set_updated_at();

alter table customer_duplicate_claims enable row level security;
create policy customer_duplicate_claims_tenant on customer_duplicate_claims for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Insert and update (a claim can be voided, never deleted), select for every read. A voided claim
-- stays: it is the record that the office once thought these were one account and changed its
-- mind, which is the thing a wrong claim has to leave behind.
grant select, insert, update on customer_duplicate_claims to app_runtime;
revoke all on customer_duplicate_claims from public, anon, authenticated, service_role;

comment on column customer_duplicate_claims.loser_tenant_id is
  'A closed account. 078 owns the closing and 121 signs it with a second seat; this claim only names what was closed and why it was the extra one.';
comment on column customer_duplicate_claims.carried_kinds is
  'The check kinds raised anew on the survivor at the moment of the claim. Never re-derived, never edited.';

-- ============================================================
-- 3. the guards
-- ============================================================
--
-- The pair is checked in the table, not only in the definer that writes it, for the reason 127
-- gave: a route checks the way its author understood the rule, and the next route that writes the
-- same row will not. `claim_duplicate` is the only writer today; the trigger is what makes that
-- unimportant.
create or replace function platform_auth.claim_names_a_closed_loser()
returns trigger language plpgsql set search_path = public as $$ declare
  v_keep tenants;
  v_lost tenants;
begin
  select * into v_keep from tenants where id = new.survivor_tenant_id;
  if v_keep.id is null then
    raise exception 'customer_duplicate_claims: no account %', new.survivor_tenant_id::text
      using errcode = '23503';
  end if;
  if v_keep.type = 'platform' then
    raise exception 'customer_duplicate_claims: the office is not an account on the platform and '
      'cannot be the one that survives' using errcode = '23514';
  end if;
  if v_keep.deleted_at is not null then
    raise exception 'customer_duplicate_claims: % is closed and cannot be the account that '
      'survives — a closed account has no trading to carry', v_keep.name using errcode = '23514';
  end if;

  select * into v_lost from tenants where id = new.loser_tenant_id;
  if v_lost.id is null then
    raise exception 'customer_duplicate_claims: no account %', new.loser_tenant_id::text
      using errcode = '23503';
  end if;
  if v_lost.type = 'platform' then
    raise exception 'customer_duplicate_claims: the office cannot be declared a duplicate of an '
      'account' using errcode = '23514';
  end if;
  -- This is the sentence the whole design rests on, so it carries the way forward with it. A
  -- desk that reads it should not have to go and find out where closing happens.
  if v_lost.deleted_at is null then
    raise exception 'customer_duplicate_claims: % is still a live account. Two accounts become '
      'one only after the office has shut the extra one, and closing is a two-seat act on the '
      'tenants desk — raise it there, get the second signature, then come back', v_lost.name
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger customer_duplicate_claim_names_a_closed_loser
  before insert or update on customer_duplicate_claims
  for each row execute function platform_auth.claim_names_a_closed_loser();

-- A claim is kept, and the only thing that may change about it is the office taking it back.
create or replace function platform_auth.claim_is_kept_not_rewritten()
returns trigger language plpgsql set search_path = public as $$ begin
  if new.survivor_tenant_id is distinct from old.survivor_tenant_id
     or new.loser_tenant_id is distinct from old.loser_tenant_id then
    raise exception 'customer_duplicate_claims: a claim keeps the two accounts it named — void '
      'it and raise another' using errcode = '23514';
  end if;
  -- Including what it carried. A claim whose carry-list can be edited afterwards is a claim that
  -- cannot answer "what did the office move on <date>".
  if new.reason is distinct from old.reason
     or new.raised_by is distinct from old.raised_by
     or new.raised_at is distinct from old.raised_at
     or new.carried_kinds is distinct from old.carried_kinds then
    raise exception 'customer_duplicate_claims: % was raised at % and what it carried is kept',
      old.id::text, old.raised_at using errcode = '23514';
  end if;
  if old.status = 'voided' then
    if new.status is distinct from old.status
       or new.voided_at is distinct from old.voided_at
       or new.voided_by is distinct from old.voided_by
       or new.void_reason is distinct from old.void_reason then
      raise exception 'customer_duplicate_claims: a withdrawal is not edited, it is disagreed '
        'with in a new claim' using errcode = '23514';
    end if;
    return new;
  end if;
  -- The one transition out of `declared` is a withdrawal, and a withdrawal arrives complete: the
  -- hand, the hour and the reason. The CHECK says the same of the row; this says it of the change.
  if new.status = 'voided'
     and (new.voided_at is null or new.voided_by is null
          or char_length(trim(coalesce(new.void_reason, ''))) < 8) then
    raise exception 'customer_duplicate_claims: a withdrawal names the hand, the hour and the '
      'reason it was wrong' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger customer_duplicate_claim_is_kept_not_rewritten
  before update on customer_duplicate_claims
  for each row execute function platform_auth.claim_is_kept_not_rewritten();

-- ============================================================
-- 4. the preview: what a claim would carry, and what it would leave
-- ============================================================
--
-- The desk has to see this *before* it commits, because the claim is the office saying two
-- accounts are one and the honest version of that sentence includes its own limits. A merge panel
-- that shows only "2 checks carried" is a panel that teaches the clerk that a merge moves
-- everything. `eligible` is a field rather than an error: the refusal to claim a live account is
-- the most common thing this read has to say, and it has to be said in the register's words on the
-- screen where the clerk is choosing.
create or replace function platform_auth.duplicate_preview(p_survivor uuid, p_loser uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_keep tenants;
  v_lost tenants;
  v_taken int;
begin
  select * into v_keep from tenants where id = p_survivor;
  if v_keep.id is null then
    return jsonb_build_object('status', 'not_found', 'side', 'survivor', 'id', p_survivor);
  end if;
  select * into v_lost from tenants where id = p_loser;
  if v_lost.id is null then
    return jsonb_build_object('status', 'not_found', 'side', 'loser', 'id', p_loser);
  end if;

  -- The same questions the trigger asks, answered as words instead of as a rollback. The order of
  -- the `case` below is the order of the tests in `eligible`, because the sentence the desk shows
  -- has to be the one that actually stopped this pair.
  select count(*)::int into v_taken from customer_duplicate_claims c
   where c.loser_tenant_id = p_loser and c.status = 'declared'
     and c.survivor_tenant_id <> p_survivor;

  return jsonb_build_object(
    'status', 'ok',
    'survivor', jsonb_build_object('id', v_keep.id, 'name', v_keep.name, 'type', v_keep.type,
      'account_status', v_keep.status, 'closed_at', v_keep.deleted_at),
    'loser', jsonb_build_object('id', v_lost.id, 'name', v_lost.name, 'type', v_lost.type,
      'account_status', v_lost.status, 'closed_at', v_lost.deleted_at),
    'eligible', (p_survivor <> p_loser and v_keep.type <> 'platform'
                 and v_lost.type <> 'platform' and v_keep.deleted_at is null
                 and v_lost.deleted_at is not null and v_taken = 0),
    'refusal', case
      when p_survivor = p_loser then 'That is one account, not two.'
      when v_keep.type = 'platform' or v_lost.type = 'platform'
        then 'The office is not an account on the platform, so it cannot be either half of a pair.'
      when v_keep.deleted_at is not null
        then v_keep.name || ' is closed — a closed account cannot be the one that survives.'
      when v_lost.deleted_at is null
        then v_lost.name || ' is still live. Closing it is a two-seat act on the tenants desk; '
          'claim the duplicate after the second signature lands.'
      when v_taken > 0
        then v_lost.name || ' is already declared the extra account of another survivor. One '
          'closed account is the duplicate of one account only.'
      else null end,
    -- The open lines that would move, kind by kind.
    'carries', coalesce((select jsonb_agg(json_build_object('kind', l.kind, 'loser_status',
              l.status, 'loser_raised_at', l.raised_at, 'loser_tail', l.reference_tail)
            order by l.kind)
            from customer_verifications l
           where l.company_tenant_id = p_loser and l.status in ('awaiting','submitted')
             and not exists (select 1 from customer_verifications s
                              where s.company_tenant_id = p_survivor and s.kind = l.kind
                                and s.status in ('awaiting','submitted'))), '[]'::jsonb),
    'skips', coalesce((select jsonb_agg(json_build_object('kind', l.kind, 'because',
              'the survivor already has an open ' || l.kind || ' line') order by l.kind)
            from customer_verifications l
           where l.company_tenant_id = p_loser and l.status in ('awaiting','submitted')
             and exists (select 1 from customer_verifications s
                          where s.company_tenant_id = p_survivor and s.kind = l.kind
                            and s.status in ('awaiting','submitted'))), '[]'::jsonb),
    'stays_behind', jsonb_build_object(
      'checks_answered', (select count(*)::int from customer_verifications l
                           where l.company_tenant_id = p_loser
                             and l.status in ('approved','rejected','needs_more')),
      -- A line listed under "what moves" must not also be counted as staying behind, so the
      -- open lines that carry are excluded here the same way the clause above selects them.
      'checks_open', (select count(*)::int from customer_verifications l
                       where l.company_tenant_id = p_loser
                         and l.status in ('awaiting','submitted')
                         and exists (select 1 from customer_verifications s
                                      where s.company_tenant_id = p_survivor and s.kind = l.kind
                                        and s.status in ('awaiting','submitted'))),
      'notes', (select count(*)::int from customer_notes n
                 where n.company_tenant_id = p_loser and n.voided_at is null),
      'labels', (select count(*)::int from customer_taggings t
                  where t.company_tenant_id = p_loser and t.deleted_at is null),
      'papers', (select count(*)::int from documents d
                  where d.entity_type = 'tenant' and d.entity_id = p_loser
                    and d.deleted_at is null),
      'calls', (select count(*)::int from support_tickets s
                 where s.company_tenant_id = p_loser and s.deleted_at is null),
      'calls_open', (select count(*)::int from support_tickets s
                      where s.company_tenant_id = p_loser and s.deleted_at is null
                        and s.status in ('open','allocated','in_progress')),
      'disputes', (select count(*)::int from service_disputes d
                    where d.company_tenant_id = p_loser and d.deleted_at is null),
      'refund_papers', (select count(*)::int from service_refund_requests r
                         where r.company_tenant_id = p_loser),
      'cargo_files', (select count(*)::int from cargo_shipments c
                       where c.tenant_id = p_loser and c.deleted_at is null),
      'seats', (select count(*)::int from users u
                 where u.tenant_id = p_loser and u.deleted_at is null
                   and u.status = 'active'),
      'sessions_live', (select count(*)::int from sessions s
                         where s.tenant_id = p_loser and s.revoked_at is null)),
    -- What already stands between this pair, so a clerk does not raise a second claim for the
    -- same two accounts and read the refusal as a fault.
    'already', coalesce((select jsonb_agg(json_build_object('id', c.id, 'status', c.status,
              'reason', c.reason, 'raised_at', c.raised_at, 'carried_kinds', c.carried_kinds,
              'direction', case when c.survivor_tenant_id = p_survivor
                               then 'same' else 'reversed' end) order by c.raised_at desc)
            from customer_duplicate_claims c
           where (c.survivor_tenant_id = p_survivor and c.loser_tenant_id = p_loser)
              or (c.survivor_tenant_id = p_loser and c.loser_tenant_id = p_survivor)), '[]'::jsonb),
    'clock', now());
end $$;

-- ============================================================
-- 5. the write: a claim, the open work it carries, one note
-- ============================================================
--
-- One definer, three writes, one transaction (the route runs it inside `withTenant`, so a failure
-- on the third statement rolls back the first — a claim with no note under it would be a claim the
-- survivor's own file does not know about).
--
-- The carry is a **new line on the survivor**, never an update of the loser's. 127's
-- `verification_answer_is_kept` refuses to move a check between accounts and
-- `verification_names_its_account` refuses to answer one against a closed account, so the loser's
-- lines would otherwise sit frozen with an office decision owed and nobody allowed to make it. A
-- new line says what is true: this kind still has to be checked, on the account that survives. It
-- carries no number, no paper and no reason, because the number was read off the *other*
-- account's paper and copying it would make the survivor's file say something that never happened.
create or replace function platform_auth.claim_duplicate(
  p_register uuid, p_survivor uuid, p_loser uuid, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_keep tenants;
  v_lost tenants;
  v_reg text;
  v_carried text[];
  v_claim uuid;
  v_note uuid;
  v_words text;
  v_row jsonb;
begin
  -- This function writes as its owner, so 127's RLS policy does not bind it: the register's own
  -- type is the check that stands in for the policy here. A caller cannot aim a claim at a
  -- company's tenant and make it look like that company keeps the office's duplicate register.
  select t.type into v_reg from tenants t where t.id = p_register;
  if v_reg is null or v_reg <> 'platform' then
    return jsonb_build_object('status', 'invalid', 'message',
      'A claim is written on the office''s own register. This session is not one.');
  end if;

  select * into v_keep from tenants where id = p_survivor;
  if v_keep.id is null then
    return jsonb_build_object('status', 'not_found', 'side', 'survivor', 'id', p_survivor);
  end if;
  select * into v_lost from tenants where id = p_loser;
  if v_lost.id is null then
    return jsonb_build_object('status', 'not_found', 'side', 'loser', 'id', p_loser);
  end if;
  -- The trigger will refuse all of these too. Answering them here is what puts a sentence on the
  -- desk instead of a rollback in the log, and it costs the write nothing.
  if p_survivor = p_loser then
    return jsonb_build_object('status', 'invalid', 'message',
      'That is one account, not two. A claim names a survivor and the extra one.');
  end if;
  if v_keep.type = 'platform' then
    return jsonb_build_object('status', 'invalid', 'message',
      'The office is not an account on the platform and cannot be the one that survives.');
  end if;
  if v_keep.deleted_at is not null then
    return jsonb_build_object('status', 'invalid', 'message',
      v_keep.name || ' is closed — a closed account cannot be the one that survives.');
  end if;
  if v_lost.type = 'platform' then
    return jsonb_build_object('status', 'invalid', 'message',
      'The office cannot be declared the extra copy of an account.');
  end if;
  if v_lost.deleted_at is null then
    return jsonb_build_object('status', 'invalid', 'message',
      v_lost.name || ' is still a live account. Two accounts become one only after the office '
      || 'has shut the extra one — closing is a two-seat act on the tenants desk, so raise that '
      || 'first and bring the second signature back here.');
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 8 then
    return jsonb_build_object('status', 'invalid', 'message',
      'A claim has to say what makes them the same account — the same NIDA, the same TIN, the '
      || 'same director who signed up twice.');
  end if;

  -- The carry-list is fixed before the row is written, so `carried_kinds` goes in with the claim
  -- and is frozen by the same trigger that keeps the reason. Deriving it afterwards would be an
  -- update the guard refuses — on purpose.
  select coalesce(array_agg(distinct l.kind order by l.kind), '{}'::text[]) into v_carried
    from customer_verifications l
   where l.company_tenant_id = p_loser and l.status in ('awaiting','submitted')
     and not exists (select 1 from customer_verifications s
                      where s.company_tenant_id = p_survivor and s.kind = l.kind
                        and s.status in ('awaiting','submitted'));

  insert into customer_duplicate_claims
      (tenant_id, survivor_tenant_id, loser_tenant_id, reason, carried_kinds, raised_by)
  values (p_register, p_survivor, p_loser, trim(p_reason), v_carried, p_actor)
  returning id into v_claim;

  if v_carried <> '{}'::text[] then
    -- A concurrent claim for the same survivor can already have opened one of these kinds; 127's
    -- partial unique index then refuses this insert, and the transaction takes the claim row with
    -- it. That is the right outcome — the desk is told the line exists rather than left with a
    -- claim that carried nothing.
    insert into customer_verifications
        (tenant_id, company_tenant_id, kind, status, raised_by)
    select p_register, p_survivor, k, 'awaiting', p_actor
      from unnest(v_carried) k;
  end if;

  v_words := 'Duplicate of ' || v_lost.name || ', closed '
    || to_char(v_lost.deleted_at, 'YYYY-MM-DD') || ' — this is the account that carries on. '
    || case when v_carried = '{}'::text[]
            then 'It had no unanswered checks to carry.'
            else 'Carried onto this account as new lines to be checked: '
                 || array_to_string(v_carried, ', ') || '.' end
    || ' Nothing else moved: ' || v_lost.name || '''s answered checks, notes, labels, filed '
    || 'papers, calls and cargo stay on its own file, because that is where they happened. '
    || 'Why they are one account: ' || trim(p_reason)
    || ' (claim ' || left(v_claim::text, 8) || ').';

  insert into customer_notes (tenant_id, company_tenant_id, body, author)
  values (p_register, p_survivor, left(v_words, 2000), p_actor)
  returning id into v_note;

  select jsonb_build_object('id', c.id, 'status', c.status, 'reason', c.reason,
           'carried_kinds', c.carried_kinds, 'raised_at', c.raised_at,
           'raised_name', u.full_name,
           'survivor', jsonb_build_object('id', s.id, 'name', s.name, 'type', s.type),
           'loser', jsonb_build_object('id', l.id, 'name', l.name, 'type', l.type,
                                       'closed_at', l.deleted_at))
    into v_row
    from customer_duplicate_claims c
    join tenants s on s.id = c.survivor_tenant_id
    join tenants l on l.id = c.loser_tenant_id
    left join users u on u.id = c.raised_by
   where c.id = v_claim;

  return jsonb_build_object('status', 'ok', 'claim', v_row, 'note_id', v_note,
    'carried', coalesce((select jsonb_agg(json_build_object('kind', k) order by k)
                           from unnest(v_carried) k), '[]'::jsonb),
    'clock', now());
end $$;

-- Take a claim back. The carried lines stay — they are the survivor's own checks now and 127 keeps
-- what an answer was made on — so the withdrawal says that out loud rather than leaving a file
-- with two stories about the same licence.
create or replace function platform_auth.void_duplicate_claim(
  p_register uuid, p_claim uuid, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v customer_duplicate_claims%ROWTYPE;
  v_lost tenants;
  v_reg text;
  v_note uuid;
  v_words text;
begin
  select t.type into v_reg from tenants t where t.id = p_register;
  if v_reg is null or v_reg <> 'platform' then
    return jsonb_build_object('status', 'invalid', 'message',
      'A claim is kept on the office''s own register. This session is not one.');
  end if;
  select * into v from customer_duplicate_claims c
   where c.id = p_claim and c.tenant_id = p_register;
  if v.id is null then
    return jsonb_build_object('status', 'not_found', 'claim', p_claim);
  end if;
  if v.status = 'voided' then
    return jsonb_build_object('status', 'invalid', 'message',
      'That claim was already withdrawn on ' || to_char(v.voided_at, 'YYYY-MM-DD')
      || '. A withdrawal is not edited — it is disagreed with in a new claim.');
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 8 then
    return jsonb_build_object('status', 'invalid', 'message',
      'Taking a claim back needs a sentence as good as the one that made it.');
  end if;

  select * into v_lost from tenants where id = v.loser_tenant_id;

  update customer_duplicate_claims
     set status = 'voided', voided_at = now(), voided_by = p_actor, void_reason = trim(p_reason)
   where id = p_claim;

  v_words := 'That duplicate claim was withdrawn: this account is not the same account as '
    || coalesce(v_lost.name, 'the closed account') || '. '
    || case when v.carried_kinds = '{}'::text[]
            then 'The claim carried nothing, so nothing needs undoing.'
            else 'The checks it carried stay on this file — ' || array_to_string(v.carried_kinds, ', ')
                 || ' — because a carried line is this account''s own check and an answer once '
                 || 'given is kept. Answer them as they deserve.' end
    || ' Reason: ' || trim(p_reason);

  insert into customer_notes (tenant_id, company_tenant_id, body, author)
  values (p_register, v.survivor_tenant_id, left(v_words, 2000), p_actor)
  returning id into v_note;

  return jsonb_build_object('status', 'ok',
    'claim', jsonb_build_object('id', p_claim, 'status', 'voided',
      'void_reason', trim(p_reason), 'voided_at', now(),
      'voided_name', (select u.full_name from users u where u.id = p_actor),
      'carried_kinds', v.carried_kinds),
    'note_id', v_note, 'clock', now());
end $$;

-- ============================================================
-- 6. who is in the building, and the cut
-- ============================================================
--
-- A cut-off is decided by looking at the live sessions, so the read and the act are both here and
-- both bind the same tenant. The read gives names and the last activity, not emails: a clerk needs
-- to know which director is on the account before ending their work, and the email is on the staff
-- desk already. It is gated on the disconnect duty rather than on `view` for the same reason —
-- "who is signed in right now" is not a register read, it is live access to a company.
create or replace function platform_auth.customer_access(p_company uuid)
returns jsonb language sql security definer set search_path = public as $$
  -- The outer `coalesce` is not tidiness: with no matching row the subselect returns no rows at
  -- all, and a read that answers NULL for an unknown company gives the desk an empty object and no
  -- reason. `not_found` is the answer.
  select coalesce((
    select case when t.type = 'platform'
      then jsonb_build_object('status', 'invalid', 'message',
        'The office signs in as staff. Its own sessions are on the staff desk.')
      else jsonb_build_object(
      'status', 'ok',
      'company', jsonb_build_object('id', t.id, 'name', t.name, 'type', t.type,
        'account_status', t.status, 'closed_at', t.deleted_at),
      -- One row per person, not per session: a seat with three devices is one person to warn.
      'sessions', coalesce((select jsonb_agg(json_build_object(
              'user_id', s.user_id, 'name', u.full_name, 'user_type', u.user_type,
              'last_seen', s.last_refreshed_at, 'ip', host(s.ip),
              'device', left(coalesce(s.user_agent, ''), 60),
              'borrowed_by', case when s.actor_user_id is null then null
                else (select a.full_name from users a where a.id = s.actor_user_id) end)
            order by s.last_refreshed_at desc)
            from (select distinct on (x.user_id) x.*
                    from sessions x
                   where x.tenant_id = t.id and x.revoked_at is null and x.expires_at > now()
                   order by x.user_id, x.last_refreshed_at desc) s
            left join users u on u.id = s.user_id), '[]'::jsonb),
      'live', (select count(*)::int from sessions s
                where s.tenant_id = t.id and s.revoked_at is null and s.expires_at > now()),
      -- Somebody from the office is already sitting in this company through 106's read-only view.
      -- A cut-off ends that visit too, and the person running it should know before it happens.
      'borrowed_views', (select count(*)::int from sessions s
                          where s.tenant_id = t.id and s.revoked_at is null
                            and s.expires_at > now() and s.actor_user_id is not null),
      'seats', (select count(*)::int from users u where u.tenant_id = t.id
                 and u.deleted_at is null and u.status = 'active'),
      -- Every cut-off this account has already had, read off the session rows themselves. No new
      -- register: the revocation is the record, and the seat that signed it is in the audit
      -- register, which `/control/audit` reads.
      'cut_offs', jsonb_build_object(
        'sessions_cut', (select count(*)::int from sessions s
                   where s.tenant_id = t.id and s.revoked_reason = 'control_force_logout'),
        'last_at', (select max(s.revoked_at) from sessions s
                     where s.tenant_id = t.id and s.revoked_reason = 'control_force_logout')),
      'clock', now())
    end
    from tenants t where t.id = p_company),
    jsonb_build_object('status', 'not_found', 'company_id', p_company));
$$;

-- The cut itself.
--
-- One seat, deliberately. The spec's two-signature rule names four acts — money, prices, bans and
-- permission changes — and this is none of them: it ends sessions, and the person whose session
-- ended signs in again. The acts that stop an account trading are 078's, and they already carry a
-- second signature. What this act is for is the call that says "somebody else has my password":
-- the office's answer has to be a minute old, not waiting for a second desk to open.
--
-- The honest half of the answer is what it cannot reach. An access token is a signed JWT with no
-- row behind it (15 minutes, `security/jwt.ts`), so a token already in a browser keeps working
-- until it expires. 078's block closes that window through the per-request gate; a plain cut-off
-- does not, and the response says so in the same breath as the count, in words the desk repeats.
create or replace function platform_auth.customer_force_logout(p_company uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v tenants;
  v_revoked int := 0;
  v_borrowed int := 0;
begin
  select * into v from tenants where id = p_company;
  if v.id is null then
    return jsonb_build_object('status', 'not_found', 'company_id', p_company);
  end if;
  if v.type = 'platform' then
    return jsonb_build_object('status', 'invalid', 'message',
      'The office does not sign in as a customer. A control seat is cut off on the staff desk, '
      || 'where its own session list is.');
  end if;
  -- A closed account has nothing to cut: 078 revoked its sessions when it set the tombstone, with
  -- the reason already written down. Answering `0 revoked` would read like a failure of this act.
  if v.deleted_at is not null then
    return jsonb_build_object('status', 'invalid', 'message',
      v.name || ' is already closed — its sessions went with the tombstone on the tenants desk '
      || '(reason tenant_closed).');
  end if;
  -- A blocked account is cut as well as a live one: the gate covers the token window, but the
  -- sessions sitting behind a block are the thing to end while a stolen password is in use.
  -- Counted before the revoke, because afterwards every one of them is `revoked_at = now()`.
  select count(*)::int into v_borrowed from sessions s
   where s.tenant_id = p_company and s.revoked_at is null and s.actor_user_id is not null;

  update sessions
     set revoked_at = now(), revoked_reason = 'control_force_logout'
   where tenant_id = p_company and revoked_at is null;
  get diagnostics v_revoked = row_count;

  return jsonb_build_object('status', 'ok',
    'company', jsonb_build_object('id', v.id, 'name', v.name, 'type', v.type,
      'account_status', v.status, 'blocked', v.status = 'suspended'),
    'sessions_revoked', v_revoked,
    'of_which_borrowed_views', v_borrowed,
    'seats', (select count(*)::int from users u where u.tenant_id = v.id
               and u.deleted_at is null and u.status = 'active'),
    'window', jsonb_build_object(
      'minutes', 15,
      'gated', v.status = 'suspended',
      'words', case when v.status = 'suspended'
        then 'This account is blocked, so the per-request gate closes the token window as well: '
          || 'nothing new is served.'
        else 'A token already issued stays usable for up to 15 minutes — it is a signed key, not '
          || 'a row. Nobody can start a new session on these credentials, and to shut the window '
          || 'sooner the account has to be blocked, which is a two-seat act on the tenants desk.'
        end),
    'clock', now());
end $$;

-- ============================================================
-- 7. duties
-- ============================================================
--
-- `control.customers.merge` is kept apart from `manage` on purpose: the seat that can label and
-- annotate an account is not thereby able to record that two accounts were one, because a claim
-- leans on a closure that took two signatures to make. `control.customers.disconnect` is the
-- cut-off, and the office's agent who takes "somebody else is in my account" is exactly the person
-- who must be able to end it without waiting for a second desk.
insert into permissions (key, description) values
  ('control.customers.merge',
   'Control - Declare two accounts one account, and take that declaration back'),
  ('control.customers.disconnect',
   'Control - See who is signed in to an account and end every one of those sessions')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.customers.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','customer_service_agent','compliance_officer',
                 'support_engineer','platform_analyst','billing_admin')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.customers.merge'
  from roles r
 where r.tenant_id is null and r.key in ('super_admin','compliance_officer')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.customers.disconnect'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','compliance_officer','customer_service_agent')
on conflict do nothing;

-- ============================================================
-- 8. grants on the doors
-- ============================================================
-- A trigger body is fired, never called: the owner alone holds these (110, 121, 125, 126, 127).
revoke all on function
  platform_auth.claim_names_a_closed_loser(),
  platform_auth.claim_is_kept_not_rewritten()
from public, anon, authenticated, app_runtime;

grant execute on function
  platform_auth.duplicate_preview(uuid, uuid),
  platform_auth.claim_duplicate(uuid, uuid, uuid, text, uuid),
  platform_auth.void_duplicate_claim(uuid, uuid, text, uuid),
  platform_auth.customer_access(uuid),
  platform_auth.customer_force_logout(uuid)
to app_runtime;

revoke all on function
  platform_auth.duplicate_preview(uuid, uuid),
  platform_auth.claim_duplicate(uuid, uuid, uuid, text, uuid),
  platform_auth.void_duplicate_claim(uuid, uuid, text, uuid),
  platform_auth.customer_access(uuid),
  platform_auth.customer_force_logout(uuid)
from public, anon, authenticated, service_role;

-- ============================================================
-- 9. say what this leaves the platform in
-- ============================================================
do $$ declare
  v_claims int;
  v_live int;
  v_voided int;
  v_bad int;
  v_outside int;
  v_lost_carry int;
  v_mergers int;
  v_cutters int;
  v_seen int;
  v_answer jsonb;
  v_live_tenant uuid;
  v_closed_tenant uuid;
begin
  select count(*)::int into v_claims from customer_duplicate_claims;
  select count(*)::int into v_live from customer_duplicate_claims where status = 'declared';
  select count(*)::int into v_voided from customer_duplicate_claims where status = 'voided';

  -- A standing claim whose loser is still open, or whose survivor is closed, is the row this
  -- migration exists to refuse. If one is here the trigger did not do its job, so the gate stops
  -- rather than notices.
  select count(*)::int into v_bad from customer_duplicate_claims c
    join tenants l on l.id = c.loser_tenant_id
    join tenants s on s.id = c.survivor_tenant_id
   where c.status = 'declared'
     and (l.deleted_at is null or s.deleted_at is not null
          or l.type = 'platform' or s.type = 'platform'
          or c.survivor_tenant_id = c.loser_tenant_id);
  -- A carried kind outside 127's five is two registers disagreeing about what a check is.
  select count(*)::int into v_outside from customer_duplicate_claims c,
    unnest(c.carried_kinds) k
   where k not in ('national_id','tin','trade_licence','transport_licence','insurance');
  -- And a carried kind that has no line under it on the survivor is a claim that lied about the
  -- work it moved. This is the check the whole design is staked on, so it is made here, not
  -- assumed: the row the claim promised to raise either exists, or has been answered since.
  select count(*)::int into v_lost_carry from customer_duplicate_claims c,
    unnest(c.carried_kinds) k
   where not exists (select 1 from customer_verifications v
                      where v.company_tenant_id = c.survivor_tenant_id
                        and v.kind = k
                        and v.raised_at >= c.raised_at - interval '10 seconds');

  select count(distinct rp.role_id)::int into v_mergers from role_permissions rp
    join roles r on r.id = rp.role_id
   where rp.permission_key = 'control.customers.merge' and r.tenant_id is null;
  select count(distinct rp.role_id)::int into v_cutters from role_permissions rp
    join roles r on r.id = rp.role_id
   where rp.permission_key = 'control.customers.disconnect' and r.tenant_id is null;

  select t.id into v_live_tenant from tenants t
    where t.type <> 'platform' and t.deleted_at is null
    order by t.created_at limit 1;
  select t.id into v_closed_tenant from tenants t
    where t.type <> 'platform' and t.deleted_at is not null
    order by t.created_at desc limit 1;

  -- The doors have to run, not merely exist: 061 shipped a definer that 500'd on every call while
  -- the whole suite printed green, and a text grep is not evidence.
  begin
    if v_live_tenant is not null then
      -- The access read, on a real account. `sessions` is a list, so its length is the proof.
      select jsonb_array_length(coalesce(platform_auth.customer_access(v_live_tenant) -> 'sessions',
                                         '[]'::jsonb)) into v_seen;
      -- A preview aimed at nothing must still answer rather than raise: the desk calls it while
      -- the clerk is still deciding which half of the pair is which.
      select platform_auth.duplicate_preview(v_live_tenant, v_live_tenant) into v_answer;
      if v_answer ->> 'status' <> 'ok' or v_answer ->> 'eligible' <> 'false' then
        raise exception '128: a preview of one account against itself was not refused in words';
      end if;
    end if;
    -- The cut-off's refusal paths are executed on purpose — against the office's own tenant and
    -- against a closed account — because a cut-off that answers `ok` for either is the guard
    -- broken, and because this is the only way to run the body without taking a live person's
    -- session away inside a migration. Nothing past these two calls touches a row.
    v_answer := null;
    select platform_auth.customer_force_logout(t.id) into v_answer
      from tenants t where t.type = 'platform' order by t.created_at limit 1;    if v_answer is not null and v_answer ->> 'status' <> 'invalid' then
      raise exception '128: customer_force_logout would cut off the office''s own tenant';
    end if;
    if v_closed_tenant is not null then
      select platform_auth.customer_force_logout(v_closed_tenant) into v_answer;
      if v_answer ->> 'status' <> 'invalid' then
        raise exception '128: customer_force_logout answered % for the closed account % — the '
          'tombstone guard is not holding', v_answer ->> 'status', v_closed_tenant::text;
      end if;
    end if;
    -- A claim cannot be raised in a migration — it writes a register row and a note — but the
    -- definer's own guard answers before any write, so the impossible pair proves the body parses
    -- and refuses. `p_register` here is a company, not the office, which is the first refusal.
    if v_live_tenant is not null then
      select platform_auth.claim_duplicate(v_live_tenant, v_live_tenant, v_live_tenant,
                                           'the migration is proving the register guard refuses',
                                           v_live_tenant) into v_answer;
      if v_answer ->> 'status' <> 'invalid' then
        raise exception '128: claim_duplicate wrote something it should have refused: %',
          v_answer ->> 'status';
      end if;
      select platform_auth.void_duplicate_claim(v_live_tenant, v_live_tenant,
        'the migration is proving the register guard refuses', v_live_tenant) into v_answer;
      if v_answer ->> 'status' = 'ok' then
        raise exception '128: void_duplicate_claim voided a claim that does not exist';
      end if;
    end if;
  exception when others then
    raise exception '128: a part-B door failed on a live account — %', sqlerrm;
  end;

  if v_bad > 0 then
    raise exception '128: % standing claim(s) name a pair the guard must have refused', v_bad;
  end if;
  if v_outside > 0 then
    raise exception '128: % claim(s) carried a kind outside 127''s vocabulary', v_outside;
  end if;
  if v_lost_carry > 0 then
    raise exception '128: % claim(s) promised to carry a check the survivor does not have',
      v_lost_carry;
  end if;

  raise notice '128: the claim and the cut-off are live — % claim(s), % standing, % withdrawn, '
    '% role(s) may claim a duplicate, % may cut a seat off, % live session(s) read on a real '
    'account, and the office/closed-account refusals both held.',
    v_claims, v_live, v_voided, v_mergers, v_cutters, coalesce(v_seen, 0);
end $$;

commit;
