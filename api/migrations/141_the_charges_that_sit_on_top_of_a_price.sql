-- 141: the charges that sit on top of a price
--
-- 140's own header closed with "Deliberately NOT here: surcharges, promo codes, commission per
-- tenant/plan (they are the next card on this module, and they change the arithmetic, not the
-- register)". This is that card, and the second half of the sentence is the design: 140 answers what
-- one scope costs on one day, and nothing here touches that answer. What follows is what a job carries
-- *besides* the freight — a fuel levy standing on every quote along a corridor, a handling charge per
-- container, a launch discount a customer names at the desk.
--
-- Why a surcharge is not a rate line. A rate line answers "what is the freight" and exactly one of them
-- wins a scope, which is why 140 needs a specificity ladder and a written tie-break. Surcharges do not
-- compete — a job legitimately carries a fuel levy, a handling charge and a security fee at once — so
-- they stack, in an order fixed by code, and the working prints every one. Making them lines would have
-- meant either a second resolver that ignores the ladder or a ladder that lies.
--
-- Why two kinds share one register. A surcharge and a promo code are the same object: a figure, a
-- basis, a window, a version, a signature, a memory. They differ in two facts and both are data: a
-- surcharge adds and a promo subtracts, and a promo is counted, because a discount a thousand people
-- have already taken is a promise the office cannot keep. So one table carries both and the two words
-- live in `pricing_addendum_kinds` with their prefix, their basis set and their sign written once, as a
-- row — the same reason 130 made transport modes data, 132 the customs regimes and 134 the rails. A
-- `kind` scattered through CHECK constraints and a route's switch statement is how the fifth desk gets
-- it wrong.
--
-- Why a promo's remaining uses are counted and never stored. 133 recomputes a wallet's balance from its
-- postings and 135 recomputes a count's totals from its piles, because a cached figure drifts the day
-- somebody fixes the thing it describes. So `pricing_addendum_claims` is the register of places taken
-- and "uses left" is `count(*)` over it. The one column a claim row may gain is the void triple, which
-- is why an UPDATE guard exists that permits nothing else: a use that was recorded by mistake loses its
-- place, and the row that proves it was recorded and cancelled stays.
--
-- Why publishing an addendum needs the second seat and 140's duty is enough. A surcharge changes what a
-- customer is billed; a promo changes what the office gives up. Both are the act 121 reserved for two
-- hands, so `pricing.addendum` joins the register as its own action name and its own effect. It is a
-- *new* action rather than `pricing.publish` with a different target because 121's one-open-proposal
-- index is keyed on (action, target_kind, target_id): a price list and a surcharge with the same id
-- under one action would collide, and a signature is supposed to name one thing. No fourth duty is
-- added — the same three 140 minted cover reading, drafting and signing an addendum too, because a
-- seat that may put a price live may put a levy live, and a fourth key would be a nav entry nobody
-- granted anyone.
--
-- What is deliberately NOT here: commission per tenant or plan. A commission is money the office owes
-- somebody out of a transaction, so its register needs a transaction to sit on and a chart of accounts
-- to be posted against — 133's book, not a price that describes no movement. It is the next card, and
-- the one refusal this migration cannot make is a levy that quietly becomes a liability.
begin;

-- ============================================================
-- 1. the two words a charge is allowed to be
-- ============================================================

-- The prefix a ref is minted with, the sign the figure carries into the arithmetic and the bases the
-- word permits, all in one row. Nothing below re-types them: the doors read the kind, the guards read
-- the kind and `price_a_job` reads the kind's sign, so a third word added here is priced by the
-- register without a line of plpgsql being edited.
create table if not exists pricing_addendum_kinds (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- Three capitals, because the ref's first block is read off a printed quote by a clerk on a phone.
  prefix text not null check (prefix ~ '^[A-Z]{3}$'),
  label text not null check (char_length(trim(label)) between 2 and 60),
  -- The whole of the arithmetic a kind is allowed to take part in: +1 adds to the payable, -1 takes off.
  sign int not null check (sign in (1, -1)),
  -- Whether the word's figures are counted against a ceiling. A promo is; a standing levy is not.
  counted boolean not null default false,
  -- The bases this kind may be written on. The quantity-carrying words are 140's own vocabulary and are
  -- deliberately *not* inserted into `pricing_dimensions` — 140's census and its gate both assert that
  -- table holds exactly 21 words, and a basis the freight resolver can multiply by is a basis a freight
  -- quote can be asked for, which is not true of percent_of_freight.
  basis_set text[] not null,
  sort int not null default 0,
  constraint pricing_addendum_kinds_one_word unique (key)
);

alter table pricing_addendum_kinds enable row level security;
create policy pricing_addendum_kinds_readable on pricing_addendum_kinds for select to app_runtime
  using (true);
grant select on pricing_addendum_kinds to app_runtime;
revoke all on pricing_addendum_kinds from public, anon, authenticated, service_role;

insert into pricing_addendum_kinds (key, prefix, label, sign, counted, basis_set, sort) values
  ('surcharge', 'SUR', 'Standing charge', 1, false,
    array['percent_of_freight','flat','per_km','per_tonne','per_teu','per_cbm','per_day'], 1),
  ('promo', 'PRM', 'Discount code', -1, true,
    array['percent_off','amount_off'], 2)
on conflict (key) do nothing;

-- ============================================================
-- 2. the register: whose charge, which figure, valid for which days
-- ============================================================

create sequence if not exists pricing_addendum_number_seq;
-- Granted to nobody, not even the app role, for 134's and 135's reason: a client role that can take a
-- number without writing a row leaves the office a hole in its own numbering to explain. The doors in
-- sections 8 and 9 run as their own owner and are the only hands that reach for one.

create table if not exists pricing_addenda (
  id uuid primary key default gen_random_uuid(),
  -- Whose charge it is, named the way 133 names a book and 140 names a card: the platform's levies live
  -- on the platform tenant, a company's on the company.
  tenant_id uuid not null references tenants(id),
  ref text not null unique check (ref ~ '^[A-Z]{3}-[0-9]{4}-[0-9]{5,}$'),
  -- FUEL-SUR. The code is the name the office says out loud and it keeps its shape across versions, and
  -- the code keeps its *kind* with it: a discount renamed into a levy would be a new charge wearing an
  -- old customer's promise.
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  kind text not null,
  label text not null check (char_length(trim(label)) between 3 and 80),
  -- One money per charge, exactly as 140 insisted on one money per card. `price_a_job` binds it again at
  -- the moment of the sum, because a TZS levy added under a USD card is 138's defect arriving one table
  -- away from the register that caught it.
  currency text not null default 'TZS' check (currency in ('TZS','USD')),
  status text not null default 'draft'
    check (status in ('draft','pending_signature','published','superseded','withdrawn')),
  version int not null default 1 check (version >= 1),
  -- What the charge is worked out on. Either one of 140's quantity words, in which case `value` is a
  -- rate and the job's quantity multiplies it, or one of the three words this register owns, in which
  -- case `value` is a percentage of the freight or the payable, or a flat figure in the card's money.
  basis text not null,
  value numeric(14,4) not null check (value > 0 and value < 10000000000),
  -- The most this one charge contributes, in its own money. A percent of a long corridor runs away
  -- without it, and a clerk who cannot say what a levy tops out at cannot argue with the figure.
  cap numeric(14,2) check (cap is null or (cap >= 0 and cap < 100000000000)),
  -- The smallest payable a promo will touch. A discount that fires on every job is a price cut the
  -- office decided in advance nobody would notice.
  min_amount numeric(14,2) check (min_amount is null or (min_amount >= 0 and min_amount < 100000000000)),
  -- How many places the promo has. Null is "no ceiling", and the board prints that word rather than a
  -- dash, because "unlimited" is a fact a desk is asked about.
  max_uses int check (max_uses is null or (max_uses between 1 and 1000000)),
  -- The scope, with the same three nullable halves 140 gave a line. Null means every job.
  route_id uuid references routes(id),
  vehicle_class text,
  container_type text,
  effective_from date,
  effective_to date,
  supersedes_id uuid references pricing_addenda(id),
  approval_id uuid references platform_approvals(id),
  refusals int not null default 0 check (refusals >= 0),
  note text check (note is null or char_length(trim(note)) between 8 and 600),
  published_by uuid references users(id),
  published_at timestamptz,
  published_note text check (published_note is null
                              or char_length(trim(published_note)) between 8 and 600),
  withdrawn_by uuid references users(id),
  withdrawn_at timestamptz,
  withdrawn_reason text check (withdrawn_reason is null
                                or char_length(trim(withdrawn_reason)) between 8 and 600),
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_addenda_one_version_per_code unique (tenant_id, code, version),
  constraint pricing_addenda_window_is_a_window check (
    effective_from is null or effective_to is null or effective_to >= effective_from),
  constraint pricing_addenda_published_has_a_start check (
    status <> 'published' or (effective_from is not null and published_at is not null)),
  constraint pricing_addenda_publish_leaves_a_mark check (
    published_at is null or status in ('published','superseded','withdrawn')),
  constraint pricing_addenda_withdrawal_is_explained check (
    (status = 'withdrawn') = (withdrawn_at is not null and withdrawn_reason is not null)),
  constraint pricing_addenda_unsigned_paper_is_pending check (
    status <> 'pending_signature' or approval_id is not null),
  constraint pricing_addenda_does_not_supersede_itself check (
    supersedes_id is null or supersedes_id <> id),
  -- A percentage is a percentage in either direction, and a figure of 400 read as "400 percent off" is
  -- not a discount, it is a refund the office never agreed to make.
  constraint pricing_addendum_percent_is_a_percent check (
    basis not in ('percent_of_freight','percent_off') or (value > 0 and value <= 100)),
  -- A standing levy is not a place in a queue. The ceiling belongs to the counted word alone, so a
  -- surcharge typed with one is refused by the register instead of silently ignored by the count.
  constraint pricing_surcharge_is_never_counted check (
    kind <> 'surcharge' or max_uses is null)
);

create index if not exists pricing_addenda_book_idx on pricing_addenda (tenant_id, status, kind, code);
create index if not exists pricing_addenda_code_idx on pricing_addenda (code, version desc);

alter table pricing_addenda enable row level security;
create policy pricing_addenda_tenant on pricing_addenda for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on pricing_addenda to app_runtime;
revoke all on pricing_addenda from public, anon, authenticated, service_role;

create trigger trg_pricing_addenda_updated before update on pricing_addenda
  for each row execute function public.set_updated_at();

-- ============================================================
-- 3. the memory: what the charge used to be
-- ============================================================

-- Same shape and same reason as 140's: one row per thing that moved, both halves printed as text,
-- because a figure change, a window change, a state change and a place taken are all answers to "what
-- was it before" and not one of them is arithmetic.
create table if not exists pricing_addendum_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  addendum_id uuid not null references pricing_addenda(id),
  claim_id uuid,
  what text not null check (what in ('figure','window','state','claim','void')),
  said text not null check (char_length(said) between 1 and 200),
  old_value text,
  new_value text not null,
  currency text,
  reason text not null check (char_length(trim(reason)) between 8 and 600),
  actor_user_id uuid references users(id),
  actor_role text,
  approval_id uuid references platform_approvals(id),
  at timestamptz not null default now()
);

create index if not exists pricing_addendum_history_item_idx
  on pricing_addendum_history (addendum_id, at desc);
create index if not exists pricing_addendum_history_book_idx
  on pricing_addendum_history (tenant_id, at desc);

alter table pricing_addendum_history enable row level security;
create policy pricing_addendum_history_tenant on pricing_addendum_history for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on pricing_addendum_history to app_runtime;
revoke all on pricing_addendum_history from public, anon, authenticated, service_role;

-- ============================================================
-- 4. the places taken: why a promo can run out
-- ============================================================

-- No cascade on either reference, on purpose. A charge that customers took places in is kept when its
-- version is superseded and when its book is closed, because "who had the launch discount" is the
-- question a dispute asks after the promo is gone, and a delete that takes the evidence with it is the
-- reason the count is not a column.
create table if not exists pricing_addendum_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  addendum_id uuid not null references pricing_addenda(id),
  -- Who took the place, named by kind because a promo is written for an account, for a company or for
  -- one vehicle's owner and the register is not the place to decide which of those exists.
  subject_kind text not null check (subject_kind in ('tenant','customer','user','vehicle','driver')),
  subject_id uuid not null,
  -- Whatever the clerk is quoting the job by. Free text, 3-60, because the office's job numbers are not
  -- one shape across modules and a claim that cannot name the work it was taken on names nothing.
  job_ref text check (job_ref is null or char_length(trim(job_ref)) between 3 and 60),
  freight numeric(14,2) check (freight is null or (freight >= 0 and freight < 100000000000)),
  taken numeric(14,2) check (taken is null or (taken >= 0 and taken < 100000000000)),
  currency text check (currency is null or currency in ('TZS','USD')),
  note text check (note is null or char_length(trim(note)) between 8 and 600),
  claimed_by uuid references users(id),
  claimed_role text,
  claimed_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references users(id),
  void_reason text check (void_reason is null or char_length(trim(void_reason)) between 8 and 600)
);

-- One live place per subject per charge. Partial, so voiding a mistaken claim frees the place without
-- deleting the row that proves the mistake happened and who cancelled it.
create unique index pricing_addendum_one_live_claim
  on pricing_addendum_claims (addendum_id, subject_kind, subject_id)
  where voided_at is null;
create index if not exists pricing_addendum_claim_count_idx
  on pricing_addendum_claims (addendum_id) where voided_at is null;

alter table pricing_addendum_claims enable row level security;
create policy pricing_addendum_claims_tenant on pricing_addendum_claims for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on pricing_addendum_claims to app_runtime;
revoke all on pricing_addendum_claims from public, anon, authenticated, service_role;

-- ============================================================
-- 5. the guards
-- ============================================================

create or replace function platform_auth.pricing_addendum_history_is_kept() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  raise exception '141: an addendum-history row is a record of what the office signed or of who took a '
    'place, and it cannot be %', tg_op;
end $$;

create trigger pricing_addendum_history_is_append_only
  before update or delete on pricing_addendum_history
  for each row execute function platform_auth.pricing_addendum_history_is_kept();

-- A charge that a signature ever stood on, or that ever went live, is not deleted — not after it is
-- superseded, and not after it is withdrawn. A draft opened by mistake is thrown away through
-- `discard_pricing_addendum`, which deletes the row and leaves the audit line, exactly as 140 does.
create or replace function platform_auth.pricing_addendum_is_kept() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if OLD.published_at is not null or OLD.approval_id is not null or OLD.status <> 'draft' then
    raise exception '141: % is a % charge that % a signature, so it is kept: %',
      OLD.ref, OLD.status,
      case when OLD.approval_id is not null then 'carries' else 'never had' end,
      case when OLD.published_at is not null or OLD.status <> 'draft'
        then 'a charge a customer may have been quoted is ended by withdrawing it or by a new version, '
          || 'never by a delete'
        else 'a paper anyone was asked to sign names this charge, and the row is kept so the paper goes '
          || 'on naming something'
      end;
  end if;
  return OLD;
end $$;

create trigger pricing_addenda_are_kept
  before delete on pricing_addenda
  for each row execute function platform_auth.pricing_addendum_is_kept();

-- The row's identity never moves, its kind never moves, its figures stop moving the day it went live,
-- and a charge that was published never goes back to being a draft.
--
-- The figure freeze is expressed against `published_at` rather than against `status <> 'draft'` because
-- here, unlike 140, the figures and the state live on one row: the publish itself is an UPDATE made
-- while the status is `pending_signature`, and a guard that froze anything but a draft would refuse the
-- very write it is standing for. `edit_pricing_addendum` refuses a non-draft on its own, so nothing
-- less than a signature can move a figure either way.
create or replace function platform_auth.pricing_addendum_header_is_immutable() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.id           is distinct from OLD.id
    or NEW.tenant_id  is distinct from OLD.tenant_id
    or NEW.ref        is distinct from OLD.ref
    or NEW.code       is distinct from OLD.code
    or NEW.kind       is distinct from OLD.kind
    or NEW.version    is distinct from OLD.version
    or NEW.created_at is distinct from OLD.created_at
    or NEW.created_by is distinct from OLD.created_by then
    raise exception '141: % belongs to the book % as % version % and its kind is %; none of that is '
      'editable', OLD.ref, OLD.tenant_id, OLD.code, OLD.version, OLD.kind;
  end if;
  if NEW.currency is distinct from OLD.currency then
    raise exception '141: % is priced in %. Changing the money under a figure is not re-pricing it: a '
      'TZS levy read as USD is 138''s defect, so open a new charge instead.', OLD.ref, OLD.currency;
  end if;
  if OLD.published_at is not null and (
       NEW.value        is distinct from OLD.value
    or NEW.basis        is distinct from OLD.basis
    or NEW.cap          is distinct from OLD.cap
    or NEW.min_amount   is distinct from OLD.min_amount
    or NEW.max_uses     is distinct from OLD.max_uses
    or NEW.route_id     is distinct from OLD.route_id
    or NEW.vehicle_class is distinct from OLD.vehicle_class
    or NEW.container_type is distinct from OLD.container_type) then
    raise exception '141: % was published, so its figure and its scope are kept. Move a charge by '
      'cloning it to a new version and signing that.', OLD.ref;
  end if;
  if OLD.published_at is not null and NEW.effective_from is distinct from OLD.effective_from then
    raise exception '141: % was published as effective from %, and the day a customer was charged from '
      'is not moved afterwards.', OLD.ref, coalesce(OLD.effective_from::text, 'nothing');
  end if;
  if OLD.published_at is not null and NEW.status = 'draft' then
    raise exception '141: % has been a live charge. A version that was signed is superseded or '
      'withdrawn, never edited back into a draft.', OLD.ref;
  end if;
  if OLD.status = 'withdrawn' and NEW.status is distinct from OLD.status then
    raise exception '141: % was stopped on %, and a stopped charge stays stopped.',
      OLD.ref, to_char(OLD.withdrawn_at, 'YYYY-MM-DD');
  end if;
  if OLD.status = 'superseded' and NEW.status is distinct from OLD.status then
    raise exception '141: % was closed by the version that replaced it; there is nothing left to change.',
      OLD.ref;
  end if;
  return NEW;
end $$;

create trigger pricing_addenda_keep_their_dates
  before update on pricing_addenda
  for each row execute function platform_auth.pricing_addendum_header_is_immutable();

-- Two published charges of one code covering one day would make the sum depend on which row the
-- composer happened to read first. NULL is read as "open", never skipped — 140 learned that a guard
-- comparing windows with bare operators is NULL-transparent and lets the overlap through.
create or replace function platform_auth.pricing_one_charge_per_day() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_other pricing_addenda;
begin
  if NEW.status <> 'published' then
    return NEW;
  end if;
  select * into v_other from pricing_addenda a
   where a.tenant_id = NEW.tenant_id
     and a.code = NEW.code
     and a.status = 'published'
     and a.id <> NEW.id
     and NEW.effective_from is not null
     and coalesce(a.effective_to, date 'infinity') >= NEW.effective_from
     and coalesce(NEW.effective_to, date 'infinity') >= a.effective_from
   order by a.effective_from desc limit 1;
  if found then
    raise exception '141: % is already published for this charge over the days %–%. Two figures for one '
      'day is not a sum the composer can make.',
      v_other.ref,
      to_char(least(v_other.effective_from, NEW.effective_from), 'YYYY-MM-DD'),
      to_char(greatest(coalesce(v_other.effective_to, NEW.effective_to),
                       coalesce(NEW.effective_to, v_other.effective_to)), 'YYYY-MM-DD');
  end if;
  return NEW;
end $$;

create trigger pricing_addenda_do_not_overlap
  before insert or update on pricing_addenda
  for each row execute function platform_auth.pricing_one_charge_per_day();

-- What a charge may name: a kind that exists, a basis that kind permits, a route in the same book, the
-- same vocabulary 140 keyed its lines on, one money, and the code's kind carried across versions.
create or replace function platform_auth.pricing_addendum_names_its_own_book() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_kind pricing_addendum_kinds;
  v_other pricing_addenda;
begin
  select * into v_kind from pricing_addendum_kinds where key = NEW.kind;
  if not found then
    raise exception '141: % is not a charge this register can be. It knows: %',
      NEW.kind, (select string_agg(k.key, ', ' order by k.sort) from pricing_addendum_kinds k);
  end if;
  if not (NEW.basis = any (v_kind.basis_set)) then
    raise exception '141: a % is never worked out on a % basis. That word knows: %',
      NEW.kind, NEW.basis, array_to_string(v_kind.basis_set, ', ');
  end if;
  -- The code keeps its kind across versions, so a discount cloned forward cannot come back a levy.
  select * into v_other from pricing_addenda a
   where a.tenant_id = NEW.tenant_id and a.code = NEW.code and a.id <> NEW.id
   order by a.version desc limit 1;
  if found and v_other.kind <> NEW.kind then
    raise exception '141: % already files % as a % in this book. A second version of that name cannot '
      'change what it is; open a different code instead.', NEW.tenant_id, NEW.code, v_other.kind;
  end if;
  if NEW.route_id is not null then
    if not exists (select 1 from routes r
                    where r.id = NEW.route_id and r.tenant_id = NEW.tenant_id
                      and r.deleted_at is null) then
      raise exception '141: route % is not a corridor of the book that owns % — a charge cannot be laid '
        'on a road the book does not have', NEW.route_id, NEW.ref;
    end if;
  end if;
  if NEW.vehicle_class is not null and not exists (
       select 1 from pricing_dimensions d
        where d.kind = 'vehicle_class' and d.key = NEW.vehicle_class) then
    raise exception '141: % is not a vehicle class this register knows', NEW.vehicle_class;
  end if;
  if NEW.container_type is not null and not exists (
       select 1 from pricing_dimensions d
        where d.kind = 'container' and d.key = NEW.container_type) then
    raise exception '141: % is not a container kind cargo can be filed as', NEW.container_type;
  end if;
  if NEW.currency not in ('TZS','USD') then
    raise exception '141: % carries a money this register cannot charge', NEW.ref;
  end if;
  return NEW;
end $$;

create trigger pricing_addenda_belong_to_their_book
  before insert or update on pricing_addenda
  for each row execute function platform_auth.pricing_addendum_names_its_own_book();

-- A place taken is evidence. It is never deleted, and the only change it can undergo is losing its
-- place, which is the three columns below and nothing else — so a void cannot also move the figure it
-- records or the subject it was written against.
create or replace function platform_auth.pricing_addendum_claim_is_kept() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  raise exception '141: a promo place that was taken is a record of what the office gave away, and it '
    'cannot be %', tg_op;
end $$;

create trigger pricing_addendum_claims_are_kept
  before delete on pricing_addendum_claims
  for each row execute function platform_auth.pricing_addendum_claim_is_kept();

create or replace function platform_auth.pricing_addendum_claim_only_loses_its_place() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.id           is distinct from OLD.id
    or NEW.tenant_id  is distinct from OLD.tenant_id
    or NEW.addendum_id is distinct from OLD.addendum_id
    or NEW.subject_kind is distinct from OLD.subject_kind
    or NEW.subject_id is distinct from OLD.subject_id
    or NEW.claimed_by  is distinct from OLD.claimed_by
    or NEW.claimed_at  is distinct from OLD.claimed_at
    or NEW.freight     is distinct from OLD.freight
    or NEW.taken       is distinct from OLD.taken
    or NEW.currency    is distinct from OLD.currency
    or NEW.job_ref     is distinct from OLD.job_ref
    or NEW.note        is distinct from OLD.note then
    raise exception '141: a claim records who took a place on % and what the office gave them. The only '
      'thing that changes is whether the place still counts.', OLD.addendum_id;
  end if;
  if NEW.voided_at is distinct from OLD.voided_at and NEW.voided_at is not null
     and OLD.voided_at is not null then
    raise exception '141: that place was already given back on %, so there is nothing left to void.',
      to_char(OLD.voided_at, 'YYYY-MM-DD');
  end if;
  -- Un-voiding is not a thing: it would put a claim back into a count that other clerks have already
  -- read. The answer to a wrong void is a fresh claim, which is a real row with its own author.
  if OLD.voided_at is not null and NEW.voided_at is null then
    raise exception '141: a place given back stays given back. Take the claim again through the door '
      'that counts it, so the second row has its own author and its own minute.';
  end if;
  -- A void is three columns written by one statement: the date, the seat and the reason. Half a void is an
  -- anonymous give-back, and a seat stamped on a claim that was never given back is a note pretending to be
  -- a record — so the three are tested together, and the test is on the new row rather than on which of
  -- them happened to flip, which the door's own legitimate void would fail.
  if ((NEW.voided_at is null)::int + (NEW.voided_by is null)::int
      + (NEW.void_reason is null)::int) not in (0, 3) then
    raise exception '141: a void names the seat that gave the place back and says why, in the same '
      'statement that sets the date.';
  end if;
  return NEW;
end $$;

create trigger pricing_addendum_claims_keep_their_facts
  before update on pricing_addendum_claims
  for each row execute function platform_auth.pricing_addendum_claim_only_loses_its_place();

-- ============================================================
-- 6. the paper a second seat signs
-- ============================================================

-- The canonical bytes of one charge. `::text` of the numeric columns is the printed form the signature
-- is cut on, for 140's reason: a rate is a fourth-decimal figure and signing '12.5' where the register
-- holds '12.5000' is a translation dressed as a fact. `apply_pricing_addendum` rebuilds these bytes
-- from the row before a single column moves.
create or replace function platform_auth.pricing_addendum_paper(p_addendum uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'addendum_id', a.id::text,
    'ref', a.ref,
    'code', a.code,
    'kind', a.kind,
    'kind_label', (select k.label from pricing_addendum_kinds k where k.key = a.kind),
    'label', a.label,
    'currency', a.currency,
    'version', a.version,
    'basis', a.basis,
    'value', a.value::text,
    'cap', a.cap::text,
    'min_amount', a.min_amount::text,
    'max_uses', a.max_uses,
    'route', coalesce(r.name, 'any route'),
    'route_id', a.route_id::text,
    'vehicle_class', coalesce(a.vehicle_class, 'any'),
    'container_type', coalesce(a.container_type, 'any'),
    'effective_from', a.effective_from::text,
    'effective_to', a.effective_to::text,
    'note', a.note
  )
  from pricing_addenda a
  left join routes r on r.id = a.route_id
  where a.id = p_addendum
$$;

create or replace function platform_auth.pricing_addendum_sha256(p_addendum uuid)
returns text language sql stable security definer set search_path = public as $$
  select encode(extensions.digest(platform_auth.pricing_addendum_paper(p_addendum)::text, 'sha256'), 'hex')
$$;

-- ============================================================
-- 7. the reads
-- ============================================================

-- How many live places a charge has taken. One expression, used by the board, the detail and the
-- composer, so the number a desk shows and the number that refuses a claim cannot be two different
-- counts of the same table.
create or replace function platform_auth.pricing_addendum_uses_taken(p_addendum uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from pricing_addendum_claims c
   where c.addendum_id = p_addendum and c.voided_at is null
$$;

-- The sentence a charge's scope is told in, clamped to the memory column's own ceiling for 140's
-- reason: a row that cannot be written because its story is 201 characters is no memory at all.
create or replace function platform_auth.pricing_addendum_said(a pricing_addenda)
returns text language sql stable security definer set search_path = public as $$
  select left(trim(both ' ' from concat(
    coalesce((select r.name from routes r where r.id = a.route_id), 'any route'), ' / ',
    coalesce(a.vehicle_class, 'any class'), ' / ',
    coalesce(a.container_type, 'any container'), ' / ', a.basis)), 200)
$$;

create or replace function platform_auth.pricing_addenda(
  p_tenant uuid, p_status text, p_search text, p_kind text, p_code text, p_limit int, p_offset int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_limit int;
  v_offset int;
  v_status text;
  v_kind text;
  v_rows jsonb;
  v_counts jsonb;
  v_total int;
begin
  v_limit := least(greatest(coalesce(p_limit, 30), 1), 200);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  v_status := nullif(lower(trim(coalesce(p_status, ''))), '');
  v_kind := nullif(lower(trim(coalesce(p_kind, ''))), '');
  if v_status is not null and v_status not in
     ('draft','pending_signature','published','superseded','withdrawn') then
    return jsonb_build_object('ok', false, 'error', 'bad_status', 'asked', v_status,
      'message', 'A charge is a draft, a paper waiting for a signature, a live levy, a superseded one, '
        || 'or a withdrawn one.');
  end if;
  if v_kind is not null and not exists (select 1 from pricing_addendum_kinds k where k.key = v_kind) then
    return jsonb_build_object('ok', false, 'error', 'bad_kind', 'asked', v_kind,
      'message', 'This register knows two charges: '
        || (select string_agg(k.key, ', ') from pricing_addendum_kinds k) || '.');
  end if;
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no charge in a book that is not here.');
  end if;

  -- The page is cut in the subquery and counted over the whole filter, so `total` is what the heading
  -- describes rather than what this page carried. A search reaches the corridor a charge is laid on,
  -- not only the name the office gave it: the question at the desk is "does anything add to a Kigoma
  -- quote".
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'ref', x.ref, 'code', x.code, 'kind', x.kind,
           'kind_label', (select k.label from pricing_addendum_kinds k where k.key = x.kind),
           'sign', (select k.sign from pricing_addendum_kinds k where k.key = x.kind),
           'label', x.label, 'currency', x.currency, 'status', x.status, 'version', x.version,
           'basis', x.basis, 'value', x.value::text, 'cap', x.cap::text,
           'min_amount', x.min_amount::text, 'max_uses', x.max_uses,
           'uses_taken', platform_auth.pricing_addendum_uses_taken(x.id),
           'uses_left', case when x.max_uses is null then null
                             else greatest(x.max_uses - platform_auth.pricing_addendum_uses_taken(x.id), 0)
                        end,
           'unlimited', (x.max_uses is null),
           'scope', x.scope,
           'effective_from', x.effective_from::text, 'effective_to', x.effective_to::text,
           'refusals', x.refusals, 'approval_id', x.approval_id,
           'approval_status', (select a.status from platform_approvals a where a.id = x.approval_id),
           'published_by', (select u.full_name from users u where u.id = x.published_by),
           'published_at', to_char(x.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'published_note', x.published_note,
           'withdrawn_reason', x.withdrawn_reason,
           'supersedes', (select s.ref from pricing_addenda s where s.id = x.supersedes_id),
           'updated_at', to_char(x.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
           order by x.kind, x.code, x.version desc, x.created_at desc), '[]'::jsonb),
         coalesce(max(x.whole), 0)::int
    into v_rows, v_total
  from (
    -- The scope sentence is built here, where the row is the table's own, and carried out as text: a
    -- subquery's whole-row column is an anonymous record, and `pricing_addendum_said` is written against
    -- `pricing_addenda`, which an anonymous record cannot be cast to once the planner flattens the page.
    select a.id, a.ref, a.code, a.kind, a.label, a.currency, a.status, a.version, a.basis, a.value,
           platform_auth.pricing_addendum_said(a) as scope,
           a.cap, a.min_amount, a.max_uses, a.effective_from, a.effective_to, a.refusals,
           a.approval_id, a.published_by, a.published_at, a.published_note, a.withdrawn_reason,
           a.supersedes_id, a.updated_at, a.created_at,
           count(*) over () as whole
      from pricing_addenda a
     where a.tenant_id = p_tenant
       and (v_status is null or a.status = v_status)
       and (v_kind is null or a.kind = v_kind)
       and (nullif(trim(coalesce(p_code, '')), '') is null
            or a.code = upper(trim(p_code)))
       and (nullif(trim(coalesce(p_search, '')), '') is null
            or a.label ilike '%' || trim(p_search) || '%'
            or a.code ilike '%' || upper(trim(p_search)) || '%'
            or a.ref ilike '%' || upper(trim(p_search)) || '%'
            or exists (select 1 from routes r where r.id = a.route_id
                        and (r.name ilike '%' || trim(p_search) || '%'
                             or r.origin_text ilike '%' || trim(p_search) || '%'
                             or r.dest_text ilike '%' || trim(p_search) || '%')))
     order by a.kind, a.code, a.version desc, a.created_at desc
     limit v_limit offset v_offset
  ) x;

  -- Five status chips and two kind chips, each counted over the whole book, the way 140 counts its
  -- heading: a desk that counts its own rows in the client disagrees with its table after page one.
  select coalesce(jsonb_object_agg(st.n, cnt.n) filter (where cnt.n > 0), '{}'::jsonb)
    into v_counts
  from (values ('draft'::text), ('pending_signature'), ('published'), ('superseded'), ('withdrawn'),
               ('kind_surcharge'), ('kind_promo')) st(n)
  cross join lateral (
    select count(*)::int as n from pricing_addenda a
     where a.tenant_id = p_tenant
       and (st.n like 'kind_%'
            and a.kind = nullif(replace(st.n, 'kind_', ''), '')
            or a.status = st.n)
  ) cnt;

  return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total,
    'counts', v_counts, 'limit', v_limit, 'offset', v_offset,
    'kinds', (select coalesce(jsonb_agg(jsonb_build_object('key', k.key, 'prefix', k.prefix,
                       'label', k.label, 'sign', k.sign, 'counted', k.counted,
                       'basis_set', k.basis_set) order by k.sort), '[]'::jsonb)
                from pricing_addendum_kinds k));
end $$;

create or replace function platform_auth.pricing_addendum_detail(p_tenant uuid, p_addendum uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v pricing_addenda;
  v_versions jsonb;
  v_approval jsonb;
  v_memory jsonb;
  v_claims jsonb;
  v_taken int;
begin
  select * into v from pricing_addenda where id = p_addendum and tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no charge with that number in this book. Quote the number printed on the paper.');
  end if;

  v_taken := platform_auth.pricing_addendum_uses_taken(v.id);

  select coalesce(jsonb_agg(jsonb_build_object(
           'ref', s.ref, 'version', s.version, 'status', s.status, 'basis', s.basis,
           'value', s.value::text, 'currency', s.currency,
           'effective_from', s.effective_from::text, 'effective_to', s.effective_to::text,
           'published_at', to_char(s.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'published_by', (select u.full_name from users u where u.id = s.published_by))
           order by s.version desc), '[]'::jsonb)
    into v_versions
  from pricing_addenda s where s.tenant_id = v.tenant_id and s.code = v.code;

  -- Two sentences live on a paper, and a desk that shows only one of them reads as a dead end: `reason` is
  -- what the proposing seat asked for, `decided_note` is what the second seat answered. The refuse door
  -- puts the clerk's own words into 121's `decided_note`, so the freed draft has to hand them back or the
  -- sentence typed against a levy is only in the audit log.
  select jsonb_build_object(
           'id', a.id, 'status', a.status, 'reason', a.reason,
           'proposed_by', (select u.full_name from users u where u.id = a.proposed_by),
           'proposed_at', to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'decided_by', (select u.full_name from users u where u.id = a.decided_by),
           'decided_note', a.decided_note,
           'decided_at', to_char(a.decided_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'expires_at', to_char(a.expires_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'payload_sha256', a.payload_sha256)
    into v_approval
  from platform_approvals a where a.id = v.approval_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'at', to_char(h.at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'what', h.what, 'said', h.said,
           'old_value', h.old_value, 'new_value', h.new_value, 'currency', h.currency,
           'reason', h.reason,
           'actor', (select u.full_name from users u where u.id = h.actor_user_id))
           order by h.at desc), '[]'::jsonb)
    into v_memory
  from (select * from pricing_addendum_history p
         where p.addendum_id = v.id order by p.at desc limit 20) h;

  -- The subjects are printed masked-by-kind: a claim names an account or a vehicle by uuid, and a uuid
  -- is not personal data on its own, but the desk does not need a list of who got the discount to show
  -- that the ceiling has been reached.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'subject_kind', c.subject_kind, 'subject_id', c.subject_id,
           'job_ref', c.job_ref, 'freight', c.freight::text, 'taken', c.taken::text,
           'currency', c.currency, 'note', c.note,
           'claimed_by', (select u.full_name from users u where u.id = c.claimed_by),
           'claimed_at', to_char(c.claimed_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'voided_at', to_char(c.voided_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'voided_by', (select u.full_name from users u where u.id = c.voided_by),
           'void_reason', c.void_reason) order by c.claimed_at desc), '[]'::jsonb)
    into v_claims
  from (select * from pricing_addendum_claims p
         where p.addendum_id = v.id order by p.claimed_at desc limit 20) c;

  return jsonb_build_object('ok', true,
    'addendum', jsonb_build_object(
      'id', v.id, 'ref', v.ref, 'code', v.code, 'kind', v.kind, 'label', v.label,
      'sign', (select k.sign from pricing_addendum_kinds k where k.key = v.kind),
      'counted', (select k.counted from pricing_addendum_kinds k where k.key = v.kind),
      'currency', v.currency, 'status', v.status, 'version', v.version, 'basis', v.basis,
      'value', v.value::text, 'cap', v.cap::text, 'min_amount', v.min_amount::text,
      'max_uses', v.max_uses, 'route_id', v.route_id,
      'route', (select r.name from routes r where r.id = v.route_id),
      'distance_km', (select r.distance_km from routes r where r.id = v.route_id),
      'vehicle_class', v.vehicle_class, 'container_type', v.container_type,
      'scope', platform_auth.pricing_addendum_said(v),
      'effective_from', v.effective_from::text, 'effective_to', v.effective_to::text,
      'note', v.note, 'refusals', v.refusals, 'approval_id', v.approval_id,
      'supersedes', (select s.ref from pricing_addenda s where s.id = v.supersedes_id),
      'published_by', (select u.full_name from users u where u.id = v.published_by),
      'published_at', to_char(v.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'published_note', v.published_note,
      'withdrawn_reason', v.withdrawn_reason,
      'withdrawn_at', to_char(v.withdrawn_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'created_at', to_char(v.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    'uses', jsonb_build_object('taken', v_taken, 'max_uses', v.max_uses,
      'left', case when v.max_uses is null then null
                   else greatest(v.max_uses - v_taken, 0) end,
      'unlimited', (v.max_uses is null)),
    'versions', v_versions, 'approval', v_approval, 'memory', v_memory, 'claims', v_claims,
    'paper_sha256', platform_auth.pricing_addendum_sha256(v.id));
end $$;

create or replace function platform_auth.pricing_addendum_memory(
  p_tenant uuid, p_addendum uuid, p_limit int, p_offset int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rows jsonb;
  v_total int;
  v_limit int;
  v_offset int;
begin
  v_limit := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset := greatest(coalesce(p_offset, 0), 0);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'charge', x.charge_ref, 'code', x.charge_code, 'kind', x.charge_kind,
           'what', x.what, 'said', x.said, 'old_value', x.old_value, 'new_value', x.new_value,
           'currency', x.currency, 'reason', x.reason,
           'actor', (select u.full_name from users u where u.id = x.actor_user_id),
           'actor_role', x.actor_role,
           'at', to_char(x.at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
           order by x.at desc, x.said), '[]'::jsonb)
    into v_rows
  from (
    select h.id, h.what, h.said, h.old_value, h.new_value, h.currency, h.reason,
           h.actor_user_id, h.actor_role, h.at,
           a.ref as charge_ref, a.code as charge_code, a.kind as charge_kind
      from pricing_addendum_history h
      join pricing_addenda a on a.id = h.addendum_id
     where h.tenant_id = p_tenant
       and (p_addendum is null or h.addendum_id = p_addendum)
     order by h.at desc, h.said
     limit v_limit offset v_offset
  ) x;

  select count(*)::int into v_total
    from pricing_addendum_history h
   where h.tenant_id = p_tenant and (p_addendum is null or h.addendum_id = p_addendum);

  return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total,
    'limit', v_limit, 'offset', v_offset);
end $$;

-- Every charge that stands on this scope on this day, in the order the composer will apply them. There
-- is no specificity ladder here on purpose: 140's lines compete for a scope and one wins, and these
-- stack, so the only order that matters is the one two rows cannot disagree about.
create or replace function platform_auth.pricing_addenda_in_force(
  p_tenant uuid, p_day date, p_kind text, p_code text, p_route uuid, p_vehicle_class text,
  p_container text
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_day date;
  v_kind text;
  v_code text;
  v_rows jsonb;
begin
  v_day := coalesce(p_day, current_date);
  v_kind := nullif(lower(trim(coalesce(p_kind, ''))), '');
  v_code := nullif(upper(trim(coalesce(p_code, ''))), '');
  if v_kind is not null and not exists (select 1 from pricing_addendum_kinds k where k.key = v_kind) then
    return jsonb_build_object('ok', false, 'error', 'bad_kind', 'asked', v_kind,
      'message', 'This register knows two charges: '
        || (select string_agg(k.key, ', ') from pricing_addendum_kinds k) || '.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'ref', a.ref, 'code', a.code, 'kind', a.kind, 'label', a.label,
           'sign', k.sign, 'counted', k.counted, 'currency', a.currency, 'version', a.version,
           'basis', a.basis, 'value', a.value::text, 'cap', a.cap::text,
           'min_amount', a.min_amount::text, 'max_uses', a.max_uses,
           'uses_taken', platform_auth.pricing_addendum_uses_taken(a.id),
           'scope', platform_auth.pricing_addendum_said(a),
           'route_id', a.route_id, 'vehicle_class', a.vehicle_class,
           'container_type', a.container_type,
           'effective_from', a.effective_from::text, 'effective_to', a.effective_to::text)
           order by a.kind, a.code, a.version desc), '[]'::jsonb)
    into v_rows
  from pricing_addenda a
  join pricing_addendum_kinds k on k.key = a.kind
  where a.tenant_id = p_tenant
    and a.status = 'published'
    and a.effective_from <= v_day
    and coalesce(a.effective_to, date 'infinity') >= v_day
    and (v_kind is null or a.kind = v_kind)
    and (v_code is null or a.code = v_code)
    and (a.route_id is null or a.route_id = p_route)
    and (a.vehicle_class is null or a.vehicle_class = nullif(lower(trim(coalesce(p_vehicle_class, ''))), ''))
    and (a.container_type is null
         or a.container_type = nullif(lower(trim(coalesce(p_container, ''))), ''));

  return jsonb_build_object('ok', true, 'rows', v_rows, 'asked_on', v_day::text,
    'count', jsonb_array_length(v_rows));
end $$;

-- ============================================================
-- 8. the draft doors
-- ============================================================

-- A charge carries its figure the moment it is opened, because unlike a rate card it is one number and
-- a draft with no number in it is nothing for a second seat to read.
create or replace function platform_auth.open_pricing_addendum(
  p_tenant uuid, p_kind text, p_code text, p_label text, p_basis text, p_value numeric,
  p_cap numeric, p_min_amount numeric, p_max_uses int, p_currency text, p_route uuid,
  p_vehicle_class text, p_container text, p_effective_from date, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_kind_key text;
  v_kind pricing_addendum_kinds;
  v_code text;
  v_label text;
  v_basis text;
  v_cur text;
  v_note text;
  v_from date;
  v_version int;
  v_prior pricing_addenda;
  v_new pricing_addenda;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can open a charge.');
  end if;
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'A charge belongs to a book that exists.');
  end if;

  v_kind_key := nullif(lower(trim(coalesce(p_kind, ''))), '');
  select * into v_kind from pricing_addendum_kinds where key = v_kind_key;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'bad_kind', 'asked', p_kind,
      'message', 'Say which charge this is, in the words the register keeps: '
        || (select string_agg(k.key, ', ') from pricing_addendum_kinds k) || '.');
  end if;
  v_code := upper(replace(trim(coalesce(p_code, '')), ' ', '_'));
  v_label := trim(coalesce(p_label, ''));
  v_basis := lower(trim(coalesce(p_basis, '')));
  v_cur := upper(trim(coalesce(p_currency, 'TZS')));
  v_note := trim(coalesce(p_note, ''));
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{1,29}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_code', 'asked', v_code,
      'message', 'A charge is named in capitals with underscores, like FUEL-SUR: the name is said out '
        || 'loud, survives a version bump and keeps its kind with it.');
  end if;
  if char_length(v_label) < 3 or char_length(v_label) > 80 then
    return jsonb_build_object('ok', false, 'error', 'bad_label',
      'message', 'The label is the sentence a clerk reads, and it is 3-80 characters.');
  end if;
  if v_cur not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'bad_currency', 'asked', v_cur,
      'message', 'A charge is one money: TZS or USD. A levy written in a third word cannot be added to '
        || 'a card priced in either of the two the register keeps.');
  end if;
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say in 8-600 characters what this charge is for: the second seat reads it before '
        || 'signing the figure.');
  end if;
  if p_value is null or p_value <= 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_value', 'asked', p_value,
      'message', 'The figure is what the charge is worth. A charge of nothing is a row with no purpose, '
        || 'so it is not stored.');
  end if;
  if p_value >= 10000000000 then
    return jsonb_build_object('ok', false, 'error', 'bad_value', 'asked', p_value,
      'message', 'That figure does not fit the register. A number this wide is a keystroke, not a price.');
  end if;
  if v_basis in ('percent_of_freight','percent_off') and p_value > 100 then
    return jsonb_build_object('ok', false, 'error', 'percent_too_wide', 'asked', p_value, 'basis', v_basis,
      'message', p_value || '% is not a percentage. A figure above 100 on a percent basis would take the '
        || 'freight away twice, and the register will not be asked to sign that.');
  end if;
  if p_cap is not null and (p_cap <= 0 or p_cap >= 100000000000) then
    return jsonb_build_object('ok', false, 'error', 'bad_cap', 'asked', p_cap,
      'message', 'A ceiling is a positive figure in the charge''s own money, or there is no ceiling.');
  end if;
  if p_min_amount is not null and (p_min_amount < 0 or p_min_amount >= 100000000000) then
    return jsonb_build_object('ok', false, 'error', 'bad_min_amount', 'asked', p_min_amount,
      'message', 'The floor is the smallest payable the code will touch, in whole figures of the '
        || 'charge''s money.');
  end if;
  if p_max_uses is not null and p_max_uses < 1 then
    return jsonb_build_object('ok', false, 'error', 'bad_max_uses', 'asked', p_max_uses,
      'message', 'A ceiling on places is at least one, or it is not a code anyone can be given.');
  end if;

  if not (v_basis = any (v_kind.basis_set)) then
    return jsonb_build_object('ok', false, 'error', 'bad_basis', 'asked', v_basis, 'kind', v_kind.key,
      'message', 'A ' || v_kind.key || ' is never worked out on a ' || coalesce(nullif(v_basis, ''), 'nothing')
        || ' basis. That word knows: ' || array_to_string(v_kind.basis_set, ', ') || '.');
  end if;
  if not v_kind.counted and p_max_uses is not null then
    return jsonb_build_object('ok', false, 'error', 'kind_is_not_counted', 'kind', v_kind.key,
      'message', 'A ' || v_kind.key || ' stands on every job it matches, so it has no places to run out '
        || 'of. A ceiling on places belongs to a '
        || (select k.key from pricing_addendum_kinds k where k.counted order by k.sort limit 1) || '.');
  end if;

  -- The code keeps its kind across versions, and the door says so before the insert rather than leaving
  -- it to the trigger, because the clerk is holding the name of an existing charge and deserves the
  -- sentence that names the row in front of them.
  select * into v_prior from pricing_addenda a
   where a.tenant_id = p_tenant and a.code = v_code
   order by a.version desc limit 1;
  if found and v_prior.kind <> v_kind.key then
    return jsonb_build_object('ok', false, 'error', 'kind_moved', 'code', v_code,
      'existing_kind', v_prior.kind, 'ref', v_prior.ref,
      'message', 'This book already files ' || v_code || ' as a ' || v_prior.kind || ' (' || v_prior.ref
        || '). A code cannot change what it is; name the new charge differently.');
  end if;

  v_from := coalesce(p_effective_from, current_date);
  v_version := coalesce((select max(a.version) from pricing_addenda a
                          where a.tenant_id = p_tenant and a.code = v_code), 0) + 1;

  insert into pricing_addenda (id, tenant_id, ref, code, kind, label, currency, status, version,
    basis, value, cap, min_amount, max_uses, route_id, vehicle_class, container_type,
    effective_from, note, created_by, updated_by)
  values (gen_random_uuid(), p_tenant,
          v_kind.prefix || '-' || to_char(now(), 'YYYY') || '-'
                        || lpad(nextval('pricing_addendum_number_seq')::text, 5, '0'),
          v_code, v_kind.key, v_label, v_cur, 'draft', v_version,
          v_basis, p_value, p_cap, p_min_amount, p_max_uses, p_route,
          nullif(lower(trim(coalesce(p_vehicle_class, ''))), ''),
          nullif(lower(trim(coalesce(p_container, ''))), ''),
          v_from, v_note, p_actor, p_actor)
  returning * into v_new;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_addenda', v_new.id, 'pricing.addendum_opened', null,
    jsonb_build_object('ref', v_new.ref, 'code', v_new.code, 'kind', v_new.kind,
      'label', v_new.label, 'currency', v_new.currency, 'version', v_new.version,
      'basis', v_new.basis, 'value', v_new.value::text, 'cap', v_new.cap::text,
      'min_amount', v_new.min_amount::text, 'max_uses', v_new.max_uses,
      'effective_from', v_new.effective_from::text, 'note', v_new.note, 'seat', v_seat));

  return platform_auth.pricing_addendum_detail(p_tenant, v_new.id);
end $$;

-- Editing a draft. The money is fixed the moment the row is written, because a TZS levy relabelled USD
-- is 138's defect one table away from the register that caught it, and 141's figures live on the same row
-- as its state — so the freeze is a door rule here and a trigger rule (pinned to `published_at`) in the
-- guard above, and the publish itself is the one write that both of them let through.
create or replace function platform_auth.edit_pricing_addendum(
  p_tenant uuid, p_addendum uuid, p_label text, p_basis text, p_value numeric, p_cap numeric,
  p_min_amount numeric, p_max_uses int, p_route uuid, p_vehicle_class text, p_container text,
  p_effective_from date, p_note text, p_clear text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_kind pricing_addendum_kinds;
  v_cur pricing_addenda;
  v_label text;
  v_basis text;
  v_note text;
  v_clears text[];
  v_value numeric;
  v_w text;
  v_before jsonb;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can change a draft charge.');
  end if;
  select * into v_cur from pricing_addenda
    where id = p_addendum and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no charge with that number in this book.');
  end if;
  if v_cur.status = 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'paper_is_out', 'ref', v_cur.ref,
      'message', v_cur.ref || ' is waiting for a second seat. Refuse the paper first — a figure the '
        || 'office is asked to sign cannot change underneath them.');
  end if;
  if v_cur.published_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_lived', 'ref', v_cur.ref,
      'message', v_cur.ref || ' was a live charge. Clone it to a new version instead of editing it.');
  end if;
  if v_cur.status <> 'draft' then
    return jsonb_build_object('ok', false, 'error', 'not_a_draft', 'ref', v_cur.ref,
      'status', v_cur.status, 'message', 'Only a draft is editable.');
  end if;

  select * into v_kind from pricing_addendum_kinds where key = v_cur.kind;

  v_label := trim(coalesce(p_label, v_cur.label));
  v_basis := lower(trim(coalesce(nullif(p_basis, ''), v_cur.basis)));
  v_note := trim(coalesce(p_note, coalesce(v_cur.note, '')));
  v_value := coalesce(p_value, v_cur.value);
  if char_length(v_label) < 3 or char_length(v_label) > 80 then
    return jsonb_build_object('ok', false, 'error', 'bad_label',
      'message', 'The label is 3-80 characters.');
  end if;
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'The note is 8-600 characters: it is the sentence the second seat reads.');
  end if;
  if not (v_basis = any (v_kind.basis_set)) then
    return jsonb_build_object('ok', false, 'error', 'bad_basis', 'asked', v_basis, 'kind', v_kind.key,
      'message', 'A ' || v_kind.key || ' is never worked out on a ' || v_basis || ' basis. That word '
        || 'knows: ' || array_to_string(v_kind.basis_set, ', ') || '.');
  end if;
  if v_value is null or v_value <= 0 or v_value >= 10000000000 then
    return jsonb_build_object('ok', false, 'error', 'bad_value', 'asked', v_value,
      'message', 'The figure is what the charge is worth: a positive number the register can hold.');
  end if;
  if v_basis in ('percent_of_freight','percent_off') and v_value > 100 then
    return jsonb_build_object('ok', false, 'error', 'percent_too_wide', 'asked', v_value, 'basis', v_basis,
      'message', v_value || '% is not a percentage. A figure above 100 on a percent basis takes the '
        || 'freight away twice.');
  end if;

  -- Presence-based, the way a driver's record is written: an absent half keeps the column and an
  -- explicit word in `p_clear` empties it. A draft whose ceiling can only ever be raised is a draft a
  -- clerk has to discard and re-open to fix.
  v_clears := array(select distinct lower(trim(w))
                      from regexp_split_to_table(coalesce(p_clear, ''), ',') w
                     where trim(w) <> '');
  foreach v_w in array v_clears loop
    if v_w not in ('cap','min_amount','max_uses','route','vehicle_class','container') then
      return jsonb_build_object('ok', false, 'error', 'bad_clear', 'asked', v_w,
        'message', 'Nothing on a charge is cleared by that word. It can empty: cap, min_amount, '
          || 'max_uses, route, vehicle_class, container.');
    end if;
  end loop;
  if 'max_uses' = any (v_clears) and v_kind.counted is false then
    return jsonb_build_object('ok', false, 'error', 'kind_is_not_counted', 'kind', v_kind.key,
      'message', 'A ' || v_kind.key || ' never had a ceiling on places to clear.');
  end if;

  v_before := jsonb_build_object('label', v_cur.label, 'basis', v_cur.basis,
    'value', v_cur.value::text, 'cap', v_cur.cap::text, 'min_amount', v_cur.min_amount::text,
    'max_uses', v_cur.max_uses, 'route_id', v_cur.route_id, 'vehicle_class', v_cur.vehicle_class,
    'container_type', v_cur.container_type, 'effective_from', v_cur.effective_from::text,
    'note', v_cur.note);

  update pricing_addenda
     set label = v_label,
         basis = v_basis,
         value = v_value,
         cap = case when 'cap' = any (v_clears) then null else coalesce(p_cap, cap) end,
         min_amount = case when 'min_amount' = any (v_clears) then null
                           else coalesce(p_min_amount, min_amount) end,
         max_uses = case when 'max_uses' = any (v_clears) then null
                         else coalesce(p_max_uses, max_uses) end,
         route_id = case when 'route' = any (v_clears) then null
                         else coalesce(p_route, route_id) end,
         vehicle_class = case when 'vehicle_class' = any (v_clears) then null
                              else coalesce(nullif(lower(trim(coalesce(p_vehicle_class, ''))), ''),
                                            vehicle_class) end,
         container_type = case when 'container' = any (v_clears) then null
                               else coalesce(nullif(lower(trim(coalesce(p_container, ''))), ''),
                                             container_type) end,
         effective_from = coalesce(p_effective_from, effective_from),
         note = v_note,
         updated_by = p_actor
   where id = v_cur.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_addenda', v_cur.id, 'pricing.addendum_edited', v_before,
    jsonb_build_object('ref', v_cur.ref, 'code', v_cur.code, 'kind', v_cur.kind, 'label', v_label,
      'basis', v_basis, 'value', v_value::text,
      'cap', case when 'cap' = any (v_clears) then null else coalesce(p_cap, v_cur.cap)::text end,
      'min_amount', case when 'min_amount' = any (v_clears) then null
                         else coalesce(p_min_amount, v_cur.min_amount)::text end,
      'max_uses', case when 'max_uses' = any (v_clears) then null
                       else coalesce(p_max_uses, v_cur.max_uses) end,
      'effective_from', coalesce(p_effective_from, v_cur.effective_from)::text,
      'cleared', v_clears, 'note', v_note, 'seat', v_seat));

  return platform_auth.pricing_addendum_detail(p_tenant, v_cur.id);
end $$;

-- A draft nobody signed is thrown away, not edited into something else: 140's rule for a card, and the
-- same reason. The audit line is the only thing that will remember the charge existed.
create or replace function platform_auth.discard_pricing_addendum(
  p_tenant uuid, p_addendum uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v pricing_addenda;
  v_reason text;
  v_claims int;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can discard a draft charge.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters why the draft is thrown away: the audit line is the only '
        || 'thing that will remember it existed.');
  end if;
  select * into v from pricing_addenda where id = p_addendum and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no charge with that number in this book.');
  end if;
  if v.status <> 'draft' or v.approval_id is not null or v.published_at is not null then
    return jsonb_build_object('ok', false, 'error', 'not_a_draft', 'ref', v.ref, 'status', v.status,
      'message', v.ref || ' is ' || v.status || ' and a signature '
        || case when v.approval_id is not null then 'stood' else 'never stood' end
        || ' on it. A paper that anyone was asked to sign is kept.');
  end if;

  -- A draft has never been live, so it has never been able to take a place: `claim_pricing_addendum`
  -- requires a published row. The count is the proof of that, and a draft that does carry claims is
  -- refused rather than swept, because the claims register is kept by trigger and a discard that deleted
  -- underneath it would be a discard that rewrote who got a discount.
  v_claims := (select count(*)::int from pricing_addendum_claims c where c.addendum_id = v.id);
  if v_claims > 0 then
    return jsonb_build_object('ok', false, 'error', 'places_taken', 'ref', v.ref, 'claims', v_claims,
      'message', v.ref || ' is a draft that ' || v_claims || ' place(s) were taken on, which is not a '
        || 'state this register makes. Withdraw it instead of discarding it, so the places keep their '
        || 'author.');
  end if;

  delete from pricing_addenda where id = v.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_addenda', v.id, 'pricing.addendum_discarded',
    jsonb_build_object('ref', v.ref, 'code', v.code, 'kind', v.kind, 'version', v.version,
      'status', v.status, 'claims', v_claims),
    jsonb_build_object('reason', v_reason, 'seat', v_seat, 'claims_removed', v_claims));

  return jsonb_build_object('ok', true, 'discarded', v.ref, 'code', v.code, 'kind', v.kind,
    'version', v.version, 'reason', v_reason,
    'message', v.ref || ' was thrown away. Nothing was charged and nothing was signed.');
end $$;

-- The one way a live charge changes: copy it forward, figure and all. This is also the rollback — clone
-- the old version, sign it, and it becomes the newest charge without a memory row being rewritten.
create or replace function platform_auth.clone_pricing_addendum(
  p_tenant uuid, p_addendum uuid, p_effective_from date, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_src pricing_addenda;
  v_new pricing_addenda;
  v_from date;
  v_note text;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can clone a charge.');
  end if;
  select * into v_src from pricing_addenda
    where id = p_addendum and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no charge with that number in this book.');
  end if;
  if v_src.status = 'draft' or v_src.status = 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'nothing_to_clone', 'ref', v_src.ref,
      'status', v_src.status,
      'message', v_src.ref || ' is still a ' || v_src.status || '. Clone a version that has been '
        || 'published, superseded or withdrawn — that is where the figures worth carrying are.');
  end if;
  v_from := coalesce(p_effective_from, current_date);
  if v_from < current_date then
    return jsonb_build_object('ok', false, 'error', 'back_dating', 'asked', v_from::text,
      'message', 'A new version starts today or later. A charge cannot be made valid for days that were '
        || 'already quoted under another one.');
  end if;
  v_note := trim(coalesce(p_note, coalesce(v_src.note, '')));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say in 8-600 characters what this version is for.');
  end if;

  insert into pricing_addenda (id, tenant_id, ref, code, kind, label, currency, status, version,
    basis, value, cap, min_amount, max_uses, route_id, vehicle_class, container_type,
    effective_from, note, supersedes_id, created_by, updated_by)
  select gen_random_uuid(), p_tenant,
         k.prefix || '-' || to_char(now(), 'YYYY') || '-'
                       || lpad(nextval('pricing_addendum_number_seq')::text, 5, '0'),
         s.code, s.kind, s.label, s.currency, 'draft',
         (select max(a.version) from pricing_addenda a
           where a.tenant_id = p_tenant and a.code = s.code) + 1,
         s.basis, s.value, s.cap, s.min_amount, s.max_uses, s.route_id, s.vehicle_class,
         s.container_type, v_from, v_note, s.id, p_actor, p_actor
    from pricing_addenda s
    join pricing_addendum_kinds k on k.key = s.kind
   where s.id = v_src.id
  returning * into v_new;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_addenda', v_new.id, 'pricing.addendum_cloned',
    jsonb_build_object('ref', v_src.ref, 'code', v_src.code, 'kind', v_src.kind,
      'version', v_src.version, 'status', v_src.status, 'value', v_src.value::text),
    jsonb_build_object('ref', v_new.ref, 'code', v_new.code, 'kind', v_new.kind,
      'version', v_new.version, 'value', v_new.value::text, 'basis', v_new.basis,
      'max_uses', v_new.max_uses, 'effective_from', v_new.effective_from::text,
      'note', v_new.note, 'seat', v_seat));

  return platform_auth.pricing_addendum_detail(p_tenant, v_new.id);
end $$;

-- ============================================================
-- 9. the signature
-- ============================================================

-- A fourth action name in 121's register, and a deliberate one: `approvals_one_open` is keyed on
-- (action, target_kind, target_id), so a price list and a charge could not share `pricing.publish`
-- without two different papers colliding on one row. 121 says a kind with no apply path is a signature
-- that can never be spent, so `apply_pricing_addendum` below is the matching effect and
-- `api/src/control/approvals.ts` names it.
create or replace function platform_auth.propose_pricing_addendum(
  p_tenant uuid, p_addendum uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v pricing_addenda;
  v_reason text;
  v_paper jsonb;
  v_sha text;
  v_id uuid;
  v_open uuid;
  v_taken int;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can ask for a charge to be signed.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'The reason must be 8-600 characters: it is the sentence the second seat signs.');
  end if;
  select * into v from pricing_addenda where id = p_addendum and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no charge with that number in this book.');
  end if;
  if v.status = 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'already_open', 'ref', v.ref,
      'approval_id', v.approval_id,
      'message', v.ref || ' is already waiting for a second seat. Refuse that paper first.');
  end if;
  if v.published_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_lived', 'ref', v.ref,
      'message', v.ref || ' has been a live charge. Clone it forward — a version that was signed is not '
        || 'signed twice.');
  end if;
  if v.status <> 'draft' then
    return jsonb_build_object('ok', false, 'error', 'not_a_draft', 'ref', v.ref, 'status', v.status,
      'message', 'Only a draft can be put up for a signature.');
  end if;

  if v.effective_from is null then
    return jsonb_build_object('ok', false, 'error', 'no_start', 'ref', v.ref,
      'message', v.ref || ' has no start date, so the composer could never tell which day it stood on '
        || 'a job.');
  end if;
  -- A ceiling that is already reached is not a promo the office can put live: the second seat would be
  -- signing a code that refuses the first clerk who types it.
  v_taken := platform_auth.pricing_addendum_uses_taken(v.id);
  if v.max_uses is not null and v_taken >= v.max_uses then
    return jsonb_build_object('ok', false, 'error', 'already_spent', 'ref', v.ref,
      'uses_taken', v_taken, 'max_uses', v.max_uses,
      'message', v.ref || ' already has ' || v_taken || ' of its ' || v.max_uses || ' places taken. A '
        || 'code that cannot be given is not a thing to sign; clone it with a new ceiling.');
  end if;

  v_paper := platform_auth.pricing_addendum_paper(v.id);
  v_sha := encode(extensions.digest(v_paper::text, 'sha256'), 'hex');

  begin
    insert into platform_approvals (id, action, target_kind, target_id, payload, payload_sha256,
        reason, status, proposed_by, proposed_role, proposed_ip, proposed_ua, expires_at)
    values (gen_random_uuid(), 'pricing.addendum', 'pricing_addendum', v.id::text, v_paper, v_sha,
        v_reason, 'pending', p_actor, p_role, p_ip,
        left(coalesce(p_ua, ''), 300), now() + interval '7 days')
    returning id into v_id;
  exception when unique_violation then
    select a.id into v_open from platform_approvals a
     where a.action = 'pricing.addendum' and a.target_kind = 'pricing_addendum'
       and a.target_id = v.id::text and a.status = 'pending'
     order by a.created_at desc limit 1;
    return jsonb_build_object('ok', false, 'error', 'already_open', 'open_id', v_open,
      'message', 'A signature for this version is already open and waiting for a second seat.');
  end;

  update pricing_addenda
     set status = 'pending_signature', approval_id = v_id, updated_by = p_actor
   where id = v.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_addenda', v.id, 'pricing.addendum_publish_proposed',
    jsonb_build_object('status', v.status, 'approval_id', v.approval_id),
    jsonb_build_object('ref', v.ref, 'code', v.code, 'kind', v.kind, 'version', v.version,
      'label', v.label, 'basis', v.basis, 'value', v.value::text, 'cap', v.cap::text,
      'min_amount', v.min_amount::text, 'max_uses', v.max_uses, 'uses_taken', v_taken,
      'currency', v.currency, 'scope', platform_auth.pricing_addendum_said(v),
      'effective_from', v.effective_from::text, 'reason', v_reason,
      'payload_sha256', v_sha, 'approval_id', v_id, 'seat', v_seat,
      'expires_at', to_char(now() + interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));

  return jsonb_build_object('ok', true, 'approval_id', v_id, 'action', 'pricing.addendum',
    'target_kind', 'pricing_addendum', 'target_id', v.id, 'ref', v.ref, 'kind', v.kind,
    'version', v.version, 'value', v.value::text, 'basis', v.basis, 'currency', v.currency,
    'payload_sha256', v_sha,
    'addendum', platform_auth.pricing_addendum_detail(p_tenant, v.id));
end $$;

create or replace function platform_auth.refuse_pricing_addendum(
  p_tenant uuid, p_addendum uuid, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v pricing_addenda;
  v_a platform_approvals%rowtype;
  v_note text;
  v_dec jsonb;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can refuse a paper.');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say why in 8-600 characters: it is the sentence the next version answers.');
  end if;
  select * into v from pricing_addenda where id = p_addendum and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no charge with that number in this book.');
  end if;
  if v.status <> 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'nothing_open', 'ref', v.ref, 'status', v.status,
      'message', 'No signature is standing on ' || v.ref || '. Refusing a charge the office never asked '
        || 'anyone to sign is not a thing a register can record.');
  end if;

  select * into v_a from platform_approvals where id = v.approval_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'approval_missing',
      'message', 'The paper ' || v.ref || ' points at is gone. Say so on Approvals, not here.');
  end if;
  if v_a.status = 'pending' then
    v_dec := platform_auth.decide_approval(v_a.id, 'reject', v_note, p_actor, p_role, p_ip,
      left(coalesce(p_ua, ''), 300));
    if v_dec ->> 'status' <> 'ok' then
      return jsonb_build_object('ok', false, 'error', 'refused_the_signature_first',
        'message', 'The signature was not answered: '
          || coalesce(v_dec ->> 'message', v_dec ->> 'status'),
        'approval_answer', v_dec);
    end if;
  elsif v_a.status not in ('lapsed','rejected') then
    return jsonb_build_object('ok', false, 'error', 'already_signed', 'approval_status', v_a.status,
      'message', 'The signature on ' || v.ref || ' was released. A charge that has been signed is spent '
        || 'on Approvals or withdrawn from this desk — it is not refused from here.');
  end if;

  update pricing_addenda
     set status = 'draft', refusals = refusals + 1, updated_by = p_actor
   where id = v.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_addenda', v.id, 'pricing.addendum_publish_refused',
    jsonb_build_object('status', v.status, 'approval_id', v_a.id, 'paper_sha256', v_a.payload_sha256),
    jsonb_build_object('ref', v.ref, 'code', v.code, 'kind', v.kind, 'version', v.version,
      'value', v.value::text, 'note', v_note, 'refusals', v.refusals + 1, 'seat', v_seat,
      'proposed_by', (select u.full_name from users u where u.id = v_a.proposed_by)));

  return jsonb_build_object('ok', true,
    'addendum', platform_auth.pricing_addendum_detail(p_tenant, v.id),
    'refusals', v.refusals + 1, 'approval_id', v_a.id);
end $$;

-- Spend the signature and put the charge in force.
--
-- Called inside the same transaction as `decide_approval` and `claim_approval`, in 121's order, and it
-- expects the paper already spent by the seat calling it. The bytes are rebuilt from the row before a
-- single column moves: a figure typed in the seven days a paper waited is refused here rather than
-- charged under a signature that never described it.
create or replace function platform_auth.apply_pricing_addendum(
  p_approval_id uuid, p_actor_user_id uuid, p_actor_role text, p_actor_ip text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a       platform_approvals%rowtype;
  v         pricing_addenda;
  v_old     pricing_addenda;
  v_paper   jsonb;
  v_close_to date;
  v_to      date;
  v_seated  int;
  v_taken   int;
  v_said    text;
begin
  select * into v_a from platform_approvals where id = p_approval_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no signature with that number.');
  end if;
  if v_a.action <> 'pricing.addendum' or v_a.target_kind <> 'pricing_addendum' then
    return jsonb_build_object('ok', false, 'error', 'not_a_charge',
      'message', 'That signature is not a publish of a surcharge or a promo code.');
  end if;
  if v_a.status <> 'applied' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'approval_status', v_a.status,
      'message', 'The signature was not spent by this call.');
  end if;
  if v_a.decided_by <> p_actor_user_id then
    return jsonb_build_object('ok', false, 'error', 'unauthorised',
      'message', 'Only the seat that released a signature may spend it.');
  end if;

  select * into v from pricing_addenda where id = v_a.target_id::uuid for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'The charge this signature was cut on is no longer in the book.');
  end if;
  if v.status <> 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'status', v.status, 'ref', v.ref,
      'message', v.ref || ' is not waiting for that signature any more.');
  end if;

  v_paper := platform_auth.pricing_addendum_paper(v.id);
  if encode(extensions.digest(v_paper::text, 'sha256'), 'hex') <> v_a.payload_sha256 then
    return jsonb_build_object('ok', false, 'error', 'paper_moved', 'ref', v.ref,
      'signed_sha256', v_a.payload_sha256,
      'message', 'The figure on ' || v.ref || ' is not the one that was signed. Nothing was put in '
        || 'force; the version has to be signed again.');
  end if;
  if v.effective_from is null then
    return jsonb_build_object('ok', false, 'error', 'no_start', 'ref', v.ref,
      'message', v.ref || ' lost its start date. A charge with no day cannot go live.');
  end if;
  v_taken := platform_auth.pricing_addendum_uses_taken(v.id);
  if v.max_uses is not null and v_taken >= v.max_uses then
    return jsonb_build_object('ok', false, 'error', 'already_spent', 'ref', v.ref,
      'uses_taken', v_taken, 'max_uses', v.max_uses,
      'message', v.ref || ' ran out of places while its paper waited. The signature is not spent on a '
        || 'code nobody can be given.');
  end if;

  -- 140's ordering, kept exactly: the window the previous version was valid for closes the day before
  -- the new one starts, and only then is the new one published — otherwise the overlap guard sees the
  -- collision it is being asked to create and refuses the publish it is standing for.
  v_close_to := v.effective_from - 1;
  v_seated := 0;
  for v_old in
    select * from pricing_addenda
     where tenant_id = v.tenant_id and code = v.code
       and status = 'published' and id <> v.id
       and effective_from <= v.effective_from
       and coalesce(effective_to, date 'infinity') >= v.effective_from
     order by effective_from desc
  loop
    v_to := greatest(least(coalesce(v_old.effective_to, date 'infinity'), v_close_to),
                     v_old.effective_from);
    v_said := platform_auth.pricing_addendum_said(v_old);

    update pricing_addenda
       set status = 'superseded', effective_to = v_to
     where id = v_old.id;

    insert into pricing_addendum_history (tenant_id, addendum_id, what, said, old_value, new_value,
        currency, reason, actor_user_id, actor_role, approval_id)
    values (v.tenant_id, v_old.id, 'window', v_said, v_old.effective_to::text, v_to::text,
        v_old.currency,
        'Closed by ' || v.ref || ' version ' || v.version || ', which this signature published.',
        p_actor_user_id, p_actor_role, v_a.id);
    insert into pricing_addendum_history (tenant_id, addendum_id, what, said, old_value, new_value,
        currency, reason, actor_user_id, actor_role, approval_id)
    values (v.tenant_id, v_old.id, 'state', v_said, 'published', 'superseded', v_old.currency,
        'Replaced by ' || v.ref || ' version ' || v.version || '.',
        p_actor_user_id, p_actor_role, v_a.id);
    v_seated := v_seated + 1;
  end loop;

  update pricing_addenda
     set status = 'published', published_by = p_actor_user_id, published_at = now(),
         published_note = v_a.reason, updated_by = p_actor_user_id
   where id = v.id;

  insert into pricing_addendum_history (tenant_id, addendum_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role, approval_id)
  values (v.tenant_id, v.id, 'figure', platform_auth.pricing_addendum_said(v), null,
      v.value::text, v.currency,
      'In force as a ' || v.kind || ' on the ' || v.basis || ' basis from '
        || v.effective_from::text || '.',
      p_actor_user_id, p_actor_role, v_a.id);
  insert into pricing_addendum_history (tenant_id, addendum_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role, approval_id)
  values (v.tenant_id, v.id, 'state', platform_auth.pricing_addendum_said(v), 'pending_signature',
      'published', v.currency,
      'Signed by ' || coalesce((select u.full_name from users u where u.id = v_a.decided_by),
                               'a second seat')
        || ' and effective from ' || v.effective_from::text || '.',
      p_actor_user_id, p_actor_role, v_a.id);

  perform platform_auth.money_audit(v.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip, null,
    'pricing_addenda', v.id, 'pricing.addendum_published',
    jsonb_build_object('status', v.status, 'approval_id', v.approval_id, 'value', v.value::text),
    jsonb_build_object('ref', v.ref, 'code', v.code, 'kind', v.kind, 'version', v.version,
      'basis', v.basis, 'value', v.value::text, 'cap', v.cap::text,
      'min_amount', v.min_amount::text, 'max_uses', v.max_uses, 'uses_taken', v_taken,
      'currency', v.currency, 'scope', platform_auth.pricing_addendum_said(v),
      'effective_from', v.effective_from::text, 'superseded_versions', v_seated,
      'payload_sha256', v_a.payload_sha256, 'approval_id', v_a.id,
      'signed_by', (select u.full_name from users u where u.id = v_a.decided_by),
      'proposed_by', (select u.full_name from users u where u.id = v_a.proposed_by)));

  return jsonb_build_object('ok', true, 'addendum_id', v.id, 'ref', v.ref, 'code', v.code,
    'kind', v.kind, 'version', v.version, 'basis', v.basis, 'value', v.value::text,
    'currency', v.currency, 'max_uses', v.max_uses, 'uses_taken', v_taken,
    'effective_from', v.effective_from::text, 'superseded_versions', v_seated,
    'approval_id', v_a.id, 'published_by', p_actor_user_id,
    'addendum', platform_auth.pricing_addendum_detail(v.tenant_id, v.id));
end $$;

-- ============================================================
-- 10. the stop
-- ============================================================

-- One seat, dated forward, fully explained, never a delete: 140's argument holds unchanged for a levy
-- and for a code. What a one-seat withdrawal may not do is rewrite history — it sets an end date no
-- earlier than today, so it stops the charge going forward and never un-charges a job already billed.
-- For a promo the date also stops *new* places, because the composer only reads published rows whose
-- window covers the day it is asked about.
create or replace function platform_auth.withdraw_pricing_addendum(
  p_tenant uuid, p_addendum uuid, p_effective_to date, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v pricing_addenda;
  v_reason text;
  v_to date;
  v_taken int;
  v_said text;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can stop a charge.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters why the charge stops: this is the sentence a customer is '
        || 'answered with.');
  end if;
  select * into v from pricing_addenda where id = p_addendum and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no charge with that number in this book.');
  end if;
  if v.status <> 'published' then
    return jsonb_build_object('ok', false, 'error', 'not_live', 'ref', v.ref, 'status', v.status,
      'message', v.ref || ' is ' || v.status || '. There is nothing to stop.');
  end if;
  v_to := coalesce(p_effective_to, current_date);
  if v_to < current_date then
    return jsonb_build_object('ok', false, 'error', 'rewriting_history', 'asked', v_to::text,
      'message', 'A charge stops today or later. Stopping it before a day that has already passed would '
        || 'un-charge jobs the office may have billed under ' || v.ref || '.');
  end if;
  if v.effective_from > v_to then
    return jsonb_build_object('ok', false, 'error', 'empty_window', 'ref', v.ref,
      'message', v.ref || ' starts ' || v.effective_from::text || ', after the day you are stopping it '
        || 'on. Supersede it with the version that replaces it instead.');
  end if;

  v_said := platform_auth.pricing_addendum_said(v);

  update pricing_addenda
     set status = 'withdrawn', effective_to = v_to, withdrawn_by = p_actor, withdrawn_at = now(),
         withdrawn_reason = v_reason, updated_by = p_actor
   where id = v.id;

  insert into pricing_addendum_history (tenant_id, addendum_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role)
  values (p_tenant, v.id, 'window', v_said, v.effective_to::text, v_to::text, v.currency,
      v_reason, p_actor, p_role);
  insert into pricing_addendum_history (tenant_id, addendum_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role)
  values (p_tenant, v.id, 'state', v_said, 'published', 'withdrawn', v.currency,
      v_reason, p_actor, p_role);

  v_taken := platform_auth.pricing_addendum_uses_taken(v.id);
  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_addenda', v.id, 'pricing.addendum_withdrawn',
    jsonb_build_object('status', v.status, 'effective_to', v.effective_to::text),
    jsonb_build_object('ref', v.ref, 'code', v.code, 'kind', v.kind, 'version', v.version,
      'value', v.value::text, 'effective_to', v_to::text, 'uses_taken', v_taken,
      'reason', v_reason, 'seat', v_seat));

  return platform_auth.pricing_addendum_detail(p_tenant, v.id);
end $$;

-- ============================================================
-- 11. the places: why a promo can run out in the register and not in a client
-- ============================================================

-- The ceiling is only a fact if the count that reads it is the count that writes it. This door takes the
-- place, refuses a second one for the same subject through the partial unique index, and writes the
-- memory row in the same statement — so "12 of 200 taken" is true at the minute a clerk says it out
-- loud, and the number the composer refused on is the number the desk shows.
create or replace function platform_auth.claim_pricing_addendum(
  p_tenant uuid, p_addendum uuid, p_subject_kind text, p_subject_id uuid, p_job_ref text,
  p_freight numeric, p_taken numeric, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_kind pricing_addendum_kinds;
  v pricing_addenda;
  v_subject text;
  v_note text;
  v_job text;
  v_taken int;
  v_claim_id uuid;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can take a place on a charge.');
  end if;
  select * into v from pricing_addenda
    where id = p_addendum and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no charge with that number in this book.');
  end if;
  select * into v_kind from pricing_addendum_kinds where key = v.kind;
  v_subject := lower(trim(coalesce(p_subject_kind, '')));
  if v_subject not in ('tenant','customer','user','vehicle','driver') then
    return jsonb_build_object('ok', false, 'error', 'bad_subject_kind', 'asked', p_subject_kind,
      'message', 'A place is taken by a tenant, a customer, a user, a vehicle or a driver. Say which, so '
        || 'the register can tell a second claim from a different door.');
  end if;
  if p_subject_id is null then
    return jsonb_build_object('ok', false, 'error', 'bad_subject_id',
      'message', 'Name the account, company, person, vehicle or driver the place was taken for.');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if v_note <> '' and char_length(v_note) < 8 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'A note on a claim is either nothing or a sentence the office can defend — 8 characters '
        || 'at least.');
  end if;
  v_job := nullif(trim(coalesce(p_job_ref, '')), '');
  if v_job is not null and char_length(v_job) < 3 then
    return jsonb_build_object('ok', false, 'error', 'bad_job_ref', 'asked', p_job_ref,
      'message', 'A job reference is the number a clerk would read off the file — 3 characters at least.');
  end if;

  -- The window is checked here as well as in the composer, because the desk takes a place the day the
  -- job is booked and a code stopped last week must not gain a place today through a door that did not
  -- look at the calendar.
  if v.status <> 'published' then
    return jsonb_build_object('ok', false, 'error', 'not_live', 'ref', v.ref, 'status', v.status,
      'message', 'A place is only taken on a ' || v_kind.key || ' that is in force. ' || v.ref
        || ' is ' || v.status || '.');
  end if;
  if not v_kind.counted then
    return jsonb_build_object('ok', false, 'error', 'kind_is_not_counted', 'kind', v_kind.key,
      'ref', v.ref,
      'message', v.ref || ' is a ' || v_kind.key || ': it stands on every job it matches, so it has no '
        || 'places to take.');
  end if;
  if v.effective_from > current_date
     or coalesce(v.effective_to, date 'infinity') < current_date then
    return jsonb_build_object('ok', false, 'error', 'promo_lapsed', 'ref', v.ref,
      'effective_from', v.effective_from::text, 'effective_to', v.effective_to::text,
      'message', v.ref || ' is not standing on today. Its window is ' || v.effective_from::text
        || case when v.effective_to is null then ' and open'
                else ' to ' || v.effective_to::text end || '.');
  end if;

  v_taken := platform_auth.pricing_addendum_uses_taken(v.id);
  if v.max_uses is not null and v_taken >= v.max_uses then
    return jsonb_build_object('ok', false, 'error', 'promo_spent', 'ref', v.ref,
      'uses_taken', v_taken, 'max_uses', v.max_uses,
      'message', v.ref || ' has given all ' || v.max_uses || ' of its places away. The discount is '
        || 'spent, not hidden — say so to the customer rather than trying twice.');
  end if;

  begin
    insert into pricing_addendum_claims (id, tenant_id, addendum_id, subject_kind, subject_id,
        job_ref, freight, taken, currency, note, claimed_by, claimed_role)
    values (gen_random_uuid(), p_tenant, v.id, v_subject, p_subject_id,
        v_job, p_freight, p_taken, v.currency, nullif(v_note, ''), p_actor, p_role)
    returning id into v_claim_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already_claimed', 'ref', v.ref,
      'subject_kind', v_subject, 'subject_id', p_subject_id,
      'message', 'This ' || v_subject || ' already holds a place on ' || v.ref || '. A code is given '
        || 'once; the row that says so is kept, so try a different charge or void the first claim.');
  end;

  insert into pricing_addendum_history (tenant_id, addendum_id, claim_id, what, said, old_value,
      new_value, currency, reason, actor_user_id, actor_role)
  values (p_tenant, v.id, v_claim_id, 'claim', v_subject || ' ' || left(p_subject_id::text, 8)
      || case when v_job is null then '' else ' / ' || v_job end,
      v_taken::text, (v_taken + 1)::text, v.currency,
      coalesce(nullif(v_note, ''), 'Place taken on ' || v.ref || ' for a ' || v_subject || '.'),
      p_actor, p_role);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_addendum_claims', v_claim_id, 'pricing.addendum_claimed',
    jsonb_build_object('uses_taken', v_taken),
    jsonb_build_object('ref', v.ref, 'code', v.code, 'kind', v.kind, 'claim_id', v_claim_id,
      'subject_kind', v_subject, 'subject_id', p_subject_id, 'job_ref', v_job,
      'freight', p_freight::text, 'taken', p_taken::text, 'currency', v.currency,
      'uses_taken', v_taken + 1, 'max_uses', v.max_uses, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'claim_id', v_claim_id, 'ref', v.ref, 'code', v.code,
    'uses_taken', v_taken + 1, 'max_uses', v.max_uses,
    'addendum', platform_auth.pricing_addendum_detail(p_tenant, v.id),
    'message', 'Took place ' || (v_taken + 1) || case when v.max_uses is null then ''
             else ' of ' || v.max_uses end || ' on ' || v.ref || '.');
end $$;

-- The correction, and the only change a claim row can undergo. It loses its place: the count drops, the
-- subject may be given a place again, and the row that proves the mistake happened and who cancelled it
-- stays, which is the whole reason a void is not a delete.
create or replace function platform_auth.void_pricing_addendum_claim(
  p_tenant uuid, p_claim uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_c pricing_addendum_claims;
  v pricing_addenda;
  v_reason text;
  v_taken int;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can give a place back.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters why the place is given back: a void without a reason is the '
        || 'same as a delete with extra steps.');
  end if;
  select * into v_c from pricing_addendum_claims
    where id = p_claim and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'No place was taken in this book under that number.');
  end if;
  if v_c.voided_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_voided',
      'message', 'That place was given back on ' || to_char(v_c.voided_at, 'YYYY-MM-DD') || ' by '
        || coalesce((select u.full_name from users u where u.id = v_c.voided_by), 'a seat') || '.');
  end if;
  select * into v from pricing_addenda where id = v_c.addendum_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'The charge this place was taken on is no longer in the book.');
  end if;

  v_taken := platform_auth.pricing_addendum_uses_taken(v.id);

  update pricing_addendum_claims
     set voided_at = now(), voided_by = p_actor, void_reason = v_reason
   where id = v_c.id;

  insert into pricing_addendum_history (tenant_id, addendum_id, claim_id, what, said, old_value,
      new_value, currency, reason, actor_user_id, actor_role)
  values (p_tenant, v.id, v_c.id, 'void', v_c.subject_kind || ' ' || left(v_c.subject_id::text, 8)
      || case when v_c.job_ref is null then '' else ' / ' || v_c.job_ref end,
      v_taken::text, (v_taken - 1)::text, v.currency, v_reason, p_actor, p_role);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_addendum_claims', v_c.id, 'pricing.addendum_claim_voided',
    jsonb_build_object('voided_at', v_c.voided_at, 'uses_taken', v_taken),
    jsonb_build_object('ref', v.ref, 'code', v.code, 'claim_id', v_c.id,
      'subject_kind', v_c.subject_kind, 'subject_id', v_c.subject_id, 'job_ref', v_c.job_ref,
      'uses_taken', v_taken - 1, 'reason', v_reason, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'claim_id', v_c.id, 'ref', v.ref,
    'uses_taken', v_taken - 1, 'max_uses', v.max_uses,
    'addendum', platform_auth.pricing_addendum_detail(p_tenant, v.id),
    'message', 'Gave the place back. ' || v.ref || ' now counts ' || (v_taken - 1)
      || case when v.max_uses is null then '' else ' of ' || v.max_uses end || ' taken.');
end $$;

-- ============================================================
-- 12. the composer: a freight quote with the charges on top of it
-- ============================================================

-- 140's simulator answers one question — what does the freight cost — and a quote is not the freight. A
-- fuel levy stands on it, a handling charge is added per tonne beside it, and a code a customer was given
-- takes money off the sum. This door is a composer: it calls `price_a_freight` and adds lines to the
-- working that came back, rather than editing 140's arithmetic, so there is still exactly one place in the
-- register where a freight figure is worked out.
--
-- Three rules a simpler sum would not keep:
--
-- Currency is bound at the freight, not at the total. A TZS levy can never be added to a quote a USD card
-- answered. 138 found this exact defect in a count that summed another money's figures; the fix one table
-- earlier is to refuse the pairing where it is formed instead of printing a number that means two things.
--
-- The sign is the kind's, read off the row. The loop keeps anything whose kind carries +1 and names
-- anything whose kind carries -1, so the third word somebody adds to `pricing_addendum_kinds` in section 1
-- is priced by this body without a line of it being edited — which is the promise that comment makes.
--
-- The composer takes no place. It reports how many places a code has left and refuses one that is spent,
-- because a quotation is not a booking: two quotes of the same code for the same customer must not spend
-- each other, and only `claim_pricing_addendum` says out loud that a place is gone.
create or replace function platform_auth.price_a_job(
  p_tenant uuid, p_day date, p_code text, p_route uuid, p_vehicle_class text, p_container text,
  p_basis text, p_tonnes numeric, p_teu int, p_cbm numeric, p_days int, p_promo_codes text
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_hit jsonb;
  v_day date;
  v_cur text;
  v_freight numeric;
  v_payable numeric;
  v_total numeric;
  v_off numeric := 0;
  v_dist int;
  v_in_force jsonb;
  v_row record;
  v_pick jsonb;
  v_found pricing_addenda;
  v_sign_kind int;
  v_is_live boolean;
  v_x jsonb;
  v_ref text;
  v_code text;
  v_btext text;
  v_value numeric;
  v_cap numeric;
  v_minq numeric;
  v_raw numeric;
  v_max int;
  v_taken int;
  v_capped boolean := false;
  v_held boolean := false;
  v_clipped boolean := false;
  v_stated boolean := false;
  v_extras jsonb := '[]'::jsonb;
  v_discounts jsonb := '[]'::jsonb;
  v_codes text;
  v_ncodes int;
  v_working text;
begin
  v_day := coalesce(p_day, current_date);
  v_hit := platform_auth.price_a_freight(p_tenant, v_day, p_code, p_route, p_vehicle_class,
    p_container, p_basis, p_tonnes, p_teu, p_cbm, p_days);
  -- 140's words stay 140's: no price, no quote, and the clerk reads the sentence its own author wrote.
  if v_hit ->> 'ok' <> 'true' then
    return v_hit;
  end if;

  v_freight := (v_hit ->> 'amount')::numeric;
  v_cur := v_hit ->> 'currency';
  v_payable := v_freight;
  v_total := v_freight;
  v_working := v_hit ->> 'working';

  -- The job's quantities, resolved once for the whole loop. 140's simulator only ever needed the one its
  -- own price multiplies by; a stack of standing charges can ask for several, and each one that the job
  -- does not carry is refused in 140's own words.
  v_dist := (select r.distance_km from routes r where r.id = p_route and r.tenant_id = p_tenant);

  v_in_force := platform_auth.pricing_addenda_in_force(p_tenant, v_day, null, null, p_route,
    p_vehicle_class, p_container);

  -- Everything that stands on the job whether anybody names it or not.
  for v_row in select x from jsonb_array_elements(v_in_force -> 'rows') x
   where (x ->> 'sign')::int = 1
  loop
    v_x := v_row.x;
    v_ref := v_x ->> 'ref';
    if v_x ->> 'currency' <> v_cur then
      return jsonb_build_object('ok', false, 'error', 'money_mismatch', 'addendum', v_ref,
        'asked', v_x ->> 'currency', 'card', v_cur,
        'message', v_ref || ' is written in ' || (v_x ->> 'currency') || ' and '
          || (v_hit #>> '{card,ref}') || ' answers in ' || v_cur || '. Two moneys cannot be added into one '
          || 'figure — withdraw the charge or price the freight in its money.');
    end if;
    v_btext := v_x ->> 'basis';
    v_value := (v_x ->> 'value')::numeric;
    v_cap := nullif(v_x ->> 'cap', '')::numeric;
    v_minq := nullif(v_x ->> 'min_amount', '')::numeric;
    v_capped := false;
    v_held := false;

    if v_btext = 'percent_of_freight' then
      v_raw := round(v_freight * v_value / 100, 2);
    elsif v_btext in ('flat', 'per_trip') then
      v_raw := v_value;
    elsif v_btext = 'per_km' then
      if v_dist is null then
        return jsonb_build_object('ok', false, 'error', 'no_distance', 'addendum', v_ref,
          'route', p_route,
          'message', case when p_route is null
            then v_ref || ' is per kilometre and no corridor was named, so there is nothing to multiply. '
              || 'Say which route the job runs.'
            else v_ref || ' is per kilometre and the route has no distance on file, so there is nothing to '
              || 'multiply. File the corridor with its distance on the pricing desk first.' end);
      end if;
      v_raw := v_value * v_dist;
    elsif v_btext = 'per_tonne' then
      if p_tonnes is null or p_tonnes <= 0 then
        return jsonb_build_object('ok', false, 'error', 'no_tonnes', 'addendum', v_ref,
          'message', v_ref || ' is a per-tonne charge and the job carries no tonnage.');
      end if;
      v_raw := v_value * p_tonnes;
    elsif v_btext = 'per_teu' then
      if p_teu is null or p_teu <= 0 then
        return jsonb_build_object('ok', false, 'error', 'no_teu', 'addendum', v_ref,
          'message', v_ref || ' is a per-container charge and the job names no containers.');
      end if;
      v_raw := v_value * p_teu;
    elsif v_btext = 'per_cbm' then
      if p_cbm is null or p_cbm <= 0 then
        return jsonb_build_object('ok', false, 'error', 'no_cbm', 'addendum', v_ref,
          'message', v_ref || ' is a per-cubic-metre charge and the job carries no volume.');
      end if;
      v_raw := v_value * p_cbm;
    elsif v_btext = 'per_day' then
      if p_days is null or p_days <= 0 then
        return jsonb_build_object('ok', false, 'error', 'no_days', 'addendum', v_ref,
          'message', v_ref || ' is a per-day charge and the job runs no days.');
      end if;
      v_raw := v_value * p_days;
    else
      -- A basis that reaches here is a word section 1 allowed onto a kind this body was never told how to
      -- multiply. Answering with a charge silently left out of the total is the worse failure.
      return jsonb_build_object('ok', false, 'error', 'unknown_basis', 'addendum', v_ref,
        'basis', v_btext,
        'message', 'This register does not know how to multiply a ' || v_btext || ' charge (' || v_ref
          || '). Say what the composer should do with it before it is put live.');
    end if;

    if v_cap is not null and v_raw > v_cap then
      v_raw := v_cap;
      v_capped := true;
    end if;
    if v_minq is not null and v_raw < v_minq then
      v_raw := v_minq;
      v_held := true;
    end if;
    v_raw := round(v_raw, 2);

    v_payable := v_payable + v_raw;
    v_working := v_working
      -- 140's working prints the multiplication, not its answer, because on its own the answer is the
      -- figure beside it. Once a charge is added, the sum has to be readable: a clerk who reads
      -- "985 km at 4 250 + 250 000 = 4 436 250" is doing arithmetic the register was asked to do.
      || case when v_stated then ''
              else ' = ' || trim(to_char(v_freight, 'FM99999999999999999990.00')) || ' ' || v_cur end
      || ' + ' || v_ref || ' ' || (v_x ->> 'label') || ' '
      || trim(to_char(v_raw, 'FM999999999990.00'))
      || case when v_capped then ' (held to its own ceiling)'
              when v_held then ' (held up to its own floor)'
              else '' end;
    v_stated := true;
    v_extras := v_extras || jsonb_build_array(jsonb_build_object(
      'id', (v_x ->> 'id')::uuid, 'ref', v_ref, 'code', v_x ->> 'code', 'kind', v_x ->> 'kind',
      'label', v_x ->> 'label', 'basis', v_btext, 'value', v_x ->> 'value',
      'amount', trim(to_char(v_raw, 'FM99999999999999999990.00')),
      'capped', v_capped, 'floor_applied', v_held, 'cap', v_x ->> 'cap',
      'min_amount', v_x ->> 'min_amount', 'scope', v_x ->> 'scope',
      'effective_from', v_x ->> 'effective_from'));
  end loop;

  -- Anything that only takes money off when a clerk names it.
  select count(*)::int into v_ncodes
    from (select distinct upper(trim(x)) as c
            from unnest(string_to_array(coalesce(p_promo_codes, ''), ',')) x
           where trim(x) <> '') d;
  if v_ncodes > 5 then
    return jsonb_build_object('ok', false, 'error', 'too_many_codes', 'asked', v_ncodes,
      'message', 'A quote carries at most five codes. A customer given more than that is being given a '
        || 'discount, not an offer, and the office cannot say which of them it honoured.');
  end if;

  for v_row in select c from (select upper(trim(x)) as c, o,
                              row_number() over (partition by upper(trim(x)) order by o) as rn
                         from unnest(string_to_array(coalesce(p_promo_codes, ''), ','))
                              with ordinality as t(x, o)) q
   where q.rn = 1 and q.c <> ''
   order by q.o
  loop
    v_code := v_row.c;
    select x into v_pick
      from jsonb_array_elements(v_in_force -> 'rows') x
     where x ->> 'code' = v_code and (x ->> 'sign')::int = -1
     limit 1;

    if v_pick is null then
      -- The code is not live on this job. Which of four things that means is worth saying precisely,
      -- because a clerk reading "unknown" will go looking for a typing mistake and a clerk reading
      -- "lapsed" will go and ask for the dates.
      -- A version that stands on the day is looked for before a later one that does not, so the sentence
      -- below can tell a lapsed code from a code filed against another corridor.
      select a.* into v_found from pricing_addenda a
       where a.tenant_id = p_tenant and a.code = v_code and a.status = 'published'
       order by (a.effective_from <= v_day
                 and coalesce(a.effective_to, date 'infinity') >= v_day) desc,
                a.version desc limit 1;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'promo_unknown', 'code', v_code,
          'message', 'This book has never published a code called ' || v_code || '. Check the typing — a '
            || 'code is read off a printed quote by a clerk on a phone.');
      end if;
      v_is_live := (v_found.effective_from <= v_day
                    and coalesce(v_found.effective_to, date 'infinity') >= v_day);
      v_sign_kind := (select k.sign from pricing_addendum_kinds k where k.key = v_found.kind);
      if v_sign_kind = 1 then
        return jsonb_build_object('ok', false, 'error', 'promo_wrong_kind', 'code', v_code,
          'ref', v_found.ref, 'kind', v_found.kind,
          'message', v_code || ' is a ' || v_found.kind || ' (' || v_found.ref || ') — it is added to a '
            || 'quote, not taken off it. A clerk does not choose which charges stand on a job.');
      end if;
      if not v_is_live then
        return jsonb_build_object('ok', false, 'error', 'promo_lapsed', 'code', v_code,
          'ref', v_found.ref, 'asked_on', v_day::text,
          'effective_from', v_found.effective_from::text,
          'effective_to', v_found.effective_to::text,
          'message', v_code || ' (' || v_found.ref || ') does not stand on ' || v_day
            || '. Its dates are ' || v_found.effective_from
            || coalesce(' to ' || v_found.effective_to::text, '') || '.');
      end if;
      return jsonb_build_object('ok', false, 'error', 'promo_wrong_scope', 'code', v_code,
        'ref', v_found.ref, 'scope', platform_auth.pricing_addendum_said(v_found),
        'message', v_code || ' (' || v_found.ref || ') is live on ' || v_day || ' but not on this job. It '
          || 'stands on ' || platform_auth.pricing_addendum_said(v_found) || '.');
    end if;

    if v_pick ->> 'currency' <> v_cur then
      return jsonb_build_object('ok', false, 'error', 'money_mismatch',
        'addendum', v_pick ->> 'ref', 'asked', v_pick ->> 'currency', 'card', v_cur,
        'message', (v_pick ->> 'ref') || ' takes ' || (v_pick ->> 'currency') || ' off and '
          || (v_hit #>> '{card,ref}') || ' answers in ' || v_cur || '. A discount written in another money '
          || 'is not a discount.');
    end if;

    v_ref := v_pick ->> 'ref';
    v_max := nullif(v_pick ->> 'max_uses', '')::int;
    v_taken := (v_pick ->> 'uses_taken')::int;
    if v_max is not null and v_taken >= v_max then
      return jsonb_build_object('ok', false, 'error', 'promo_spent', 'code', v_code, 'ref', v_ref,
        'uses_taken', v_taken, 'max_uses', v_max,
        'message', v_ref || ' has taken all ' || v_max || ' of its places. The code is on the paper but '
          || 'there is nothing left to give — this is the refusal a clerk has to read out.');
    end if;

    v_btext := v_pick ->> 'basis';
    v_value := (v_pick ->> 'value')::numeric;
    v_cap := nullif(v_pick ->> 'cap', '')::numeric;
    v_minq := nullif(v_pick ->> 'min_amount', '')::numeric;
    v_capped := false;
    v_held := false;
    v_clipped := false;

    if v_btext = 'percent_off' then
      v_raw := round(v_payable * v_value / 100, 2);
    elsif v_btext = 'amount_off' then
      v_raw := v_value;
    else
      return jsonb_build_object('ok', false, 'error', 'unknown_basis', 'addendum', v_ref,
        'basis', v_btext,
        'message', 'This register does not know how to take a ' || v_btext || ' discount off a quote ('
          || v_ref || ').');
    end if;

    if v_cap is not null and v_raw > v_cap then
      v_raw := v_cap;
      v_capped := true;
    end if;
    if v_minq is not null and v_raw < v_minq then
      v_raw := v_minq;
      v_held := true;
    end if;
    -- Clipped to what is payable rather than allowed to go negative: a job is never paid less than
    -- nothing, and the office that gave a code worth more than the freight owes the difference to nobody.
    if v_raw > v_payable - v_off then
      v_raw := v_payable - v_off;
      v_clipped := true;
    end if;
    v_raw := round(v_raw, 2);
    if v_raw <= 0 then
      return jsonb_build_object('ok', false, 'error', 'promo_too_small', 'code', v_code, 'ref', v_ref,
        'basis', v_btext, 'value', v_pick ->> 'value',
        'message', v_ref || ' takes nothing off this job. A clerk who types a code and sees the figure '
          || 'uncharged has been told a lie by the paper — say so instead.');
    end if;

    v_off := v_off + v_raw;
    v_working := v_working
      || case when v_stated then ''
              else ' = ' || trim(to_char(v_freight, 'FM99999999999999999990.00')) || ' ' || v_cur end
      || ' - ' || v_ref || ' ' || (v_pick ->> 'label') || ' '
      || trim(to_char(v_raw, 'FM999999999990.00'))
      || case when v_clipped then ' (the whole of what was left)'
              when v_capped then ' (held to its own ceiling)'
              when v_held then ' (held up to its own floor)'
              else '' end;
    v_stated := true;
    v_discounts := v_discounts || jsonb_build_array(jsonb_build_object(
      'id', (v_pick ->> 'id')::uuid, 'ref', v_ref, 'code', v_code, 'kind', v_pick ->> 'kind',
      'label', v_pick ->> 'label', 'basis', v_btext, 'value', v_pick ->> 'value',
      'amount', trim(to_char(v_raw, 'FM99999999999999999990.00')),
      'capped', v_capped, 'floor_applied', v_held, 'clipped_to_job', v_clipped,
      'cap', v_pick ->> 'cap', 'min_amount', v_pick ->> 'min_amount',
      'counted', (v_pick ->> 'counted')::boolean, 'max_uses', v_max, 'uses_taken', v_taken,
      'uses_left', case when v_max is null then null else v_max - v_taken end));
  end loop;

  v_total := v_payable - v_off;

  return v_hit || jsonb_build_object(
    'asked_on', v_day::text,
    'freight', v_hit ->> 'amount',
    'extras', v_extras,
    'extras_total', trim(to_char(round(v_payable - v_freight, 2), 'FM99999999999999999990.00')),
    'payable', trim(to_char(round(v_payable, 2), 'FM99999999999999999990.00')),
    'discounts', v_discounts,
    'discount_total', trim(to_char(round(v_off, 2), 'FM99999999999999999990.00')),
    'total', trim(to_char(round(v_total, 2), 'FM99999999999999999990.00')),
    'currency', v_cur,
    'charges_in_force', (select coalesce(jsonb_agg(jsonb_build_object('ref', r ->> 'ref',
                                                           'code', r ->> 'code',
                                                           'kind', r ->> 'kind',
                                                           'label', r ->> 'label',
                                                           'basis', r ->> 'basis',
                                                           'value', r ->> 'value',
                                                           'scope', r ->> 'scope')), '[]'::jsonb)
                           from jsonb_array_elements(v_in_force -> 'rows') r
                          where (r ->> 'sign')::int = 1),
    'codes_in_force', (select coalesce(jsonb_agg(jsonb_build_object('ref', r ->> 'ref',
                                                        'code', r ->> 'code',
                                                        'label', r ->> 'label',
                                                        'basis', r ->> 'basis',
                                                        'value', r ->> 'value',
                                                        'max_uses', r -> 'max_uses',
                                                        'uses_taken', r -> 'uses_taken',
                                                        'scope', r ->> 'scope')), '[]'::jsonb)
                           from jsonb_array_elements(v_in_force -> 'rows') r
                          where (r ->> 'sign')::int = -1),
    'working', v_working || case when jsonb_array_length(v_extras) + jsonb_array_length(v_discounts) > 0
                                 then ' = ' || trim(to_char(round(v_total, 2),
                                                           'FM99999999999999999990.00')) || ' ' || v_cur
                                 else '' end);
exception when others then
  -- A composer that dies on a cast answers a quotation with a database error. 140 printed its figures
  -- wide for the same reason; this is the other half of it.
  return jsonb_build_object('ok', false, 'error', 'composer_failed', 'detail', sqlerrm,
    'message', 'The quote could not be worked out: ' || sqlerrm);
end $$;

-- ============================================================
-- 13. the duties: this migration adds none
-- ============================================================

-- A surcharge and a price list are the same authority wearing different clothes. The seat that may put a
-- rate live is the seat that may put a levy live, and 140's reason for keeping `.publish` away from
-- `.manage` — a seat that can write the figures and sign them alone is a seat that has not needed a second
-- person since the day the register opened — holds with more force for a discount code, not less. Taking a
-- place on a promo is a clerk's act and sits under `.manage`, the same duty that fills a line.
--
-- So there is no `control.pricing.claim` and no `control.pricing.surcharge`. The census below asserts the
-- pricing duties are still exactly the three 140 inserted; a stage that wants a fourth has to say what a
-- seat could do with it that these three do not already cover.

-- ============================================================
-- 14. grants on the doors
-- ============================================================

-- The seven guards and the four internal readers are fired or called from inside a door, never from the
-- app. `pricing_addendum_paper` and `pricing_addendum_sha256` are the canonical bytes a signature is cut
-- on, so they are kept from the app role exactly as 140 keeps its own pair: a route that could hash a
-- payload it never proposed could also propose one it never showed the second seat.
revoke all on function
  platform_auth.pricing_addendum_history_is_kept(),
  platform_auth.pricing_addendum_is_kept(),
  platform_auth.pricing_addendum_header_is_immutable(),
  platform_auth.pricing_one_charge_per_day(),
  platform_auth.pricing_addendum_names_its_own_book(),
  platform_auth.pricing_addendum_claim_is_kept(),
  platform_auth.pricing_addendum_claim_only_loses_its_place(),
  platform_auth.pricing_addendum_paper(uuid),
  platform_auth.pricing_addendum_sha256(uuid),
  platform_auth.pricing_addendum_uses_taken(uuid),
  platform_auth.pricing_addendum_said(pricing_addenda)
from public, anon, authenticated, service_role, app_runtime;

grant execute on function
  platform_auth.pricing_addenda(uuid, text, text, text, text, int, int),
  platform_auth.pricing_addendum_detail(uuid, uuid),
  platform_auth.pricing_addendum_memory(uuid, uuid, int, int),
  platform_auth.pricing_addenda_in_force(uuid, date, text, text, uuid, text, text),
  platform_auth.open_pricing_addendum(uuid, text, text, text, text, numeric, numeric, numeric, int,
    text, uuid, text, text, date, text, uuid, text, text, text),
  platform_auth.edit_pricing_addendum(uuid, uuid, text, text, numeric, numeric, numeric, int,
    uuid, text, text, date, text, text, uuid, text, text, text),
  platform_auth.discard_pricing_addendum(uuid, uuid, text, uuid, text, text, text),
  platform_auth.clone_pricing_addendum(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.propose_pricing_addendum(uuid, uuid, text, uuid, text, text, text),
  platform_auth.refuse_pricing_addendum(uuid, uuid, text, uuid, text, text, text),
  platform_auth.apply_pricing_addendum(uuid, uuid, text, text),
  platform_auth.withdraw_pricing_addendum(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.claim_pricing_addendum(uuid, uuid, text, uuid, text, numeric, numeric, text, uuid,
    text, text, text),
  platform_auth.void_pricing_addendum_claim(uuid, uuid, text, uuid, text, text, text),
  platform_auth.price_a_job(uuid, date, text, uuid, text, text, text, numeric, int, numeric, int, text)
to app_runtime;

-- `create or replace function` hands EXECUTE back to PUBLIC, so every door is revoked after it is granted
-- — the sweep 114 lists and every stage since has honoured.
revoke all on function
  platform_auth.pricing_addenda(uuid, text, text, text, text, int, int),
  platform_auth.pricing_addendum_detail(uuid, uuid),
  platform_auth.pricing_addendum_memory(uuid, uuid, int, int),
  platform_auth.pricing_addenda_in_force(uuid, date, text, text, uuid, text, text),
  platform_auth.open_pricing_addendum(uuid, text, text, text, text, numeric, numeric, numeric, int,
    text, uuid, text, text, date, text, uuid, text, text, text),
  platform_auth.edit_pricing_addendum(uuid, uuid, text, text, numeric, numeric, numeric, int,
    uuid, text, text, date, text, text, uuid, text, text, text),
  platform_auth.discard_pricing_addendum(uuid, uuid, text, uuid, text, text, text),
  platform_auth.clone_pricing_addendum(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.propose_pricing_addendum(uuid, uuid, text, uuid, text, text, text),
  platform_auth.refuse_pricing_addendum(uuid, uuid, text, uuid, text, text, text),
  platform_auth.apply_pricing_addendum(uuid, uuid, text, text),
  platform_auth.withdraw_pricing_addendum(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.claim_pricing_addendum(uuid, uuid, text, uuid, text, numeric, numeric, text, uuid,
    text, text, text),
  platform_auth.void_pricing_addendum_claim(uuid, uuid, text, uuid, text, text, text),
  platform_auth.price_a_job(uuid, date, text, uuid, text, text, text, numeric, int, numeric, int, text)
from public, anon, authenticated, service_role;

-- Nothing outside the doors in sections 8-11 asks for a charge number, and those doors run as their own
-- owner, so the sequence is revoked from the app role along with the rest (134, 135, 140).
revoke all on sequence pricing_addendum_number_seq
  from public, anon, authenticated, app_runtime, service_role;

-- ============================================================
-- 15. say what this leaves the platform in
-- ============================================================

do $$ declare
  v_tables int;
  v_unprotected int;
  v_readers int;
  v_writers int;
  v_kinds int;
  v_words int;
  v_bad_basis int;
  v_counted_misuse int;
  v_leaks int;
  v_internal_grants int;
  v_seq_holders int;
  v_live int;
  v_duties int;
begin
  select count(*)::int into v_tables from pg_tables
   where schemaname = 'public'
     and tablename in ('pricing_addendum_kinds','pricing_addenda','pricing_addendum_history',
                       'pricing_addendum_claims');
  if v_tables <> 4 then
    raise exception '141: the charge register is % of its four tables', v_tables;
  end if;

  select count(*)::int into v_unprotected from pg_tables t
   where t.schemaname = 'public'
     and t.tablename in ('pricing_addendum_kinds','pricing_addenda','pricing_addendum_history',
                         'pricing_addendum_claims')
     and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where c.relname = t.tablename and n.nspname = 'public' and c.relrowsecurity);
  if v_unprotected <> 0 then
    raise exception '141: % of the charge registers can be read without a book being named',
      v_unprotected;
  end if;

  select count(distinct c.relname)::int into v_readers
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relname in ('pricing_addendum_kinds','pricing_addenda','pricing_addendum_history',
                       'pricing_addendum_claims')
     and a.grantee = (select oid from pg_roles where rolname = 'app_runtime')
     and a.privilege_type = 'SELECT';
  if v_readers <> 4 then
    raise exception '141: the app role must read all four charge registers; it reads % of them',
      v_readers;
  end if;

  select count(*)::int into v_writers
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relname in ('pricing_addendum_kinds','pricing_addenda','pricing_addendum_history',
                       'pricing_addendum_claims')
     and a.grantee = (select oid from pg_roles where rolname = 'app_runtime')
     and a.privilege_type in ('INSERT','UPDATE','DELETE');
  if v_writers <> 0 then
    raise exception '141: the app role writes charges through a door and holds % direct write grant(s)',
      v_writers;
  end if;

  -- The two words, in the shape the arithmetic reads them. A kind whose sign is neither +1 nor -1 would
  -- make the composer's loop a guess, and a third prefix would collide with the ref pattern.
  select count(*)::int into v_kinds from pricing_addendum_kinds;
  if v_kinds <> 2 then
    raise exception '141: the register is two words — a standing charge and a discount code — and it '
      'holds %', v_kinds;
  end if;
  if exists (select 1 from pricing_addendum_kinds
              where (key, prefix, sign, counted) not in
                    (('surcharge','SUR',1,false), ('promo','PRM',-1,true))) then
    raise exception '141: a charge kind is filed under a prefix, a sign or a ceiling that the doors in '
      'section 8 were written against';
  end if;

  -- 140's vocabulary is unchanged. This register borrows its quantity words and adds three of its own
  -- that the freight resolver must never be asked to multiply by; inserting them into
  -- `pricing_dimensions` would break that promise and 140's own census with it.
  select count(*)::int into v_words from pricing_dimensions;
  if v_words <> 21 then
    raise exception '141: 140''s price vocabulary holds % words, not the 21 it was sealed with, so a '
      'charge is keyed on a word with no author', v_words;
  end if;

  select count(*)::int into v_bad_basis
    from pricing_addendum_kinds k, unnest(k.basis_set) b
   where b not in ('percent_of_freight','percent_off','amount_off')
     and not exists (select 1 from pricing_dimensions d
                      where d.kind = 'basis' and d.key = b);
  if v_bad_basis <> 0 then
    raise exception '141: % charge basis word(s) are in neither 140''s vocabulary nor the three this '
      'register invented, so the composer would meet a word it cannot multiply', v_bad_basis;
  end if;

  -- The CHECK says a surcharge has no ceiling; this says the same of the data, because a row written
  -- before a constraint, or by a hand on the table, is the row a desk shows a clerk as unlimited.
  select count(*)::int into v_counted_misuse
    from pricing_addenda a
    join pricing_addendum_kinds k on k.key = a.kind
   where (not k.counted and a.max_uses is not null)
      or (k.counted and a.basis <> all (k.basis_set));
  if v_counted_misuse <> 0 then
    raise exception '141: % charge(s) are filed against a kind that cannot carry their ceiling or their '
      'basis', v_counted_misuse;
  end if;

  select coalesce(count(*)::int, 0) into v_leaks
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join aclexplode(p.proacl) a
   where n.nspname = 'platform_auth'
     and p.proname in ('pricing_addenda','pricing_addendum_detail','pricing_addendum_memory',
                       'pricing_addenda_in_force','open_pricing_addendum','edit_pricing_addendum',
                       'discard_pricing_addendum','clone_pricing_addendum','propose_pricing_addendum',
                       'refuse_pricing_addendum','apply_pricing_addendum','withdraw_pricing_addendum',
                       'claim_pricing_addendum','void_pricing_addendum_claim','price_a_job')
     and (a.grantee = 0
          or a.grantee = any (select oid from pg_roles
                               where rolname in ('anon','authenticated','service_role')));
  if v_leaks <> 0 then
    raise exception '141: % of the charge doors are still grantable to a client role or to PUBLIC',
      v_leaks;
  end if;

  select coalesce(count(*)::int, 0) into v_internal_grants
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join aclexplode(p.proacl) a
   where n.nspname = 'platform_auth'
     and p.proname in ('pricing_addendum_history_is_kept','pricing_addendum_is_kept',
                       'pricing_addendum_header_is_immutable','pricing_one_charge_per_day',
                       'pricing_addendum_names_its_own_book','pricing_addendum_claim_is_kept',
                       'pricing_addendum_claim_only_loses_its_place','pricing_addendum_paper',
                       'pricing_addendum_sha256','pricing_addendum_uses_taken','pricing_addendum_said')
     and (a.grantee = 0 or a.grantee = (select oid from pg_roles where rolname = 'app_runtime'));
  if v_internal_grants <> 0 then
    raise exception '141: a guard is fired, never called, and % of 141''s internal bodies still answer a '
      'caller', v_internal_grants;
  end if;

  if not exists (select 1 from pg_roles r
                  where r.rolname = 'app_runtime'
                    and has_function_privilege(r.oid,
                          'platform_auth.apply_pricing_addendum(uuid, uuid, text, text)', 'EXECUTE')) then
    raise exception '141: the door that spends a charge signature is not executable by the app role';
  end if;

  -- Three duties, and the register says so. A fourth inserted here would be a fourth gate a seat has to
  -- be given before a surcharge can be quoted, and the desk would answer a clerk with an empty board.
  select count(*)::int into v_duties from permissions where key like 'control.pricing.%';
  if v_duties <> 3 then
    raise exception '141: the pricing duties are three and this migration adds none — it found %',
      v_duties;
  end if;

  -- The numbering is only worth keeping if nobody outside the doors can spend it. An owner needs no grant
  -- of its own, and Postgres still writes the owner's three letters into the list after a revoke, so the
  -- entry counted here is any grantee that is not the owner (134, 135, 140).
  select coalesce(count(*)::int, 0) into v_seq_holders
    from pg_class cl cross join aclexplode(cl.relacl) a
   where cl.relname = 'pricing_addendum_number_seq' and cl.relkind = 'S'
     and a.grantee <> cl.relowner;
  if v_seq_holders <> 0 then
    raise exception '141: % role(s) besides its owner can take a charge number without writing a charge',
      v_seq_holders;
  end if;

  select count(*)::int into v_live from pricing_addenda
   where status = 'published'
     and effective_from <= current_date
     and coalesce(effective_to, date 'infinity') >= current_date;
  raise notice '141: the charge register is open — % word(s) in the book, % live charge(s) today, % of '
    '140''s vocabulary words kept where they were, and a place that was taken on a code cannot be '
    'deleted by anybody, only given back',
    v_kinds, v_live, v_words;
end $$;

commit;
