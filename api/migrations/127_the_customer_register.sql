-- 127 — the customer register: who this account is, what the office has checked, what it is
-- willing to say about it, and what all of that is worth right now (task #342).
--
-- The spec's Customers module asks for six things. The recon says two already ship and four do
-- not, so this migration adds the four and leaves the two alone:
--
--   the ban            already ships — 078's `tenant_actions` and 121's two-seat signature. The
--                      office blocks, unblocks, closes and notifies from `/control/tenants`.
--                      Nothing here re-does it, and no act in this file can shut an account out.
--   the exit           already ships — 086's `subscription_cancellations`, the churn register.
--   the KYC queue      HERE. `customer_verifications`: one line per account per checked thing,
--                      and the answer carries its evidence or the table refuses the row.
--   the notes          HERE. `customer_notes` — what the office says about an account, kept and
--                      withdrawn rather than rewritten.
--   the tags           HERE. `customer_tags` + `customer_taggings`, the same pair 125 built for
--                      the inbox, because "everything labelled duplicate-kyc" is a queue a clerk
--                      can act on and a free-text field is not.
--   the trust score    HERE, and *computed* — `platform_auth.customer_trust` works the number out
--                      of the registers at the moment of the read. No column stores it.
--   the timeline       HERE, and *assembled* — `platform_auth.customer_timeline` reads the trail
--                      that already exists (the action register, the calls, the papers, the
--                      checks, the notes, the exits, the office's own audit writes). A second
--                      copy of an activity trail is a second trail that can disagree with it.
--
-- Three decisions worth stating before anybody tries to change them:
--
-- 1. **The register is platform-owned, exactly as 101's and 126's are.** `tenant_id` is the
--    office's own tenant; the account the line is about sits beside it in `company_tenant_id`.
--    That is not tidiness: an RLS policy on `tenant_id` is what keeps a company's own seats from
--    reading the office's private note about them, and that note is a column of this register.
-- 2. **A checked thing is an identity number, so it is stored as the platform stores every
--    identity number** — `reference_encrypted` (AES-256-GCM through `encryptField`) plus a
--    four-character `reference_tail` the desk can show without a decision about who may see it.
--    No board, dossier or export in this file returns the whole value; the reveal is a route of
--    its own, gated on the verifying duty, rate limited, and audited as it happens.
-- 3. **A decision is terminal.** `approved`, `rejected` and `needs_more` freeze the line — the
--    guard is a trigger, not a convention — because a register whose verdict can be edited in
--    place cannot answer "what did you tell them last time". Re-checking an account opens a
--    *new* line, and the one that stands for a kind is the newest. The partial unique index
--    below keeps exactly one open line per account per kind, so the queue cannot grow two
--    waiting columns for the same licence.
--
-- What this deliberately does not do, said rather than left to be found:
--
--   * **It sends nothing.** Telling the account is 078's notice act, which the office already
--     runs from the tenants desk; a refusal's sentence is written here and is the words that
--     notice carries. A second delivery channel inside the KYC queue would put the same promise
--     in two places with two failure modes.
--   * **It uploads no paper.** A check points at the account's own filed document and the guard
--     insists the paper belongs to that account. Opening the PDF is the tenant desk's, or a
--     support session's, job.
--   * **It gates nothing on the score.** No route, timer or policy in the platform reads
--     `customer_trust` to decide an outcome. It is a number shown to a human with every factor
--     beside it, and the desk says so in the same words as this header.
begin;

-- ============================================================
-- 1. the check: one thing the office has looked at, and what it concluded
-- ============================================================

-- The five things the office checks, as one closed vocabulary. `national_id` is the NIDA card and
-- `tin` the TRA number; the three licences are the papers that carry an expiry. A kind that is
-- not on this list is not a check, and a desk that can write free text into a column the queue
-- counts on gets a queue with five spellings of the same licence in it.
--
-- One author per side, as 117 left the paper kinds: `api/src/customers/checks.ts` is what the
-- routes use, `web/app/control/customers/checks.ts` is what the desk prints, and
-- `smoke-customers.ts` reads this CHECK out of `pg_constraint` and insists all three agree.
create table if not exists customer_verifications (
  id uuid primary key default gen_random_uuid(),
  -- The office's register, as in 101 and 126. Never the account's own tenant.
  tenant_id uuid not null references tenants(id),
  -- The account this line is about: a transporter, a shipper or a seeker. Never the office itself.
  company_tenant_id uuid not null references tenants(id),
  kind text not null check (kind in (
    'national_id','tin','trade_licence','transport_licence','insurance')),
  status text not null default 'awaiting' check (status in (
    'awaiting','submitted','rejected','approved','needs_more')),
  -- The number as read off the paper, encrypted, and the tail the desk shows. The pair is kept
  -- whole by a CHECK; an approval that cannot say which number it read is an opinion.
  reference_encrypted bytea,
  reference_tail text check (reference_tail is null
                             or char_length(reference_tail) between 1 and 4),
  -- Only the kinds that lapse may carry a day, so "expired" is one test across the register
  -- rather than a date column that means different things on different rows.
  expires_on date,
  -- The office's sentence, in full, whenever it said no or asked for more. 8 characters is
  -- 078's floor for the note a company is sent, for the same reason: below that it is a status.
  reason text,
  -- The paper this line was read from, in the account's own vault. Not required: a TIN can be
  -- confirmed on a phone call and said so in the reason. But if a line names a paper, that paper
  -- has to belong to the account this line is about — the guard below, not a convention.
  document_id uuid references documents(id) on delete set null,
  raised_by uuid not null references users(id),
  raised_at timestamptz not null default now(),
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check ((reference_encrypted is null) = (reference_tail is null)),
  check (expires_on is null
         or kind in ('trade_licence','transport_licence','insurance')),
  check (reason is null or char_length(trim(reason)) between 8 and 600),
  -- A line that claims to be an answer names the seat and the moment it was answered.
  check (status not in ('rejected','needs_more','approved')
         or (decided_by is not null and decided_at is not null)),
  check (status <> 'approved'
         or (reference_encrypted is not null and reference_tail is not null)),
  check (status <> 'approved' or kind not in ('trade_licence','transport_licence','insurance')
         or expires_on is not null),
  check (status not in ('rejected','needs_more')
         or char_length(trim(coalesce(reason, ''))) >= 8),
  check (decided_at is null or decided_at >= raised_at),
  -- The two open states have not been answered, so they may not hold an answer's fields.
  check (status in ('rejected','needs_more','approved')
         or (decided_by is null and decided_at is null and reason is null))
);

-- One open line per account per kind. A decided line stays as history, so the queue cannot grow
-- two waiting columns while the second answer of the same licence sits in the same table.
create unique index customer_verifications_open_line_per_kind
  on customer_verifications (company_tenant_id, kind)
  where status in ('awaiting','submitted');
create index customer_verifications_account
  on customer_verifications (company_tenant_id, kind, raised_at desc);
-- The queue the desk opens first: everything the office still owes a decision on.
create index customer_verifications_waiting on customer_verifications (tenant_id, raised_at)
  where status in ('awaiting','submitted');

drop trigger if exists trg_customer_verifications_updated on customer_verifications;
create trigger trg_customer_verifications_updated before update on customer_verifications
  for each row execute function public.set_updated_at();

alter table customer_verifications enable row level security;
create policy customer_verifications_tenant on customer_verifications for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Written, decided, and never deleted. A withdrawn check is a new line with a reason, not a row
-- that stops existing.
grant select, insert, update on customer_verifications to app_runtime;
revoke all on customer_verifications from public, anon, authenticated, service_role;

comment on column customer_verifications.reference_encrypted is
  'The number as read off the paper, encrypted. No read in the platform returns it whole; only the reveal route decrypts, and it audits.';
comment on column customer_verifications.status is
  'awaiting/submitted are open lines; rejected/approved/needs_more are terminal and frozen by a trigger.';

-- An answer cannot be edited into a different answer, and a line cannot be moved onto a different
-- account or a different kind after the fact.
--
-- This is the whole of 127's immutability rule in one place. A route could check it; the next
-- route that writes a check line would not, which is why 126 put its paper guard in a trigger and
-- why this one does the same. The desk's answer to "the office changed its mind" is a new line —
-- and a new line is honest about there having been two.
create or replace function platform_auth.verification_answer_is_kept()
returns trigger language plpgsql set search_path = public as $$ begin
  if tg_op = 'INSERT' then return new; end if;

  if new.kind is distinct from old.kind then
    raise exception 'customer_verifications: a check line stays a % check — to check something '
      'else, raise a new one', old.kind using errcode = '23514';
  end if;
  if new.company_tenant_id is distinct from old.company_tenant_id then
    raise exception 'customer_verifications: a check cannot be moved onto another account; '
      'raise it against the account it is about' using errcode = '23514';
  end if;
  if new.raised_by is distinct from old.raised_by
     or new.raised_at is distinct from old.raised_at then
    raise exception 'customer_verifications: that line was raised by another hand at % — the '
      'raising is not editable', old.raised_at using errcode = '23514';
  end if;
  if old.status in ('rejected','needs_more','approved')
     and new.status is distinct from old.status then
    raise exception
      'customer_verifications: a % answer is kept. To check this account again, raise a new line',
      old.status using errcode = '23514';
  end if;
  -- The two open states may move between each other — paper arrives, paper goes back — but
  -- neither may pick up an answer's fields.
  if new.status in ('awaiting','submitted')
     and (new.decided_by is not null or new.decided_at is not null or new.reason is not null) then
    raise exception
      'customer_verifications: an open line cannot hold a decision''s evidence'
      using errcode = '23514';
  end if;
  -- A decided line keeps everything it was decided on. To correct the number, the expiry or the
  -- paper is to raise the check again — the same rule as the status, stated for the columns.
  if old.status in ('rejected','needs_more','approved')
     and (new.reference_encrypted is distinct from old.reference_encrypted
          or new.reference_tail is distinct from old.reference_tail
          or new.expires_on is distinct from old.expires_on
          or new.document_id is distinct from old.document_id
          or new.reason is distinct from old.reason
          or new.decided_by is distinct from old.decided_by
          or new.decided_at is distinct from old.decided_at) then
    raise exception 'customer_verifications: % was answered at % and its evidence is kept',
      old.id::text, old.decided_at using errcode = '23514';
  end if;
  return new;
end $$;

create trigger customer_verification_answer_is_kept
  before update on customer_verifications
  for each row execute function platform_auth.verification_answer_is_kept();

-- The line is about an account, and the paper it names is that account's own.
--
-- Both halves belong in the table because both are the kind of thing a later handler gets wrong
-- while meaning well: a check raised against the office's own tenant, or pointed at another
-- company's filed licence. The office tenant is a `platform` account, so one test catches both —
-- and it is the sentence 078's definer already uses for the same reason.
create or replace function platform_auth.verification_names_its_account()
returns trigger language plpgsql set search_path = public as $$ declare
  v_type text;
  v_deleted timestamptz;
  v_doc_entity text;
  v_doc_tenant uuid;
  v_doc_deleted timestamptz;
begin
  select t.type, t.deleted_at into v_type, v_deleted from tenants t where t.id = new.company_tenant_id;
  if v_type is null then
    raise exception 'customer_verifications: no account %', new.company_tenant_id::text
      using errcode = '23503';
  end if;
  if v_type = 'platform' then
    raise exception 'customer_verifications: the office does not verify itself — only an account '
      'on the platform can be checked' using errcode = '23514';
  end if;
  if v_deleted is not null then
    raise exception 'customer_verifications: % is closed and cannot be checked; a closed account '
      'is answered by 078, not by this register', new.company_tenant_id::text
      using errcode = '23514';
  end if;

  if new.document_id is not null then
    select d.entity_type, d.tenant_id, d.deleted_at
      into v_doc_entity, v_doc_tenant, v_doc_deleted
      from documents d where d.id = new.document_id;
    if v_doc_tenant is null then
      raise exception 'customer_verifications: no paper % on the vault', new.document_id::text
        using errcode = '23503';
    end if;
    if v_doc_entity <> 'tenant' then
      raise exception 'customer_verifications: % is paper filed against a %, not against an '
        'account', new.document_id::text, v_doc_entity using errcode = '23514';
    end if;
    if v_doc_tenant <> new.company_tenant_id then
      raise exception 'customer_verifications: that paper belongs to another account; a check '
        'cannot be evidenced with someone else''s licence' using errcode = '23514';
    end if;
    if v_doc_deleted is not null then
      raise exception 'customer_verifications: that paper has been filed away and cannot carry a '
        'check' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger customer_verification_names_its_account
  before insert or update on customer_verifications
  for each row execute function platform_auth.verification_names_its_account();

-- ============================================================
-- 2. the note: what the office says about an account, in its own words
-- ============================================================

create table if not exists customer_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  company_tenant_id uuid not null references tenants(id),
  body text not null check (char_length(trim(body)) between 4 and 2000),
  author uuid not null references users(id),
  edited_at timestamptz,
  voided_at timestamptz,
  voided_by uuid references users(id),
  void_reason text check (void_reason is null
                          or char_length(trim(void_reason)) between 8 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (voided_at is null or voided_by is not null),
  check (voided_at is null or char_length(trim(coalesce(void_reason, ''))) >= 8),
  check (voided_by is null or voided_at is not null),
  check (edited_at is null or edited_at >= created_at)
);

create index customer_notes_account on customer_notes (company_tenant_id, created_at desc);
create index customer_notes_live on customer_notes (tenant_id, created_at desc)
  where voided_at is null;

drop trigger if exists trg_customer_notes_updated on customer_notes;
create trigger trg_customer_notes_updated before update on customer_notes
  for each row execute function public.set_updated_at();

alter table customer_notes enable row level security;
create policy customer_notes_tenant on customer_notes for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- No delete grant. A note that was wrong is withdrawn with a reason and stays on the file, which
-- is 119's rule for a voided docket applied to the office's own words.
grant select, insert, update on customer_notes to app_runtime;
revoke all on customer_notes from public, anon, authenticated, service_role;

-- An edit keeps its author, stamps itself, and cannot happen after a withdrawal.
create or replace function platform_auth.note_is_kept_not_rewritten()
returns trigger language plpgsql set search_path = public as $$ begin
  if new.author is distinct from old.author then
    raise exception 'customer_notes: a note keeps the hand that wrote it — to say something '
      'else, write another note' using errcode = '23514';
  end if;
  if new.company_tenant_id is distinct from old.company_tenant_id then
    raise exception 'customer_notes: a note cannot be moved onto another account'
      using errcode = '23514';
  end if;
  if old.voided_at is not null then
    if new.body is distinct from old.body then
      raise exception 'customer_notes: % is withdrawn and cannot be rewritten; its text is the '
        'thing the withdrawal was about', old.id::text using errcode = '23514';
    end if;
    if new.voided_at is distinct from old.voided_at
       or new.voided_by is distinct from old.voided_by
       or new.void_reason is distinct from old.void_reason then
      raise exception 'customer_notes: a withdrawal is not edited, it is disagreed with in a '
        'new note' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.voided_at is not null and new.voided_at < old.created_at then
    raise exception 'customer_notes: % cannot be withdrawn before it was written', old.id::text
      using errcode = '23514';
  end if;
  if new.body is distinct from old.body then
    -- Stamped, not typed: a desk that says "edited" without a time cannot say whether the edit
    -- came before or after the decision that relied on it.
    new.edited_at := now();
  end if;
  return new;
end $$;

create trigger customer_note_is_kept_not_rewritten
  before update on customer_notes
  for each row execute function platform_auth.note_is_kept_not_rewritten();

-- ============================================================
-- 3. the tags: a queue a clerk can act on, not a free-text field
-- ============================================================

create table if not exists customer_tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- Lowercase in the CHECK, as 125 learned: two tags that differ only in case are two tags that
  -- an office will spend an afternoon working out are the same one.
  name text not null check (name ~ '^[a-z0-9][a-z0-9 ._+-]{1,27}$'),
  colour text check (colour is null or colour ~ '^#[0-9a-fA-F]{6}$'),
  note text check (note is null or char_length(trim(note)) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users(id),
  updated_by uuid references users(id),
  deleted_at timestamptz,
  deleted_by uuid references users(id)
);
create unique index customer_tags_name_live on customer_tags (tenant_id, name)
  where deleted_at is null;
drop trigger if exists trg_customer_tags_updated on customer_tags;
create trigger trg_customer_tags_updated before update on customer_tags
  for each row execute function public.set_updated_at();

create table if not exists customer_taggings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  company_tenant_id uuid not null references tenants(id),
  tag_id uuid not null references customer_tags(id),
  applied_by uuid references users(id),
  applied_at timestamptz not null default now(),
  -- Retired, not deleted: "who had this labelled as a duplicate, and when did they take it off"
  -- is the question a label answers when something went wrong. One pair of columns, as 125's
  -- pair has — the partial unique index below and every read on this register work off
  -- `deleted_at`, so a second "withdrawn" flag would be a second answer nobody asks.
  deleted_at timestamptz,
  deleted_by uuid references users(id)
);
create unique index customer_taggings_live
  on customer_taggings (company_tenant_id, tag_id) where deleted_at is null;
create index customer_taggings_by_tag
  on customer_taggings (tag_id, applied_at desc) where deleted_at is null;

alter table customer_tags enable row level security;
create policy customer_tags_tenant on customer_tags for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on customer_tags to app_runtime;
revoke all on customer_tags from public, anon, authenticated, service_role;

alter table customer_taggings enable row level security;
create policy customer_taggings_tenant on customer_taggings for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on customer_taggings to app_runtime;
revoke all on customer_taggings from public, anon, authenticated, service_role;

-- A tagging has to name a live account and a live label belonging to this register, or the queue
-- filter shows a chip that opens nothing. 125's rule, for the same reason: the route could check
-- and the next route that writes a tagging would not.
create or replace function platform_auth.customer_tagging_names_a_live_pair()
returns trigger language plpgsql set search_path = public as $$ declare
  v_account_type text;
  v_account_deleted timestamptz;
  v_tag_tenant uuid;
  v_tag_deleted timestamptz;
begin
  if new.deleted_at is not null then return new; end if;

  select t.type, t.deleted_at into v_account_type, v_account_deleted
    from tenants t where t.id = new.company_tenant_id;
  if v_account_type is null then
    raise exception 'customer_taggings: no account %', new.company_tenant_id::text
      using errcode = '23503';
  end if;
  if v_account_type = 'platform' or v_account_deleted is not null then
    raise exception 'customer_taggings: % is not a live account and cannot carry a label',
      new.company_tenant_id::text using errcode = '23514';
  end if;

  select g.tenant_id, g.deleted_at into v_tag_tenant, v_tag_deleted
    from customer_tags g where g.id = new.tag_id;
  if v_tag_tenant is null then
    raise exception 'customer_taggings: no label % on the library', new.tag_id::text
      using errcode = '23503';
  end if;
  if v_tag_tenant <> new.tenant_id then
    raise exception 'customer_taggings: that label belongs to another register'
      using errcode = '23514';
  end if;
  if v_tag_deleted is not null then
    raise exception 'customer_taggings: % is a withdrawn label and cannot be put back on an '
      'account', new.tag_id::text using errcode = '23514';
  end if;
  return new;
end $$;

create trigger customer_tagging_names_a_live_pair
  before insert or update on customer_taggings
  for each row execute function platform_auth.customer_tagging_names_a_live_pair();

-- ============================================================
-- 4. the trust read: worked out now, from these registers, never stored
-- ============================================================
--
-- The spec asks for a trust score. The one thing a stored score cannot do is stay true: it is
-- 127's checks, 078's blocks and 001's licence date read together, and any of the three can move
-- while a written-down number sits where it was. So there is no column. There is one function,
-- and every desk that shows the number shows the factors beside it.
--
-- The base is 50 — an account is neither trusted nor distrusted until something is known — and
-- each factor is an operational fact out of a register the office already keeps. Nothing the
-- office is at fault for is charged to the account: a late answer on one of its calls, or a
-- dispute it raised against the platform, moves no points here, so neither appears.
--
-- One statement, deliberately: the board reads this once per row of a page, and a plpgsql body
-- that runs six queries per call would turn a 25-row queue into a hundred and fifty.
create or replace function platform_auth.customer_trust(p_company uuid)
returns jsonb language sql security definer set search_path = public as $$
  with latest as (
    select distinct on (c.company_tenant_id, c.kind)
           c.company_tenant_id, c.kind, c.status, c.expires_on
      from customer_verifications c
     where c.company_tenant_id = p_company
     order by c.company_tenant_id, c.kind, c.raised_at desc, c.id
  ),
  fact as (
    select coalesce(count(*) filter (where l.status = 'approved'), 0)::int as approved,
           coalesce(count(*) filter (where l.status in ('awaiting','submitted')), 0)::int as open,
           coalesce(count(*) filter (where l.status in ('rejected','needs_more')), 0)::int as refused,
           coalesce(count(*) filter (where l.status = 'approved' and l.expires_on is not null
                                        and l.expires_on < current_date), 0)::int as expired,
           coalesce(count(*)::int, 0) as lines
      from latest l
  ),
  acc as (
    select t.id, t.name, t.type, t.status, t.created_at, t.licence_expires_at, t.deleted_at,
           (select count(*)::int from tenant_actions a
             where a.tenant_id = t.id and a.action = 'block'
               and a.created_at > now() - interval '365 days') as blocks,
           (select count(*)::int from users u
             where u.tenant_id = t.id and u.deleted_at is null and u.status = 'active') as seats
      from tenants t
     where t.id = p_company and t.type <> 'platform'
  ),
  pts as (
    select 1 as ord, 'checked and approved' as label, least(30, f.approved * 10) as points,
           f.approved::text || ' of the five things the office checks' as detail
      from fact f where f.approved > 0
    union all
    select 2, 'refused or sent back', -least(24, f.refused * 12),
           f.refused::text || ' line(s) the office answered no, or asked for more'
      from fact f where f.refused > 0
    union all
    select 3, 'paper past its day', -20,
           f.expired::text || ' approved check(s) whose expiry has gone'
      from fact f where f.expired > 0
    union all
    select 4, 'blocked this year', -least(25, a.blocks * 10),
           a.blocks::text || ' block(s) on 078''s register in the last 365 days'
      from acc a where a.blocks > 0
    union all
    select 5, 'platform licence lapsed', -12,
           to_char(a.licence_expires_at, 'YYYY-MM-DD') || ' has gone by'
      from acc a where a.licence_expires_at is not null and a.licence_expires_at < now()
    union all
    select 6, 'subscription ' || a.status, -8, 'the account is not paid up'
      from acc a where a.status in ('grace','expired')
    union all
    select 7, 'a year on the platform', 10,
           'opened ' || to_char(a.created_at, 'YYYY-MM-DD')
      from acc a where a.created_at < now() - interval '1 year'
    union all
    select 8, 'six months on the platform', 6,
           'opened ' || to_char(a.created_at, 'YYYY-MM-DD')
      from acc a where a.created_at >= now() - interval '1 year'
                   and a.created_at < now() - interval '180 days'
    union all
    select 9, 'staffed', 4, a.seats::text || ' live seat(s)'
      from acc a where a.seats >= 2
  ),
  tot as (select greatest(0, least(100, 50 + coalesce(sum(p.points), 0)))::int as score from pts p),
  fac as (select coalesce(jsonb_agg(json_build_object('label', p.label, 'points', p.points,
                       'detail', p.detail) order by p.ord), '[]'::jsonb) as factors from pts p)
  select case when (select count(*) from acc) = 0
    then jsonb_build_object('status', 'not_found', 'company_id', p_company)
    else jsonb_build_object(
      'status', 'ok',
      'company_id', (select id from acc),
      'name', (select name from acc),
      'account_status', (select status from acc),
      'score', (select score from tot),
      'band', case
        when (select deleted_at from acc) is not null then 'closed'
        when (select status from acc) = 'suspended' then 'held'
        when (select approved from fact) = 0 then 'unverified'
        when (select score from tot) >= 85 then 'strong'
        when (select score from tot) >= 70 then 'good'
        when (select score from tot) >= 55 then 'steady'
        else 'watched' end,
      'base', 50,
      'factors', (select factors from fac),
      'basis', (select jsonb_build_object(
                  'approved', f.approved, 'open', f.open, 'refused', f.refused,
                  'expired', f.expired, 'lines', f.lines) from fact f)
        || jsonb_build_object(
           'blocks_365d', (select blocks from acc), 'seats', (select seats from acc)),
      'clock', now())
    end;
$$;

-- ============================================================
-- 5. the queue: the board the desk opens first
-- ============================================================
--
-- The line that stands for a kind is the newest one — that is the rule 127's terminal answers
-- force — so the queue reads `latest` (one line per account per kind, newest first) and counts
-- over it. The same shape appears in the trust read; it is three lines and it is the only way to
-- ask "what does the office still owe a decision on" when an answer is kept forever.
create or replace function platform_auth.customer_board(
  p_register uuid,
  p_search text,
  p_tin_hash text,
  p_status text,
  p_kind text,
  p_limit int,
  p_offset int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_facets jsonb;
  v_total int := 0;
begin
  if p_limit is null or p_limit < 1 then p_limit := 25; end if;
  if p_limit > 100 then p_limit := 100; end if;
  if p_offset is null or p_offset < 0 then p_offset := 0; end if;

  -- The chips beside the list are counted over the whole register with only the account search
  -- applied, never over the status or kind the clerk has already chosen. A count taken after the
  -- filter is a board whose other choices always say nought.
  --
  -- Both counts, and the queue below them, exclude an account the office has closed: 078 owns the
  -- shut door, and a register that lists a closed transporter as "waiting on a check" is a queue
  -- of work that cannot be done. `customer_trust` still reads a closed account — it answers the
  -- band `closed` on purpose — but the board is a to-do list, and a closed account is off it.
  select jsonb_build_object(
    'accounts', (select count(*)::int from tenants t
                  where t.type in ('transporter','shipper','seeker')
                    and t.deleted_at is null
                    and (p_search is null or t.name ilike '%' || p_search || '%'
                         or t.email ilike '%' || p_search || '%')),
    'never_checked', (select count(*)::int from tenants t
                       where t.type in ('transporter','shipper','seeker')
                         and t.deleted_at is null
                         and not exists (select 1 from customer_verifications c
                                          where c.company_tenant_id = t.id)),
    'checks', (select jsonb_build_object(
                 'approved', coalesce(count(*) filter (where l.status = 'approved'), 0)::int,
                 'open', coalesce(count(*) filter (where l.status in ('awaiting','submitted')), 0)::int,
                 'refused', coalesce(count(*) filter (where l.status in ('rejected','needs_more')), 0)::int,
                 'expired', coalesce(count(*) filter (where l.status = 'approved'
                                    and l.expires_on is not null
                                    and l.expires_on < current_date), 0)::int)
                 from (select distinct on (c.company_tenant_id, c.kind) c.status, c.expires_on
                         from customer_verifications c
                         join tenants ct on ct.id = c.company_tenant_id
                        where ct.deleted_at is null
                        order by c.company_tenant_id, c.kind, c.raised_at desc, c.id) l))
    into v_facets;

  for v_row in
    with latest as (
      select distinct on (c.company_tenant_id, c.kind)
             c.company_tenant_id, c.kind, c.status, c.expires_on, c.raised_at
        from customer_verifications c
        join tenants ct on ct.id = c.company_tenant_id and ct.deleted_at is null
       order by c.company_tenant_id, c.kind, c.raised_at desc, c.id
    ),
    fact as (
      select l.company_tenant_id,
             coalesce(count(*) filter (where l.status = 'approved'), 0)::int as approved,
             coalesce(count(*) filter (where l.status in ('awaiting','submitted')), 0)::int as open,
             coalesce(count(*) filter (where l.status in ('rejected','needs_more')), 0)::int as refused,
             coalesce(count(*) filter (where l.status = 'approved' and l.expires_on is not null
                                          and l.expires_on < current_date), 0)::int as expired,
             coalesce(count(*)::int, 0) as lines
        from latest l group by l.company_tenant_id
    )
    select t.id, t.name, t.type, t.status, t.slug, t.created_at, t.trial_ends_at,
           t.licence_expires_at, t.seats_licensed,
           p.name as plan_name,
           coalesce(f.approved, 0) as approved, coalesce(f.open, 0) as open,
           coalesce(f.refused, 0) as refused, coalesce(f.expired, 0) as expired,
           coalesce(f.lines, 0) as lines,
           (select count(*)::int from users u
             where u.tenant_id = t.id and u.deleted_at is null and u.status = 'active') as seats,
           coalesce((select jsonb_agg(json_build_object('id', g.id, 'name', g.name,
                       'colour', g.colour) order by g.name)
              from customer_taggings tg
              join customer_tags g on g.id = tg.tag_id
             where tg.company_tenant_id = t.id and tg.deleted_at is null
               and g.deleted_at is null and tg.tenant_id = p_register), '[]'::jsonb) as tags,
           (select a.note from tenant_actions a
             where a.tenant_id = t.id and a.action = 'block'
             order by a.created_at desc limit 1) as blocked_note,
           (select n.body from customer_notes n
             where n.company_tenant_id = t.id and n.voided_at is null
               and n.tenant_id = p_register
             order by n.created_at desc limit 1) as last_note,
           count(*) over () as total
      from tenants t
      left join fact f on f.company_tenant_id = t.id
      left join plans p on p.id = t.plan_id
     where t.type in ('transporter','shipper','seeker')
       and t.deleted_at is null
       and (p_search is null or t.name ilike '%' || p_search || '%'
            or t.email ilike '%' || p_search || '%')
       and (p_tin_hash is null or t.tin_search = p_tin_hash)
       and (p_status is null
            or (p_status = 'waiting'  and coalesce(f.open, 0) > 0)
            or (p_status = 'refused'  and coalesce(f.refused, 0) > 0)
            or (p_status = 'expired'  and coalesce(f.expired, 0) > 0)
            or (p_status = 'clear'    and coalesce(f.open, 0) = 0
                                     and coalesce(f.refused, 0) = 0
                                     and coalesce(f.approved, 0) > 0)
            or (p_status = 'none'     and coalesce(f.lines, 0) = 0))
       and (p_kind is null or exists (
             select 1 from latest l
              where l.company_tenant_id = t.id and l.kind = p_kind
                and l.status in ('awaiting','submitted')))
     order by t.created_at desc, t.id
     limit p_limit offset p_offset
  loop
    v_items := v_items || jsonb_build_object(
      'company_tenant_id', v_row.id,
      'name', v_row.name, 'type', v_row.type, 'account_status', v_row.status,
      'slug', v_row.slug, 'created_at', v_row.created_at,
      'trial_ends_at', v_row.trial_ends_at, 'licence_expires_at', v_row.licence_expires_at,
      'plan_name', v_row.plan_name, 'seats_licensed', v_row.seats_licensed,
      'seats', v_row.seats,
      'checks', jsonb_build_object('lines', v_row.lines, 'approved', v_row.approved,
        'open', v_row.open, 'refused', v_row.refused, 'expired', v_row.expired),
      'tags', v_row.tags,
      'blocked_note', v_row.blocked_note, 'last_note', left(v_row.last_note, 180),
      'trust', platform_auth.customer_trust(v_row.id));
    v_total := coalesce(v_row.total, 0);
  end loop;

  return jsonb_build_object('status', 'ok', 'total', v_total, 'limit', p_limit,
    'offset', p_offset, 'rows', v_items, 'facets', coalesce(v_facets, '{}'::jsonb),
    'clock', now());
end $$;

-- ============================================================
-- 6. the dossier: one account, everything this register knows
-- ============================================================

create or replace function platform_auth.customer_dossier(p_register uuid, p_company uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v jsonb;
begin
  select jsonb_build_object(
      'status', 'ok',
      'company', jsonb_build_object(
        'id', t.id, 'name', t.name, 'type', t.type, 'account_status', t.status,
        'slug', t.slug, 'email', t.email, 'phone_on_file', t.phone_encrypted is not null,
        'tin_on_file', t.tin_search is not null,
        'created_at', t.created_at, 'trial_ends_at', t.trial_ends_at,
        'licence_expires_at', t.licence_expires_at, 'deleted_at', t.deleted_at,
        'seats_licensed', t.seats_licensed, 'plan_name', p.name),
      'profile', (select jsonb_build_object('company_name', c.company_name,
                     'tin_display', c.tin_display, 'brela_number', c.brela_number,
                     'vat_number', c.vat_number, 'transport_licence_no', c.transport_licence_no,
                     'transport_licence_expiry', c.transport_licence_expiry,
                     'fleet_size_declared', c.fleet_size_declared, 'website', c.website)
                    from company_profiles c where c.tenant_id = t.id),
      -- What the account itself has filed with an authority, as its own words rather than the
      -- office's verdict on them. The desk shows this beside the checks precisely because the
      -- two can disagree, and a clerk needs to see that before answering.
      'licences', coalesce((select jsonb_agg(json_build_object('authority', l.authority,
              'title', l.title, 'licence_number', l.licence_number, 'expiry_date', l.expiry_date)
            order by l.expiry_date)
            from regulatory_licences l
           where l.tenant_id = t.id and l.deleted_at is null), '[]'::jsonb),
      'seats', jsonb_build_object(
        'live', (select count(*)::int from users u where u.tenant_id = t.id
                   and u.deleted_at is null and u.status = 'active'),
        'pending', (select count(*)::int from users u where u.tenant_id = t.id
                      and u.deleted_at is null and u.status = 'pending_verification'),
        'last_login', (select max(u.last_login_at) from users u where u.tenant_id = t.id
                         and u.deleted_at is null),
        'sessions_live', (select count(*)::int from sessions s where s.tenant_id = t.id
                            and s.revoked_at is null)),
      'actions', coalesce((select jsonb_agg(json_build_object('action', a.action,
              'reason_code', a.reason_code, 'note', a.note, 'created_at', a.created_at,
              'actor_kind', a.actor_kind) order by a.created_at desc)
            from (select x.action, x.reason_code, x.note, x.created_at, x.actor_kind
                    from tenant_actions x where x.tenant_id = t.id
                   order by x.created_at desc limit 8) a), '[]'::jsonb),
      'exit', (select jsonb_build_object('reason_code', x.reason_code, 'note', x.note,
                 'created_at', x.created_at)
                 from subscription_cancellations x where x.tenant_id = t.id
                order by x.created_at desc limit 1),
      'calls', jsonb_build_object(
        'open', (select count(*)::int from support_tickets s
                  where s.company_tenant_id = t.id and s.deleted_at is null
                    and s.status in ('open','allocated','in_progress')),
        'all', (select count(*)::int from support_tickets s
                 where s.company_tenant_id = t.id and s.deleted_at is null),
        'disputes', (select count(*)::int from service_disputes d
                      where d.company_tenant_id = t.id and d.deleted_at is null
                        and d.status in ('open','investigating')),
        'papers', (select count(*)::int from service_refund_requests r
                    where r.company_tenant_id = t.id)),
      'checks', coalesce((select jsonb_agg(json_build_object(
              'id', c.id, 'kind', c.kind, 'status', c.status,
              'reference_tail', c.reference_tail, 'expires_on', c.expires_on,
              'reason', c.reason, 'document_id', c.document_id,
              'raised_at', c.raised_at, 'raised_name', ru.full_name,
              'decided_at', c.decided_at, 'decided_name', du.full_name,
              'has_reference', c.reference_encrypted is not null,
              'is_current', c.id = cur.id) order by c.raised_at desc)
            from customer_verifications c
            left join lateral (
              select c2.id from customer_verifications c2
               where c2.company_tenant_id = c.company_tenant_id and c2.kind = c.kind
              order by c2.raised_at desc, c2.id limit 1
            ) cur on true
            left join users ru on ru.id = c.raised_by
            left join users du on du.id = c.decided_by
           where c.company_tenant_id = t.id), '[]'::jsonb),
      'notes', coalesce((select jsonb_agg(json_build_object(
              'id', n.id, 'body', n.body, 'author_name', u.full_name,
              'created_at', n.created_at, 'edited_at', n.edited_at,
              'voided_at', n.voided_at, 'voided_by_name', vu.full_name,
              'void_reason', n.void_reason)
            order by (n.voided_at is not null), n.created_at desc)
            from customer_notes n
            left join users u on u.id = n.author
            left join users vu on vu.id = n.voided_by
           where n.company_tenant_id = t.id and n.tenant_id = p_register), '[]'::jsonb),
      'tags', coalesce((select jsonb_agg(json_build_object(
              -- Both ids: the desk retires a pairing by the label's own id, which is what
              -- /:id/tags/retire takes, so a dossier that carried only the tagging row would
              -- render a "take it off" button with nothing to send.
              'id', g.id, 'tagging_id', tg.id, 'name', g.name, 'colour', g.colour,
              'applied_at', tg.applied_at, 'applied_by_name', u.full_name)
            order by g.name)
            from customer_taggings tg
            join customer_tags g on g.id = tg.tag_id
            left join users u on u.id = tg.applied_by
           where tg.company_tenant_id = t.id and tg.deleted_at is null
             and g.deleted_at is null and tg.tenant_id = p_register), '[]'::jsonb),
      'paper', coalesce((select jsonb_agg(json_build_object('id', d.id, 'kind', d.kind,
              'file_name', d.file_name, 'mime_type', d.mime_type, 'size_bytes', d.size_bytes,
              'created_at', d.created_at) order by d.created_at desc)
            from documents d
           where d.entity_type = 'tenant' and d.entity_id = t.id
             and d.deleted_at is null), '[]'::jsonb),
      'trust', platform_auth.customer_trust(t.id),
      'clock', now())
    into v
    from tenants t
    left join plans p on p.id = t.plan_id
   where t.id = p_company;

  if v is null then
    return jsonb_build_object('status', 'not_found', 'company_id', p_company);
  end if;
  return v;
end $$;

-- ============================================================
-- 7. the timeline: the trail the platform already keeps, read as one story
-- ============================================================
--
-- No table here. The office's writes are in `audit_logs` (append-only by 001's own trigger), the
-- bans in 078's register, the calls in 101, the papers in 126, the checks and the notes in 127,
-- the exit in 086. A screen that shows them one under the other needs no new register — and a
-- copy of an activity trail is a second trail that can disagree with the first, which is the one
-- thing a desk looking back over an account cannot be left with.
--
-- The office's own writes are the bulk of `audit_logs` for a busy company: a hundred cargo edits
-- would bury the block, the refusal and the exit. So the audit source names the actions that
-- concern the account *as a customer* and nothing else, and 078's register is read instead of
-- the audit copy of the same act so the reason and the note come through.
create or replace function platform_auth.customer_timeline(
  p_company uuid, p_kind text, p_limit int)
returns jsonb language sql security definer set search_path = public as $$
  with lines as (
    select t.created_at as ts, 'account'::text as source, 'Account opened'::text as title,
           coalesce(p.name, 'no plan recorded') as detail, null::text as ref, null::text as actor
      from tenants t left join plans p on p.id = t.plan_id
     where t.id = p_company and t.type <> 'platform'
    union all
    select t.trial_ends_at, 'account', 'Trial ends',
           'The trial the account was opened on runs out here.', null, null
      from tenants t where t.id = p_company and t.trial_ends_at is not null
    union all
    select t.licence_expires_at, 'account', 'Platform licence runs out',
           'The office''s licence for this account ends here.', null, null
      from tenants t where t.id = p_company and t.licence_expires_at is not null
    union all
    select t.deleted_at, 'account', 'Account closed',
           'Tombstoned on 078''s register.', null,
           (select u.full_name from users u where u.id = t.updated_by)
      from tenants t where t.id = p_company and t.deleted_at is not null

    union all
    select a.created_at, 'decision',
           case a.action when 'block' then 'Access blocked'
                         when 'unblock' then 'Access restored'
                         when 'close' then 'Account closed'
                         else 'Noticed' end,
           a.note, null, coalesce(a.actor_role, a.actor_kind)
      from tenant_actions a where a.tenant_id = p_company

    union all
    select c.raised_at, 'verification',
           case c.kind when 'national_id' then 'National ID'
                       when 'tin' then 'TIN'
                       when 'trade_licence' then 'Trade licence'
                       when 'transport_licence' then 'Transport licence'
                       else 'Insurance' end || ' — check raised',
           case c.status when 'awaiting' then 'Waiting on the account.'
                         else 'Paper on the desk, waiting on the office.' end
             || case when c.expires_on is not null
                     then ' Expires ' || to_char(c.expires_on, 'YYYY-MM-DD') else '' end
             || case when c.reference_tail is not null
                     then ' · read as ending ' || c.reference_tail else '' end,
           null, (select u.full_name from users u where u.id = c.raised_by)
      from customer_verifications c where c.company_tenant_id = p_company
    union all
    select c.decided_at, 'verification',
           case c.kind when 'national_id' then 'National ID' when 'tin' then 'TIN'
                       when 'trade_licence' then 'Trade licence'
                       when 'transport_licence' then 'Transport licence' else 'Insurance' end
             || case c.status when 'approved' then ' approved'
                              when 'rejected' then ' refused'
                              else ' — more information asked' end,
           coalesce(c.reason, 'Confirmed against the paper on file.'
             || case when c.expires_on is not null
                     then ' Valid to ' || to_char(c.expires_on, 'YYYY-MM-DD') || '.' else '' end),
           null, (select u.full_name from users u where u.id = c.decided_by)
      from customer_verifications c
     where c.company_tenant_id = p_company and c.decided_at is not null

    union all
    select n.created_at, 'note', 'Note written', left(n.body, 260), null,
           (select u.full_name from users u where u.id = n.author)
      from customer_notes n where n.company_tenant_id = p_company
    union all
    select n.edited_at, 'note', 'Note edited', left(n.body, 260), null,
           (select u.full_name from users u where u.id = n.author)
      from customer_notes n
     where n.company_tenant_id = p_company and n.edited_at is not null
    union all
    select n.voided_at, 'note', 'Note withdrawn',
           coalesce(n.void_reason, left(n.body, 260)), null,
           (select u.full_name from users u where u.id = n.voided_by)
      from customer_notes n
     where n.company_tenant_id = p_company and n.voided_at is not null

    union all
    select tg.applied_at, 'tag', 'Labelled ' || g.name, coalesce(g.note, ''), null,
           (select u.full_name from users u where u.id = tg.applied_by)
      from customer_taggings tg join customer_tags g on g.id = tg.tag_id
     where tg.company_tenant_id = p_company and tg.deleted_at is null
    union all
    select tg.deleted_at, 'tag', 'Label off ' || g.name,
           'Worn since ' || to_char(tg.applied_at, 'YYYY-MM-DD') ||
             coalesce(' — ' || g.note, ''), null,
           (select u.full_name from users u where u.id = tg.deleted_by)
      from customer_taggings tg join customer_tags g on g.id = tg.tag_id
     where tg.company_tenant_id = p_company and tg.deleted_at is not null

    union all
    select s.ts, 'call', s.ref || ' — ' || s.subject,
           s.status || coalesce(' · ' || s.dept_ref, ''), s.ref, s.reporter_name
      from support_tickets s
     where s.company_tenant_id = p_company and s.deleted_at is null
    union all
    select s.resolved_at, 'call', s.ref || ' resolved',
           left(coalesce(s.resolution, ''), 260), s.ref,
           (select u.full_name from users u where u.id = s.resolved_by)
      from support_tickets s
     where s.company_tenant_id = p_company and s.resolved_at is not null

    union all
    select d.opened_at, 'service', d.ref || ' — a dispute on ' || d.ticket_ref,
           left(d.claim, 200), d.ref, (select u.full_name from users u where u.id = d.opened_by)
      from service_disputes d
     where d.company_tenant_id = p_company and d.deleted_at is null
    union all
    select d.decided_at, 'service', d.ref || ' ' || d.status,
           left(coalesce(d.outcome, ''), 260), d.ref,
           (select u.full_name from users u where u.id = d.decided_by)
      from service_disputes d
     where d.company_tenant_id = p_company and d.decided_at is not null
    union all
    select r.raised_at, 'service', r.ref || ' — refund asked',
           trim(to_char(r.amount, '999999990.00')) || ' ' || r.currency, r.ref,
           (select u.full_name from users u where u.id = r.raised_by)
      from service_refund_requests r where r.company_tenant_id = p_company
    union all
    select r.released_at, 'service', r.ref || ' released on a second seat',
           trim(to_char(r.amount, '999999990.00')) || ' ' || r.currency, r.ref,
           (select u.full_name from users u where u.id = r.released_by)
      from service_refund_requests r
     where r.company_tenant_id = p_company and r.released_at is not null

    union all
    select x.created_at, 'exit', 'Subscription cancelled',
           x.note || ' (' || x.reason_code || ')', null, coalesce(x.actor_role, '')
      from subscription_cancellations x where x.tenant_id = p_company

    union all
    select l.ts, 'office', l.action,
           left(coalesce(l.after ->> 'note', l.after ->> 'reason', l.after ->> 'message',
                         l.after ->> 'status', ''), 260),
           null, coalesce(l.actor_role, '')
      from audit_logs l
     where l.tenant_id = p_company
       and (l.action like 'auth.%'
            or l.action in ('signup.initiated','account.verified','password.reset',
                            'session.revoked','staff.invite_accepted','licence.trial.started')
            or l.entity in ('subscriptions','company_profiles'))
  )
  select jsonb_build_object(
    'status', 'ok',
    'company_id', p_company,
    'rows', coalesce(jsonb_agg(json_build_object('ts', y.ts, 'source', y.source,
              'title', y.title, 'detail', y.detail, 'ref', y.ref, 'actor', y.actor)
            order by y.ts desc), '[]'::jsonb),
    'clock', now())
    from (select ts, source, title, detail, ref, actor
            from lines
           where (p_kind is null or source = p_kind) and ts is not null
           order by ts desc
           limit greatest(1, least(coalesce(p_limit, 80), 300))) y;
$$;

-- ============================================================
-- 8. duties, and who is allowed to hold them
-- ============================================================
--
-- `control.customers.view` reads the register — an analyst asked "who is on this platform" needs
-- the queue and the numbers without the authority to answer any of it.
-- `control.customers.verify` decides a check line. It is a separate key from manage on purpose:
-- the seat that can label and annotate an account is not thereby able to certify its identity
-- papers, and a compliance desk that answers KYC need not be able to rewrite the office's notes.
-- `control.customers.manage` writes the notes, the labels and the open lines.
--
-- The reveal of a whole identity number costs `verify` as well: the duty that answers a check is
-- the duty allowed to read the number it was answered from, and no further key is invented for it.
insert into permissions (key, description) values
  ('control.customers.view',
   'Control - Read the customer register: the queue, the trust read and the timeline'),
  ('control.customers.verify',
   'Control - Answer a check: approve, refuse or ask for more, and reveal the number it was read from'),
  ('control.customers.manage',
   'Control - Open a check, write and withdraw a note, and label an account')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.customers.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','customer_service_agent','compliance_officer',
                 'support_engineer','platform_analyst','billing_admin')
on conflict do nothing;

-- The compliance desk answers KYC and, apart from the office's own super seat, nothing else does.
-- An agent who takes the call that says "my licence has expired" can raise the line and write the
-- note; whether the paper is good is the compliance seat's call.
insert into role_permissions (role_id, permission_key)
select r.id, 'control.customers.verify'
  from roles r
 where r.tenant_id is null and r.key in ('super_admin','compliance_officer')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.customers.manage'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','compliance_officer','customer_service_agent')
on conflict do nothing;

-- ============================================================
-- 9. grants on the doors
-- ============================================================

-- A trigger body is fired, never called: the owner alone holds these (110, 121, 125, 126).
revoke all on function
  platform_auth.verification_answer_is_kept(),
  platform_auth.verification_names_its_account(),
  platform_auth.note_is_kept_not_rewritten(),
  platform_auth.customer_tagging_names_a_live_pair()
from public, anon, authenticated, app_runtime;

grant execute on function
  platform_auth.customer_trust(uuid),
  platform_auth.customer_board(uuid, text, text, text, text, int, int),
  platform_auth.customer_dossier(uuid, uuid),
  platform_auth.customer_timeline(uuid, text, int)
to app_runtime;

revoke all on function
  platform_auth.customer_trust(uuid),
  platform_auth.customer_board(uuid, text, text, text, text, int, int),
  platform_auth.customer_dossier(uuid, uuid),
  platform_auth.customer_timeline(uuid, text, int)
from public, anon, authenticated, service_role;

-- ============================================================
-- 10. say what this leaves the platform in
-- ============================================================

do $$ declare
  v_checks int;
  v_open int;
  v_orphans int;
  v_notes int;
  v_tags int;
  v_verifiers int;
  v_sample jsonb;
begin
  select count(*)::int into v_checks from customer_verifications;
  select count(*)::int into v_open from customer_verifications
    where status in ('awaiting','submitted');
  -- An answer with no signature is the row this migration exists to refuse. If one is on the
  -- register the CHECK did not do its job, so the migration stops rather than notices.
  select count(*)::int into v_orphans from customer_verifications
    where status in ('rejected','needs_more','approved')
      and (decided_by is null or decided_at is null);
  select count(*)::int into v_notes from customer_notes where voided_at is null;
  select count(*)::int into v_tags from customer_tags where deleted_at is null;
  select count(distinct rp.role_id)::int into v_verifiers from role_permissions rp
    join roles r on r.id = rp.role_id
   where rp.permission_key = 'control.customers.verify' and r.tenant_id is null;

  -- The SQL gate cannot see inside a function body, so each read is executed once here, against
  -- a live account, to prove it returns rather than raises. 061 shipped a definer that 500'd on
  -- every call while the whole suite printed green; a text grep is not evidence.
  begin
    select platform_auth.customer_trust(t.id) into v_sample
      from tenants t where t.type <> 'platform' order by t.created_at limit 1;
    perform platform_auth.customer_timeline(t.id, null, 5)
      from tenants t where t.type <> 'platform' order by t.created_at limit 1;
  exception when others then
    raise exception '127: a customer read failed on a live account — %', sqlerrm;
  end;

  if v_orphans > 0 then
    raise exception '127: % answered check line(s) with no signature — the table must refuse '
      'such a row', v_orphans;
  end if;

  raise notice '127: the customer register is live — % check line(s), % still open, % note(s), '
    '% label(s) in the library, % role(s) may answer a check. Trust read ran: % (band %)',
    v_checks, v_open, v_notes, v_tags, v_verifiers,
    coalesce(v_sample ->> 'score', 'no account yet'),
    coalesce(v_sample ->> 'band', 'n/a');
end $$;

commit;
