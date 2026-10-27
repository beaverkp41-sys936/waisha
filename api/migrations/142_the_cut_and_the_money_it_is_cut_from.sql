-- 142: the cut, and the money it is cut from
--
-- 141's own header left one thing out on purpose: "commission per tenant or plan. A commission is money
-- the office owes somebody out of a transaction, so its register needs a transaction to sit on and a
-- chart of accounts to be posted against — 133's book, not a price that describes no movement ... the one
-- refusal this migration cannot make is a levy that quietly becomes a liability." This is that card, and
-- the last sentence is the design.
--
-- Why a commission is not a 141 addendum. An addendum changes what a customer is *quoted*, before any
-- money exists; a commission is a share of money that has already moved. The same 5 percent written on a
-- fuel levy and on a commission agreement produces two different things: one is arithmetic on a price,
-- the other is arithmetic on a transaction — and a transaction has an author, a day, a money and a state
-- (paid, refunded, declined) that a quote has none of. So the register is keyed on a *subject* rather
-- than on a scope, and it produces an *assessment*: one reading of one rate against one named
-- transaction.
--
-- Why an assessment is a reading and never a movement. 135 learned this the hard way: a reconciliation
-- that called a delivery "landed" when the office had ignored it was a count that moved money by
-- describing it. Nothing here writes `money_entries` or `money_postings`. Every leg still goes through
-- 133's `record_money_posting` and 134's payout doors, and this migration's part is to say what the cut
-- *is*, to whom it belongs and whether a movement has carried it. `discharge_commission_assessment` is
-- the honest half of that promise: it names a payout or a posting, reads the figure out of the book and
-- refuses the pointer when the movement does not carry the cut the register computed. That is where a
-- levy quietly becoming a liability is caught — at the moment somebody claims it already happened.
--
-- Why the subject, the transaction and the payee are three words and not one column. A cut can be agreed
-- with a company, inherited from the plan it subscribes to, or be the office's own standing cut; it is
-- taken out of a subscription invoice, a payment, a freight invoice, a freight expense or a payout; and
-- it is kept by the office or owed out to a company, a driver or a staff member (an agent's share, a
-- referral, a branch's cut). Each of the three has its own vocabulary and its own ladder, so each is a
-- row set: `pricing_commission_subjects` carries the ladder order the resolver walks, and
-- `pricing_commission_sources` names the transactions a cut may be taken from — the same reason 130 made
-- transport modes data, 132 the customs regimes, 134 the rails and 141 the charge kinds. A `case`
-- scattered through plpgsql and a route's switch statement is how the fifth desk gets it wrong. The
-- section-15 census is what keeps the words and the bodies honest: it refuses to finish when a source
-- word has no arm in the resolver.
--
-- Why the figure is copied onto the assessment. 141's reason for its memory table, and stronger here: a
-- rate that is superseded next month must not rewrite what was owed on a March invoice. An assessment
-- carries the rate's ref, version, basis and value as printed text, so a dispute reads the figure and the
-- rate that made it from one row.
--
-- Why the money a cut is taken from cannot be typed. `assess_commission` takes a source kind and an id
-- and reads the amount, the currency and the reference out of the named register itself. A clerk who
-- could type the amount could assess a cut against a figure that transaction never had, and the whole
-- register would be a way of inventing liabilities. 134's payee rule, aimed at the other side of the
-- paper. A percent rate therefore carries **no currency** — it is worked out in whatever money the
-- transaction is in — and a flat rate carries one and refuses a transaction in another, which is 138's
-- defect answered before it can be summed.
--
-- Why publishing a rate needs the second seat, and why this migration adds no duty. A commission is what
-- the office takes out of somebody else's money or owes them out of it; one hand cannot set it, so
-- `pricing.commission` joins 121's register as its own action name and its own effect. The three duties
-- 140 minted (`.view`, `.manage`, `.publish`) cover it exactly as they cover 141's charges, and a seat
-- that discharges a cut must also hold 133's `control.money.post` — the door that names a movement in the
-- book is the door that can make a book say a cut left. No fourth pricing key: a fourth gate would be a
-- nav entry nobody granted anyone, and the board would answer a clerk with an empty ladder.
--
-- Rounding is the register's. A cut is `round(x, 2)` — half up, in the transaction's own money — and a
-- floor and a ceiling are applied in that order after it, so `figure = least(cap, greatest(floor, raw))`.
-- The formula is written once, in `commission_figure`, and the assessment, the resolver and the desk's
-- preview all call it: two arithmetic paths is how a desk shows one figure and the book carries another.
begin;

-- ============================================================
-- 1. the three subjects a cut can be agreed with, in the order the ladder walks them
-- ============================================================

-- The office asks "what is this company's cut?" and the answer must be honest about *which* agreement
-- spoke: the one signed with that company, the standing one its plan carries, or the office's own. The
-- priority is data because the ladder is the answer, and a desk that cannot say which rung spoke is a
-- desk asserting a figure with no author.
create table if not exists pricing_commission_subjects (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key in ('tenant','plan','platform')),
  label text not null check (char_length(trim(label)) between 2 and 60),
  -- 1 is asked first. The three rows below are the whole vocabulary and section 15 refuses a fourth.
  priority int not null check (priority between 1 and 9),
  -- Whether this rung names a row in another register: a company, a plan, or nothing at all.
  names text not null check (names in ('company','plan','none')),
  note text check (note is null or char_length(trim(note)) between 8 and 600),
  constraint pricing_commission_subjects_one_word unique (key),
  constraint pricing_commission_subjects_one_rung unique (priority)
);

alter table pricing_commission_subjects enable row level security;
create policy pricing_commission_subjects_readable on pricing_commission_subjects for select
  to app_runtime using (true);
grant select on pricing_commission_subjects to app_runtime;
revoke all on pricing_commission_subjects from public, anon, authenticated, service_role;

insert into pricing_commission_subjects (key, label, priority, names, note) values
  ('tenant',   'The company itself',   1, 'company',
   'A cut agreed with one company, signed for that name. Asked first, because a negotiated figure is the '
     || 'office''s promise to that customer.'),
  ('plan',     'The plan it is on',    2, 'plan',
   'The standing cut every company on that plan is cut at. Asked second, and only while the company''s '
     || 'own live subscription says it is on the plan.'),
  ('platform', 'The office''s own cut', 3, 'none',
   'What the office takes when no agreement names the company or its plan. Asked last, so a rate nobody '
     || 'signed for never wins over one somebody did.')
on conflict (key) do nothing;

-- ============================================================
-- 2. the transactions a cut can be taken from
-- ============================================================

-- The words the desk may choose from. The money itself is never read from here — `commission_source_said`
-- below is the one body that knows which column of which register holds a transaction's figure, and the
-- census in section 15 refuses to finish when a word here has no arm in that body. A table that lists a
-- column nothing reads would be a promise the desk makes and the register cannot keep.
create table if not exists pricing_commission_sources (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z][a-z0-9_]{2,39}$'),
  label text not null check (char_length(trim(label)) between 3 and 60),
  -- Whether the transaction is money the office *receives* (a cut on it is income) or money it *pays out*
  -- (a cut on it is what the office keeps back). The word is printed on the desk, never used as arithmetic.
  side text not null check (side in ('in','out')),
  sort int not null default 0,
  note text check (note is null or char_length(trim(note)) between 8 and 600),
  constraint pricing_commission_sources_one_word unique (key),
  constraint pricing_commission_sources_one_order unique (sort)
);

alter table pricing_commission_sources enable row level security;
create policy pricing_commission_sources_readable on pricing_commission_sources for select
  to app_runtime using (true);
grant select on pricing_commission_sources to app_runtime;
revoke all on pricing_commission_sources from public, anon, authenticated, service_role;

insert into pricing_commission_sources (key, label, side, sort, note) values
  ('subscription_invoice', 'A subscription invoice', 'in',  1,
   '005''s own paper. A cut on what the company is billed is income, and the invoice''s total is the '
     || 'figure it is cut from.'),
  ('subscription_payment',  'A subscription payment', 'in',  2,
   '005''s money line, and 009''s completion is what makes it real. Assessed against the amount the '
     || 'payment actually carried.'),
  ('freight_invoice',       'A freight invoice',      'in',  3,
   '029''s paper: what the office bills a customer for the work.'),
  ('freight_expense',       'A freight expense',      'out', 4,
   '031''s paper: what the office pays a supplier, from which an agent''s cut may be owed.'),
  ('payout',                'A payout',               'out', 5,
   '134''s line, already carrying a hand-typed `fee_amount`. This register is where that figure comes '
     || 'from instead of a keystroke.')
on conflict (key) do nothing;

-- ============================================================
-- 3. the register: whose cut, which figure, valid for which days
-- ============================================================

-- Granted to nobody, not even the app role, for 134's, 135's and 141's reason: a client role that can
-- take a number without writing a row leaves the office a hole in its own numbering to explain.
create sequence if not exists pricing_commission_rate_number_seq;
create sequence if not exists pricing_commission_assessment_number_seq;

create table if not exists pricing_commission_rates (
  id uuid primary key default gen_random_uuid(),
  -- The book the paper stands in. Every commission agreement is the office's own act — it sets a cut and
  -- it pays an agent — so the register lives in the platform's book the way 133's chart does, and the
  -- guard below refuses any other. The company the cut is about is named by the subject, not by this
  -- column: a desk must not be able to write a cut into another company's book.
  tenant_id uuid not null references tenants(id),
  ref text not null unique check (ref ~ '^CMR-[0-9]{4}-[0-9]{5,}$'),

  -- Who the cut is agreed with. Exactly one half is set and the guard copies the name, so the board
  -- prints "KILIAN TRANSIT LTD" or "Plan: Growth" without a join and without a typed label.
  subject_kind text not null check (subject_kind in ('tenant','plan','platform')),
  subject_tenant_id uuid references tenants(id),
  subject_plan_id uuid references plans(id),
  -- The single column the ladder, the version chain and the overlap guard are all keyed on. Both this and
  -- the name are written by the guard below, which is why they are NOT NULL and yet take no input from
  -- the desk: a BEFORE trigger that fails to run would abort the insert on the column, not leave a key
  -- the ladder silently walks past.
  subject_key uuid not null,
  subject_name text not null,

  -- Which transaction the cut is taken from, out of section 2's words.
  source_kind text not null,

  -- Who keeps it. `platform` is the office's income; the other three are 134's payee registers, resolved
  -- and copied by the same guard so a cut cannot be aimed at a person the office never had.
  payee_kind text not null default 'platform' check (payee_kind in ('platform','company','driver','staff')),
  payee_id uuid,
  -- Also copied, never typed: the sentence "who keeps it" has to name a person the office has.
  payee_name text not null,

  -- How the figure is worked out. A percent has no money of its own — it is computed in the
  -- transaction's — and a flat is a figure in a named money that refuses a transaction in another.
  basis text not null check (basis in ('percent_of_amount','flat')),
  value numeric(14,4) not null check (value > 0 and value < 10000000000),
  currency text check (currency in ('TZS','USD')),
  -- The least and the most one transaction contributes, in the transaction's own money. A floor is the
  -- office's minimum on a small invoice; a ceiling is what a clerk can argue about on a long one.
  floor_amount numeric(14,2) check (floor_amount is null or (floor_amount >= 0 and floor_amount < 100000000000)),
  cap numeric(14,2) check (cap is null or (cap >= 0 and cap < 100000000000)),

  effective_from date,
  effective_to date,
  version int not null default 1 check (version >= 1),
  supersedes_id uuid references pricing_commission_rates(id),
  status text not null default 'draft'
    check (status in ('draft','pending_signature','published','superseded','withdrawn')),
  approval_id uuid references platform_approvals(id),
  refusals int not null default 0 check (refusals >= 0),
  note text not null check (char_length(trim(note)) between 8 and 600),
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

  constraint pricing_commission_rate_subject_is_one_thing check (
    (subject_kind = 'tenant'   and subject_tenant_id is not null and subject_plan_id is null)
    or (subject_kind = 'plan'   and subject_plan_id is not null and subject_tenant_id is null)
    or (subject_kind = 'platform' and subject_tenant_id is null and subject_plan_id is null)),
  constraint pricing_commission_rate_payee_is_one_thing check (
    (payee_kind = 'platform' and payee_id is null)
    or (payee_kind <> 'platform' and payee_id is not null)),
  constraint pricing_commission_flat_has_a_money check (basis <> 'flat' or currency is not null),
  constraint pricing_commission_percent_carries_no_money check (basis = 'flat' or currency is null),
  constraint pricing_commission_percent_is_a_percent check (
    basis <> 'percent_of_amount' or (value > 0 and value <= 100)),
  constraint pricing_commission_window_is_a_window check (
    effective_from is null or effective_to is null or effective_to >= effective_from),
  constraint pricing_commission_floor_below_ceiling check (
    floor_amount is null or cap is null or floor_amount <= cap),
  constraint pricing_commission_rate_published_has_a_start check (
    status <> 'published' or (effective_from is not null and published_at is not null)),
  constraint pricing_commission_rate_publish_leaves_a_mark check (
    published_at is null or status in ('published','superseded','withdrawn')),
  constraint pricing_commission_rate_unsigned_paper_is_pending check (
    status <> 'pending_signature' or approval_id is not null),
  constraint pricing_commission_rate_withdrawal_is_explained check (
    (status = 'withdrawn') = (withdrawn_at is not null and withdrawn_reason is not null)),
  constraint pricing_commission_rate_does_not_supersede_itself check (
    supersedes_id is null or supersedes_id <> id),
  -- A version chain is per subject, per transaction *and* per book: a company's cut on its invoices and
  -- its cut on its payouts are two agreements that may run at different rates on the same day, and the
  -- office that keeps them is the only one that numbers them. 140's chain is `unique (tenant_id, code,
  -- version)`; without the book here, the first office to sign a standing cut would take the version
  -- number the second office's standing cut needs, because both rungs are keyed on one nil uuid.
  constraint pricing_commission_rate_one_version_per_ladder
    unique (tenant_id, subject_key, source_kind, version)
);

create index if not exists pricing_commission_rate_board_idx
  on pricing_commission_rates (subject_kind, subject_key, source_kind, status);
create index if not exists pricing_commission_rate_ladder_idx
  on pricing_commission_rates (source_kind, status, effective_from desc);

-- A database that already built this table from the first cut of the file has the unbound key, and
-- `create table if not exists` never revisits an inline constraint — so the chain is re-keyed here, in
-- the order that leaves the same shape either way. Nothing is lost: the old key was stricter, so every
-- row that satisfied it satisfies this one.
alter table pricing_commission_rates
  drop constraint if exists pricing_commission_rate_one_version_per_ladder;
alter table pricing_commission_rates
  add constraint pricing_commission_rate_one_version_per_ladder
  unique (tenant_id, subject_key, source_kind, version);

alter table pricing_commission_rates enable row level security;
create policy pricing_commission_rates_tenant on pricing_commission_rates for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on pricing_commission_rates to app_runtime;
revoke all on pricing_commission_rates from public, anon, authenticated, service_role;

create trigger trg_pricing_commission_rates_updated before update on pricing_commission_rates
  for each row execute function public.set_updated_at();

-- ============================================================
-- 4. the memory: what the agreement used to be
-- ============================================================

-- 140's and 141's shape and reason: one row per thing that moved, both halves printed as text, because a
-- figure change, a window change, a state change, a cut taken and a cut carried by a movement are all
-- answers to "what was it before" and none of them is arithmetic.
--
-- There is no `subject` word. The section-6 guard forbids an agreement's subject, transaction and payee
-- from moving at all, so a word for it would be a promise the register cannot keep — a desk that lists a
-- change no door can make invites a clerk to look for one.
create table if not exists pricing_commission_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  rate_id uuid not null references pricing_commission_rates(id),
  assessment_id uuid,
  what text not null check (what in ('figure','window','state','assess','discharge','void')),
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

create index if not exists pricing_commission_history_item_idx
  on pricing_commission_history (rate_id, at desc);
create index if not exists pricing_commission_history_book_idx
  on pricing_commission_history (tenant_id, at desc);

alter table pricing_commission_history enable row level security;
create policy pricing_commission_history_tenant on pricing_commission_history for select
  to app_runtime using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on pricing_commission_history to app_runtime;
revoke all on pricing_commission_history from public, anon, authenticated, service_role;

-- ============================================================
-- 5. the readings: one cut, against one transaction
-- ============================================================

-- No cascade on `rate_id`, for 141's reason and a sharper one: the rate a reading was taken under is the
-- answer to "on what agreement did the office ask for this?", and a delete that takes it with it turns a
-- dispute into a guess.
create table if not exists pricing_commission_assessments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ref text not null unique check (ref ~ '^CMA-[0-9]{4}-[0-9]{5,}$'),
  rate_id uuid not null references pricing_commission_rates(id),

  -- The rate as printed on the day the reading was taken. Text, so the fourth decimal a signature was cut
  -- on survives a `numeric` re-render (140's reason, and 138's defect on the other side of it).
  rate_ref text not null,
  rate_version int not null check (rate_version >= 1),
  rate_basis text not null,
  rate_value text not null,
  rate_currency text,
  subject_kind text not null,
  subject_key uuid not null,
  subject_name text not null,
  payee_kind text not null,
  payee_id uuid,
  payee_name text not null,

  -- The transaction, named rather than described: the amount, the money and the reference are copied out
  -- of the register by the door and cannot be typed by anybody.
  source_kind text not null,
  source_id uuid not null,
  source_ref text not null,
  source_amount numeric(14,2) not null check (source_amount > 0 and source_amount < 100000000000),
  currency text not null check (currency in ('TZS','USD')),
  raw_amount numeric(14,4) not null check (raw_amount >= 0),
  figure numeric(14,2) not null check (figure > 0 and figure < 100000000000),

  -- The day the rate was read for. A reading is dated because a superseded agreement still ruled the day
  -- it was in force, and an invoice for March is cut at March's rate.
  assessed_on date not null default current_date,
  status text not null default 'assessed' check (status in ('assessed','discharged','voided')),

  discharged_at timestamptz,
  discharged_by uuid references users(id),
  carrier_kind text check (carrier_kind is null or carrier_kind in ('payout','posting')),
  carrier_id uuid,
  carrier_ref text,
  discharge_note text check (discharge_note is null
                              or char_length(trim(discharge_note)) between 8 and 600),

  voided_at timestamptz,
  voided_by uuid references users(id),
  void_reason text check (void_reason is null or char_length(trim(void_reason)) between 8 and 600),

  note text check (note is null or char_length(trim(note)) between 8 and 600),
  assessed_by uuid references users(id),
  assessed_role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A cut bigger than the money it sits on is a typing mistake, and 134 already says so of a payout's
  -- fee. The register says it before the desk is asked to sign anything.
  constraint pricing_commission_cut_fits_the_money check (figure <= source_amount),
  constraint pricing_commission_discharge_is_explained check (
    (status = 'discharged') = (discharged_at is not null and carrier_kind is not null
                               and carrier_id is not null and discharge_note is not null)),
  constraint pricing_commission_void_is_explained check (
    (status = 'voided') = (voided_at is not null and void_reason is not null)),
  constraint pricing_commission_reading_is_one_thing check (
    (status = 'assessed' and voided_at is null and discharged_at is null)
    or (status = 'voided' and discharged_at is null)
    or (status = 'discharged' and voided_at is null)),
  constraint pricing_commission_assessment_carries_its_rate check (
    rate_basis <> 'flat' or rate_currency = currency)
);

-- One live reading per transaction per payee, and a void one does not hold the place: the corrected
-- reading is allowed the moment the mistake is cancelled, and the row that proves the mistake happened
-- stays. Partial on `voided_at`, not on status, because a discharged reading must keep holding its
-- transaction — a cut is taken once, and a second reading of the same cut is exactly the double-count
-- this index exists to refuse.
-- The nil uuid stands for "the office's own rung", and it is written as a literal, not a function: this
-- is an index expression, so every part of it has to be immutable. `commission_subject_key` below is the
-- one body that says which uuid a subject is, and it returns the same letters.
create unique index pricing_commission_one_live_reading
  on pricing_commission_assessments (source_kind, source_id, payee_kind,
    coalesce(payee_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where voided_at is null;
create index if not exists pricing_commission_reading_source_idx
  on pricing_commission_assessments (source_kind, source_id);
create index if not exists pricing_commission_reading_book_idx
  on pricing_commission_assessments (tenant_id, assessed_on desc);

alter table pricing_commission_assessments enable row level security;
create policy pricing_commission_assessments_tenant on pricing_commission_assessments for select
  to app_runtime using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on pricing_commission_assessments to app_runtime;
revoke all on pricing_commission_assessments from public, anon, authenticated, service_role;

create trigger trg_pricing_commission_assessments_updated before update on pricing_commission_assessments
  for each row execute function public.set_updated_at();

-- ============================================================
-- 6. the guards
-- ============================================================

-- Which uuid a subject is filed under: the company, the plan, or the office's own rung. The trigger
-- writes it and the doors ask for it before an insert to work out the next version, so this is the one
-- place the nil is spelled. It has to stay an expression of its arguments only — the same three letters
-- are what the unique index is built on.
create or replace function platform_auth.commission_subject_key(
  p_subject_kind text, p_subject_tenant_id uuid, p_subject_plan_id uuid
) returns uuid
language sql immutable set search_path = public as $$
  select case p_subject_kind
    when 'tenant' then p_subject_tenant_id
    when 'plan'   then p_subject_plan_id
    else '00000000-0000-0000-0000-000000000000'::uuid
  end
$$;

-- The memory is append-only, with one exception written down rather than left to a hole: the lines a
-- draft wrote about itself. An agreement that no seat was ever asked to sign and that never went live is
-- thrown away by `discard_pricing_commission_rate`, and its `foreign key has no cascade`, so a guard that
-- refused the memory rows too would refuse the discard it is standing behind — and the alternative,
-- disabling the guard inside a door, is how an append-only register stops meaning anything. The test is
-- the same three marks the rate keep-guard reads, so a draft that carried a signature keeps its memory
-- even though it cannot be deleted at all.
create or replace function platform_auth.pricing_commission_history_is_kept() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v pricing_commission_rates;
begin
  if TG_OP = 'UPDATE' then
    raise exception '142: the memory of an agreement is append-only: it is what a second seat signed '
      'against, and a rewrite is not a correction';
  end if;
  select * into v from pricing_commission_rates where id = OLD.rate_id;
  if not found or v.published_at is not null or v.approval_id is not null or v.status <> 'draft' then
    raise exception '142: the memory of % is kept: an agreement anybody was asked to sign, or that was '
      'ever live, leaves its whole history standing', OLD.rate_id;
  end if;
  return OLD;
end $$;

create trigger pricing_commission_history_is_append_only
  before update or delete on pricing_commission_history
  for each row execute function platform_auth.pricing_commission_history_is_kept();

-- A rate that a signature ever stood on, or that ever went live, is not deleted. A draft opened by
-- mistake is thrown away through `discard_pricing_commission_rate`, which deletes the row and leaves the
-- audit line — 140's and 141's rule, and the same one a fixture run has to respect.
create or replace function platform_auth.pricing_commission_rate_is_kept() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if OLD.published_at is not null or OLD.approval_id is not null or OLD.status <> 'draft' then
    raise exception '142: % is a % agreement that % a signature, so it is kept: %',
      OLD.ref, OLD.status,
      case when OLD.approval_id is not null then 'carries' else 'never had' end,
      case when OLD.published_at is not null or OLD.status <> 'draft'
        then 'an agreement a company may have been cut under is ended by withdrawing it or by a new '
          || 'version, never by a delete'
        else 'a paper anyone was asked to sign names this agreement, and the row is kept so the paper '
          || 'goes on naming something'
      end;
  end if;
  return OLD;
end $$;

create trigger pricing_commission_rates_are_kept
  before delete on pricing_commission_rates
  for each row execute function platform_auth.pricing_commission_rate_is_kept();

-- The identity, the subject, the source and the payee never move, and the figures stop moving the day the
-- agreement went live. As in 141, the freeze is expressed against `published_at` rather than against the
-- status, because the publish itself is an UPDATE made while the status is `pending_signature` and a
-- guard that froze anything but a draft would refuse the very write it stands for.
create or replace function platform_auth.pricing_commission_rate_is_immutable() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.id            is distinct from OLD.id
    or NEW.tenant_id   is distinct from OLD.tenant_id
    or NEW.ref         is distinct from OLD.ref
    or NEW.subject_kind   is distinct from OLD.subject_kind
    or NEW.subject_tenant_id is distinct from OLD.subject_tenant_id
    or NEW.subject_plan_id   is distinct from OLD.subject_plan_id
    or NEW.subject_key   is distinct from OLD.subject_key
    or NEW.source_kind   is distinct from OLD.source_kind
    or NEW.payee_kind    is distinct from OLD.payee_kind
    or NEW.payee_id      is distinct from OLD.payee_id
    or NEW.version       is distinct from OLD.version
    or NEW.supersedes_id is distinct from OLD.supersedes_id then
    raise exception '142: % is a cut agreed with % on a % for % — an agreement''s subject, its '
      'transaction and its payee are its identity, and one of them moved',
      OLD.ref, coalesce(OLD.subject_name, OLD.subject_kind), OLD.source_kind, OLD.payee_name
      using errcode = '23514';
  end if;
  if OLD.published_at is not null and (
       NEW.basis        is distinct from OLD.basis
    or NEW.value        is distinct from OLD.value
    or NEW.currency     is distinct from OLD.currency
    or NEW.floor_amount is distinct from OLD.floor_amount
    or NEW.cap          is distinct from OLD.cap) then
    raise exception '142: % has been a live agreement, so its figures are frozen: a rate a company was '
      'cut under is ended by a new version, never edited under them', OLD.ref
      using errcode = '23514';
  end if;
  if NEW.status <> 'draft' and OLD.status = 'draft'
     and NEW.status <> 'pending_signature' then
    raise exception '142: % goes from a draft to a paper, not straight to a %', OLD.ref, NEW.status
      using errcode = '23514';
  end if;
  if NEW.status = 'published' and OLD.status not in ('pending_signature','published') then
    raise exception '142: % was never a paper a second seat signed, so it cannot become a live agreement',
      OLD.ref
      using errcode = '23514';
  end if;
  return NEW;
end $$;

create trigger pricing_commission_rates_keep_their_words
  before update on pricing_commission_rates
  for each row execute function platform_auth.pricing_commission_rate_is_immutable();

-- One live agreement per subject per transaction per day, **in the book that keeps it**. The same guard
-- 140 and 141 wrote and bound the same way. The binding is not decoration here: the office's own rung is
-- filed under the register's nil uuid, which is the same letters in every office book, so an unbound walk
-- would have one office's standing cut refuse — and name the ref of — another office's draft. The gate
-- found this by opening a standing cut in a second book while the first held one.
--
-- Two published rates on one rung would make "what is this company's cut today" a question with two
-- answers, and the desk would pick one by row order.
--
-- The rung is recomputed here rather than read from `subject_key` alone: row triggers fire in alphabetical
-- order, so the guard that copies the key happens to run first (`belong` before `do_not`), but a rule that
-- a ladder is keyed on must not depend on which letter the next trigger's name starts with.
create or replace function platform_auth.pricing_one_commission_per_day() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v pricing_commission_rates%rowtype;
  v_key uuid;
begin
  if NEW.status <> 'published' then return NEW; end if;
  v_key := coalesce(NEW.subject_key,
                    platform_auth.commission_subject_key(NEW.subject_kind, NEW.subject_tenant_id,
                                                         NEW.subject_plan_id));
  select a.* into v
    from pricing_commission_rates a
   where a.tenant_id = NEW.tenant_id
     and a.id <> NEW.id
     and a.subject_key = v_key
     and a.source_kind = NEW.source_kind
     and a.status = 'published'
     and coalesce(a.effective_from, date '-infinity') <= coalesce(NEW.effective_to, date 'infinity')
     and coalesce(a.effective_to, date 'infinity') >= coalesce(NEW.effective_from, date '-infinity')
   order by a.effective_from nulls first limit 1;
  if found then
    raise exception '142: % and % both put a % cut on a % for the same days — one rung, one '
      'transaction, one answer',
      NEW.ref, v.ref, NEW.source_kind, coalesce(NEW.subject_name, NEW.subject_kind)
      using errcode = '23514';
  end if;
  return NEW;
end $$;

create trigger pricing_commission_rates_do_not_overlap
  before insert or update on pricing_commission_rates
  for each row execute function platform_auth.pricing_one_commission_per_day();

-- The book, the subject, the source word and the payee, all checked in one place, and the two names
-- copied so no desk can type them. This is 134's payee rule pointed at the agreement instead of the
-- payment: a rate that names a company the office does not have is a liability with no author.
create or replace function platform_auth.pricing_commission_names_its_book() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_book tenants%rowtype;
  v_company tenants%rowtype;
  v_plan  plans%rowtype;
  v_other tenants%rowtype;
  v_drv   drivers%rowtype;
  v_emp   employees%rowtype;
begin
  select * into v_book from tenants where id = NEW.tenant_id;
  if not found or v_book.type <> 'platform' then
    raise exception '142: a commission agreement is the office''s own act and is written in the '
      'office''s book, not in a company''s' using errcode = '23514';
  end if;

  if NEW.subject_kind = 'tenant' then
    select * into v_company from tenants where id = NEW.subject_tenant_id;
    if not found or v_company.deleted_at is not null then
      raise exception '142: the office has no company % to agree a cut with',
        NEW.subject_tenant_id using errcode = '23514';
    end if;
    if v_company.type = 'platform' then
      raise exception '142: % is the office itself — the office does not cut itself a separate rate',
        v_company.name using errcode = '23514';
    end if;
    NEW.subject_key := platform_auth.commission_subject_key('tenant', v_company.id, null);
    NEW.subject_name := v_company.name;
  elsif NEW.subject_kind = 'plan' then
    select * into v_plan from plans where id = NEW.subject_plan_id;
    if not found then
      raise exception '142: there is no plan % for the office to attach a cut to',
        NEW.subject_plan_id using errcode = '23514';
    end if;
    NEW.subject_key := platform_auth.commission_subject_key('plan', null, v_plan.id);
    NEW.subject_name := 'Plan: ' || v_plan.name;
  else
    if NEW.subject_tenant_id is not null or NEW.subject_plan_id is not null then
      raise exception '142: the office''s own cut names no company and no plan' using errcode = '23514';
    end if;
    NEW.subject_key := platform_auth.commission_subject_key('platform', null, null);
    NEW.subject_name := 'The office''s own cut';
  end if;

  if not exists (select 1 from pricing_commission_sources s where s.key = NEW.source_kind) then
    raise exception '142: "%" is not a transaction the office takes a cut from. The words it keeps: %',
      NEW.source_kind,
      (select string_agg(s.key, ', ' order by s.sort) from pricing_commission_sources s)
      using errcode = '23514';
  end if;

  if NEW.payee_kind = 'platform' then
    NEW.payee_name := v_book.name;
  elsif NEW.payee_kind = 'company' then
    select * into v_other from tenants where id = NEW.payee_id;
    if not found or v_other.deleted_at is not null then
      raise exception '142: the office has no company % to owe a cut to',
        NEW.payee_id using errcode = '23514';
    end if;
    if v_other.type = 'platform' then
      raise exception '142: % is the office itself — say "the office keeps it" instead',
        v_other.name using errcode = '23514';
    end if;
    if v_other.id = NEW.subject_tenant_id then
      raise exception '142: % would be a cut taken from % and paid straight back to them, which is a '
        'refund wearing an agreement', NEW.source_kind, v_other.name using errcode = '23514';
    end if;
    NEW.payee_name := v_other.name;
  elsif NEW.payee_kind = 'driver' then
    select * into v_drv from drivers where id = NEW.payee_id;
    if not found then
      raise exception '142: the office has no driver % to owe a cut to',
        NEW.payee_id using errcode = '23514';
    end if;
    NEW.payee_name := v_drv.full_name;
  else
    select * into v_emp from employees where id = NEW.payee_id;
    if not found then
      raise exception '142: the office has no staff member % to owe a cut to',
        NEW.payee_id using errcode = '23514';
    end if;
    NEW.payee_name := v_emp.full_name;
  end if;
  return NEW;
end $$;

create trigger pricing_commission_rates_belong_to_their_book
  before insert or update on pricing_commission_rates
  for each row execute function platform_auth.pricing_commission_names_its_book();

-- A reading of what somebody owes is kept whether it was cut, carried by a movement or voided: the
-- register of what the office asked for twice is the thing a dispute reads. 141's claims guard and 135's
-- kept-run guard in one sentence, and there is no discard door here because there is nothing a discard
-- would be for — a wrong reading is voided with the reason typed beside it.
create or replace function platform_auth.pricing_commission_reading_is_kept() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  raise exception '142: % is a reading of a cut against % and it is kept: a wrong figure is answered by '
    'a void and a new reading, never by a delete', OLD.ref, OLD.source_ref;
end $$;

create trigger pricing_commission_readings_are_kept
  before delete on pricing_commission_assessments
  for each row execute function platform_auth.pricing_commission_reading_is_kept();

-- The reading's facts never move. Exactly two writes are allowed against a row, and each of them once:
-- the discharge arm and the void arm. A figure that could be edited after the fact is 133's rule about a
-- leg, arrived at one table away from the book.
create or replace function platform_auth.pricing_commission_reading_keeps_its_facts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.id            is distinct from OLD.id
    or NEW.tenant_id   is distinct from OLD.tenant_id
    or NEW.ref         is distinct from OLD.ref
    or NEW.rate_id     is distinct from OLD.rate_id
    or NEW.rate_ref    is distinct from OLD.rate_ref
    or NEW.rate_version is distinct from OLD.rate_version
    or NEW.rate_basis  is distinct from OLD.rate_basis
    or NEW.rate_value  is distinct from OLD.rate_value
    or NEW.rate_currency is distinct from OLD.rate_currency
    or NEW.subject_kind  is distinct from OLD.subject_kind
    or NEW.subject_key   is distinct from OLD.subject_key
    or NEW.subject_name  is distinct from OLD.subject_name
    or NEW.payee_kind    is distinct from OLD.payee_kind
    or NEW.payee_id      is distinct from OLD.payee_id
    or NEW.payee_name    is distinct from OLD.payee_name
    or NEW.source_kind   is distinct from OLD.source_kind
    or NEW.source_id     is distinct from OLD.source_id
    or NEW.source_ref    is distinct from OLD.source_ref
    or NEW.source_amount is distinct from OLD.source_amount
    or NEW.currency      is distinct from OLD.currency
    or NEW.raw_amount    is distinct from OLD.raw_amount
    or NEW.figure        is distinct from OLD.figure
    or NEW.assessed_on   is distinct from OLD.assessed_on
    or NEW.assessed_by   is distinct from OLD.assessed_by
    or NEW.assessed_role is distinct from OLD.assessed_role
    or NEW.note          is distinct from OLD.note then
    raise exception '142: % is a reading, and a reading''s figure, its transaction and its author are '
      'frozen the moment it is written', OLD.ref using errcode = '23514';
  end if;
  if OLD.status <> 'assessed' and NEW.status is distinct from OLD.status then
    raise exception '142: % is already % — a reading changes its state once', OLD.ref, OLD.status
      using errcode = '23514';
  end if;
  if NEW.status = 'discharged' and (
       OLD.discharged_at is not null or OLD.voided_at is not null
    or NEW.discharged_by is null or NEW.carrier_kind is null or NEW.carrier_id is null
    or NEW.discharge_note is null) then
    raise exception '142: % cannot be discharged twice, and a discharge needs the seat, the movement '
      'and the sentence', OLD.ref using errcode = '23514';
  end if;
  if NEW.status = 'voided' and (
       OLD.voided_at is not null or OLD.discharged_at is not null
    or NEW.voided_by is null or NEW.void_reason is null) then
    raise exception '142: % cannot be voided twice, and a void needs the seat and the reason', OLD.ref
      using errcode = '23514';
  end if;
  if NEW.status = 'assessed' and (NEW.discharged_at is not null or NEW.voided_at is not null) then
    raise exception '142: % carries a discharge or a void while still an open reading', OLD.ref
      using errcode = '23514';
  end if;
  return NEW;
end $$;

create trigger pricing_commission_readings_keep_their_facts
  before update on pricing_commission_assessments
  for each row execute function platform_auth.pricing_commission_reading_keeps_its_facts();

-- ============================================================
-- 7. the arithmetic, written once
-- ============================================================

-- The raw cut, before the office's minimum and ceiling. The fourth decimal a rate was signed on survives
-- here, because the reading prints the raw figure beside the clamped one and a dispute reads both.
create or replace function platform_auth.commission_raw(
  p_basis text, p_value numeric, p_source_amount numeric
) returns numeric(14,4)
language sql immutable set search_path = public as $$
  select round(case when p_basis = 'flat' then p_value
                    else p_source_amount * p_value / 100 end, 4)
$$;

-- The figure a reading carries, worked from the one expression above. The raw cut is rounded to the pesa
-- first, then the floor lifts it, then the ceiling clamps it — in that order, because a floor is the
-- office's minimum on a small invoice and a ceiling is the most one transaction contributes. `floor <=
-- cap` is the table's own CHECK, so the clamp can never land under the lift; and a lift is kept when no
-- ceiling was written, because an office that sets a minimum means it whether or not it also set a most.
create or replace function platform_auth.commission_figure(
  p_basis text, p_value numeric, p_source_amount numeric, p_floor numeric, p_cap numeric
) returns numeric(14,2)
language sql immutable set search_path = public as $$
  select round(least(y.lifted, coalesce(p_cap, y.lifted)), 2)
  from (select platform_auth.commission_raw(p_basis, p_value, p_source_amount) as raw) x
  cross join lateral (select greatest(x.raw, coalesce(p_floor, 0)) as lifted) y
$$;

-- The transaction, read out of its own register. One body knows which column of which table holds a
-- figure, what state makes it real and what the clerk would call its reference; the census in section 15
-- refuses to finish if a source word is missing from the case below.
--
-- Returns `{ok, amount, currency, ref, company, on_day}` or `{ok:false, error, message}`. A refund, a
-- cancellation or a declined payout is refused, not assessed at zero: an assessment of a transaction the
-- office never had money in is exactly the liability this migration promises not to make.
create or replace function platform_auth.commission_source_said(
  p_source_kind text, p_source_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_inv  record;
  v_pay  record;
  v_fin  record;
  v_fex  record;
  v_pay2 record;
begin
  if p_source_kind = 'subscription_invoice' then
    select id, number, tenant_id, amount_total, currency, status, issued_at::date as on_day
      into v_inv from invoices where id = p_source_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'no_source',
        'message', 'There is no subscription invoice with that id, so there is nothing to cut.');
    end if;
    if v_inv.status in ('void','draft') then
      return jsonb_build_object('ok', false, 'error', 'source_is_not_real', 'status', v_inv.status,
        'message', 'Invoice ' || v_inv.number || ' is ' || v_inv.status
          || '. A cut is taken from a paper the office actually issued.');
    end if;
    if v_inv.amount_total <= 0 then
      return jsonb_build_object('ok', false, 'error', 'source_is_empty',
        'message', 'Invoice ' || v_inv.number || ' totals nothing, and a cut of a nothing is a row '
          || 'nobody owes.');
    end if;
    return jsonb_build_object('ok', true, 'amount', v_inv.amount_total, 'currency', v_inv.currency,
      'ref', v_inv.number, 'company', v_inv.tenant_id, 'on_day', v_inv.on_day,
      'state', v_inv.status);
  end if;

  if p_source_kind = 'subscription_payment' then
    select id, intent_reference, tenant_id, amount, currency, status, completed_at::date as on_day
      into v_pay from payments where id = p_source_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'no_source',
        'message', 'There is no payment with that id, so there is nothing to cut.');
    end if;
    if v_pay.status <> 'approved' then
      return jsonb_build_object('ok', false, 'error', 'source_is_not_real', 'status', v_pay.status,
        'message', 'Payment ' || v_pay.intent_reference || ' is ' || v_pay.status
          || '. A cut on money that did not arrive is a liability the office invented.');
    end if;
    if v_pay.on_day is null then
      return jsonb_build_object('ok', false, 'error', 'source_is_not_real',
        'message', 'Payment ' || v_pay.intent_reference || ' was approved without a completion time, '
          || 'so no day can be said for its rate.');
    end if;
    if v_pay.amount <= 0 then
      return jsonb_build_object('ok', false, 'error', 'source_is_empty',
        'message', 'Payment ' || v_pay.intent_reference || ' carried nothing.');
    end if;
    return jsonb_build_object('ok', true, 'amount', v_pay.amount, 'currency', v_pay.currency,
      'ref', coalesce(v_pay.intent_reference, v_pay.id::text), 'company', v_pay.tenant_id,
      'on_day', v_pay.on_day, 'state', v_pay.status);
  end if;

  if p_source_kind = 'freight_invoice' then
    select id, invoice_number, tenant_id, total, currency, status, deleted_at, issue_date as on_day
      into v_fin from freight_invoices where id = p_source_id;
    if not found or v_fin.deleted_at is not null then
      return jsonb_build_object('ok', false, 'error', 'no_source',
        'message', 'There is no freight invoice with that id, so there is nothing to cut.');
    end if;
    if v_fin.status = 'cancelled' then
      return jsonb_build_object('ok', false, 'error', 'source_is_not_real', 'status', v_fin.status,
        'message', 'Freight invoice ' || v_fin.invoice_number || ' was cancelled.');
    end if;
    if v_fin.total <= 0 then
      return jsonb_build_object('ok', false, 'error', 'source_is_empty',
        'message', 'Freight invoice ' || v_fin.invoice_number || ' totals nothing.');
    end if;
    return jsonb_build_object('ok', true, 'amount', v_fin.total, 'currency', v_fin.currency,
      'ref', v_fin.invoice_number, 'company', v_fin.tenant_id, 'on_day', v_fin.on_day,
      'state', v_fin.status);
  end if;

  if p_source_kind = 'freight_expense' then
    select id, supplier_name, tenant_id, amount, currency, status, deleted_at, expense_date as on_day
      into v_fex from freight_expenses where id = p_source_id;
    if not found or v_fex.deleted_at is not null then
      return jsonb_build_object('ok', false, 'error', 'no_source',
        'message', 'There is no freight expense with that id, so there is nothing to cut.');
    end if;
    if v_fex.status = 'cancelled' then
      return jsonb_build_object('ok', false, 'error', 'source_is_not_real', 'status', v_fex.status,
        'message', 'That freight expense was cancelled.');
    end if;
    if v_fex.amount <= 0 then
      return jsonb_build_object('ok', false, 'error', 'source_is_empty',
        'message', 'That freight expense carries nothing.');
    end if;
    return jsonb_build_object('ok', true, 'amount', v_fex.amount, 'currency', v_fex.currency,
      'ref', left(v_fex.supplier_name, 60), 'company', v_fex.tenant_id, 'on_day', v_fex.on_day,
      'state', v_fex.status);
  end if;

  -- A payout's day is the day the office agreed to move the money: `paid_at` when the cash left, and the
  -- release when it has only been accrued. `raised` and `pending_signature` have neither, `declined` never
  -- had a movement, and `failed` had one and then its mirror — so a cut on a failed payout would be the
  -- office owing a share of money that came back.
  if p_source_kind = 'payout' then
    select id, ref, tenant_id, amount, currency, status, fee_amount, payee_kind, payee_id, payee_name,
           payee_tenant_id, coalesce(paid_at, released_at)::date as on_day
      into v_pay2 from money_payouts where id = p_source_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'no_source',
        'message', 'There is no payout with that id, so there is nothing to cut.');
    end if;
    if v_pay2.status in ('raised','pending_signature','declined') then
      return jsonb_build_object('ok', false, 'error', 'source_is_not_real', 'status', v_pay2.status,
        'message', v_pay2.ref || ' is ' || v_pay2.status
          || '. A cut is taken from money the office agreed to move, not from a draft of it.');
    end if;
    if v_pay2.status = 'failed' then
      return jsonb_build_object('ok', false, 'error', 'source_is_not_real', 'status', v_pay2.status,
        'message', v_pay2.ref || ' left and came back. The accrual was answered by its mirror, so there '
          || 'is no movement for a cut to sit on.');
    end if;
    if v_pay2.on_day is null then
      return jsonb_build_object('ok', false, 'error', 'source_is_not_real',
        'message', v_pay2.ref || ' is ' || v_pay2.status || ' without a release or payment time, so no '
          || 'day can be said for its rate.');
    end if;
    -- The company a payout is *about* is the one the money lands at, not the book it was written in: a
    -- platform payout to a driver is raised in the office's book, and the office's book is not a rung the
    -- ladder can be asked about. `payee_tenant_id` is what 134's own guard copied for exactly this reason,
    -- and a payout to `other` has none — the ladder then answers from the plan or the office's own rung.
    return jsonb_build_object('ok', true, 'amount', v_pay2.amount, 'currency', v_pay2.currency,
      'ref', v_pay2.ref, 'company', v_pay2.payee_tenant_id, 'book', v_pay2.tenant_id,
      'on_day', v_pay2.on_day, 'state', v_pay2.status, 'fee_amount', v_pay2.fee_amount,
      'payee_kind', v_pay2.payee_kind, 'payee_id', v_pay2.payee_id, 'payee_name', v_pay2.payee_name);
  end if;

  return jsonb_build_object('ok', false, 'error', 'bad_source_kind', 'asked', p_source_kind,
    'message', 'The office takes a cut from these: '
      || (select string_agg(s.key, ', ' order by s.sort) from pricing_commission_sources s) || '.');
end $$;

-- ============================================================
-- 8. the paper a signature is cut on
-- ============================================================

-- One body builds the bytes, and the propose door, the apply door and the desk's preview all read the
-- same one. A second seat that signs a figure the register cannot rebuild is signing nothing: 140's and
-- 141's rule, and the reason the paper names the subject, the transaction and the payee in the words the
-- register itself uses rather than in whatever the caller passed in.
--
-- A percent is printed with its fourth decimal and a flat with its money, because those are the two
-- figures a dispute is actually about: whether the agreement was 2.5 or 2.5000 percent, and which currency
-- the flat sum was named in. `supersedes` is on the paper so a version that replaces an agreement says
-- which agreement it replaces — the second seat is signing the end of one as well as the start of another.
create or replace function platform_auth.commission_rate_paper(p_rate uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'register', 'pricing_commission_rate',
    'id', r.id::text,
    'ref', r.ref,
    'book', r.tenant_id::text,
    'subject', jsonb_build_object(
      'kind', r.subject_kind,
      'name', r.subject_name,
      'company', r.subject_tenant_id::text,
      'plan', r.subject_plan_id::text,
      -- The sentence the second seat is agreeing to, in the ladder's own voice: which rung this paper
      -- puts a figure on, and therefore which companies it will be asked of. The transaction's label is
      -- written for the top of a picker ("A freight invoice"), and this sentence carries it mid clause,
      -- so the article loses its capital — the same reason the desk that prints the cut's own line says
      -- "the office's standing cut on a freight invoice". A paper is hashed, so the fix belongs here
      -- rather than in a browser that would otherwise be rewriting what the seat signed.
      'says', case r.subject_kind
                when 'tenant' then 'the cut agreed with ' || r.subject_name
                when 'plan' then 'the cut every company on ' || r.subject_name || ' is taken at'
                else 'the office''s standing cut on ' || case when s.label is null or s.label = ''
                  then r.source_kind
                  else lower(left(s.label, 1)) || substr(s.label, 2) end
              end),
    'source', jsonb_build_object('kind', r.source_kind, 'label', s.label, 'side', s.side),
    'payee', jsonb_build_object('kind', r.payee_kind, 'name', r.payee_name, 'id', r.payee_id::text,
      'says', case when r.payee_kind = 'platform' then 'the office keeps it'
                   else 'the cut is owed out to ' || r.payee_name end),
    'basis', r.basis,
    'value', r.value::text,
    'value_said', case when r.basis = 'flat'
      then trim(to_char(r.value, 'FM999999990.9999')) || ' ' || r.currency
      else trim(to_char(r.value, 'FM999999990.9999')) || ' percent of the transaction' end,
    'currency', r.currency,
    'floor_amount', r.floor_amount::text,
    'cap', r.cap::text,
    -- The two ends of the least-and-most pair are printed beside each other rather than folded into one
    -- sentence: a seat that signs "between 5,000 and 200,000" is signing both figures, and the apply
    -- re-hash has to break if either one moved.
    'window', jsonb_build_object('effective_from', r.effective_from::text,
                                 'effective_to', r.effective_to::text),
    'version', jsonb_build_object('number', r.version,
      'supersedes', (select o.ref from pricing_commission_rates o where o.id = r.supersedes_id)),
    'note', r.note
    -- The row's state is deliberately NOT part of the paper. Proposing writes the hash and only then
    -- moves the draft to `pending_signature`, so a paper that carried the status would be a promise the
    -- register breaks by its own next statement: every apply would answer `paper_moved` and no cut could
    -- ever be published. What a second seat signs is the figure, the window, the subject, the payee and
    -- the sentence — and `pricing_commission_rate_is_immutable` plus `paper_is_out` are what hold those.
  )
  from pricing_commission_rates r
  left join pricing_commission_sources s on s.key = r.source_kind
  where r.id = p_rate
$$;

create or replace function platform_auth.commission_rate_sha256(p_rate uuid) returns text
language sql stable security definer set search_path = public as $$
  select encode(extensions.digest(
    platform_auth.commission_rate_paper(p_rate)::text, 'sha256'), 'hex')
$$;

-- The line the memory prints beside a change: what the agreement was, in one sentence short enough to
-- sit in a column. 141's `pricing_addendum_said` shape, including its clamp — a `said` that could grow
-- past 200 characters would be a history row refused by its own CHECK, and the write that produced it
-- would be lost to a length limit nobody was arguing about.
create or replace function platform_auth.pricing_commission_rate_said(
  a pricing_commission_rates
) returns text
language sql stable set search_path = public as $$
  select left(a.ref || ' ' || a.subject_name || ': '
    || case when a.basis = 'flat'
            then trim(to_char(a.value, 'FM999999990.9999')) || ' ' || a.currency
            else trim(to_char(a.value, 'FM999999990.9999')) || '%' end
    -- The transaction in its own words, not its key: this sentence is printed in the memory and on the
    -- panel, and `freight_invoice` is what the resolver matches on, not what a seat reads. `stable`, not
    -- `immutable`, because the words come out of `pricing_commission_sources` — the register's own list.
    || ' of ' || coalesce((select case when s.label is null or s.label = '' then null
              else lower(left(s.label, 1)) || substr(s.label, 2) end
         from pricing_commission_sources s where s.key = a.source_kind), a.source_kind)
    || coalesce(', at least ' || trim(to_char(a.floor_amount, 'FM99999999990.00')), '')
    || coalesce(', at most ' || trim(to_char(a.cap, 'FM99999999990.00')), '')
    || ', kept by ' || a.payee_name
    || ', v' || a.version::text
    || coalesce(' from ' || a.effective_from::text, '')
    || coalesce(' to ' || a.effective_to::text, ''), 200)
$$;

-- ============================================================
-- 9. the reads
-- ============================================================

-- The board. The filter words are checked against the register's own vocabulary rather than against a
-- list typed in plpgsql, because `p_subject` names a rung from section 1 and `p_source` a transaction
-- from section 2 — a desk that sends `payee` where the ladder says `platform` gets the sentence that
-- says which words exist, and the desk never has to keep its own copy of a word list.
create or replace function platform_auth.pricing_commission_rates(
  p_tenant uuid, p_status text, p_subject text, p_source text, p_search text, p_limit int, p_offset int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_limit int;
  v_offset int;
  v_status text;
  v_subject text;
  v_source text;
  v_rows jsonb;
  v_counts jsonb;
  v_total int;
begin
  v_limit := least(greatest(coalesce(p_limit, 30), 1), 200);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  v_status := nullif(lower(trim(coalesce(p_status, ''))), '');
  v_subject := nullif(lower(trim(coalesce(p_subject, ''))), '');
  v_source := nullif(lower(trim(coalesce(p_source, ''))), '');
  if v_status is not null and v_status not in
     ('draft','pending_signature','published','superseded','withdrawn') then
    return jsonb_build_object('ok', false, 'error', 'bad_status', 'asked', v_status,
      'message', 'A commission agreement is a draft, a paper waiting for a signature, a live cut, a '
        || 'superseded one, or a withdrawn one.');
  end if;
  if v_subject is not null and not exists (select 1 from pricing_commission_subjects s where s.key = v_subject) then
    return jsonb_build_object('ok', false, 'error', 'bad_subject', 'asked', v_subject,
      'message', 'A cut is agreed with one of these: '
        || (select string_agg(s.key, ', ' order by s.priority) from pricing_commission_subjects s) || '.');
  end if;
  if v_source is not null and not exists (select 1 from pricing_commission_sources s where s.key = v_source) then
    return jsonb_build_object('ok', false, 'error', 'bad_source', 'asked', v_source,
      'message', 'The office takes a cut from these: '
        || (select string_agg(s.key, ', ' order by s.sort) from pricing_commission_sources s) || '.');
  end if;
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no commission agreement in a book that is not here.');
  end if;

  -- The page is cut in the subquery and counted over the whole filter, for 141's reason: the heading has
  -- to describe the book, not the page. A search reaches the company the cut is agreed with, the person it
  -- is owed to and the reference on the paper — the three things a clerk actually has when they ask
  -- "did we agree a cut with KILIAN TRANSIT".
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'ref', x.ref, 'status', x.status, 'version', x.version,
           'subject_kind', x.subject_kind, 'subject_key', x.subject_key,
           'subject_name', x.subject_name, 'subject_label',
             (select s.label from pricing_commission_subjects s where s.key = x.subject_kind),
           'subject_tenant_id', x.subject_tenant_id, 'subject_plan_id', x.subject_plan_id,
           'source_kind', x.source_kind,
           'source_label', (select s.label from pricing_commission_sources s where s.key = x.source_kind),
           'source_side', (select s.side from pricing_commission_sources s where s.key = x.source_kind),
           'payee_kind', x.payee_kind, 'payee_id', x.payee_id, 'payee_name', x.payee_name,
           'basis', x.basis, 'value', x.value::text, 'currency', x.currency,
           'floor_amount', x.floor_amount::text, 'cap', x.cap::text,
           'value_said', case when x.basis = 'flat'
                              then trim(to_char(x.value, 'FM999999990.9999')) || ' ' || x.currency
                              else trim(to_char(x.value, 'FM999999990.9999')) || '%' end,
           'effective_from', x.effective_from::text, 'effective_to', x.effective_to::text,
           'live_today', (x.status = 'published'
                          and coalesce(x.effective_from, date '-infinity') <= current_date
                          and coalesce(x.effective_to, date 'infinity') >= current_date),
           'refusals', x.refusals, 'approval_id', x.approval_id,
           'approval_status', (select a.status from platform_approvals a where a.id = x.approval_id),
           'published_by', (select u.full_name from users u where u.id = x.published_by),
           'published_at', to_char(x.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'published_note', x.published_note,
           'withdrawn_reason', x.withdrawn_reason,
           'supersedes', (select o.ref from pricing_commission_rates o where o.id = x.supersedes_id),
           'readings', (select count(*)::int from pricing_commission_assessments m
                         where m.rate_id = x.id and m.voided_at is null),
           'owed', (select coalesce(sum(m.figure), 0)::text from pricing_commission_assessments m
                     where m.rate_id = x.id and m.status = 'assessed'),
           'said', x.said,
           'note', x.note,
           'updated_at', to_char(x.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
           order by x.subject_kind, x.subject_name, x.source_kind, x.version desc, x.created_at desc),
         '[]'::jsonb),
         coalesce(max(x.whole), 0)::int
    into v_rows, v_total
  from (
    -- The whole-row column is carried out for `pricing_commission_rate_said` exactly as 141 carries its
    -- own: the subquery's anonymous record cannot be cast to the table type once the planner flattens
    -- the page, so the sentence is built while the row is still the table's own.
    select a.id, a.ref, a.status, a.version, a.subject_kind, a.subject_key, a.subject_name,
           a.subject_tenant_id, a.subject_plan_id, a.source_kind, a.payee_kind, a.payee_id,
           a.payee_name, a.basis, a.value, a.currency, a.floor_amount, a.cap, a.effective_from,
           a.effective_to, a.refusals, a.approval_id, a.published_by, a.published_at,
           a.published_note, a.withdrawn_reason, a.supersedes_id, a.note, a.updated_at, a.created_at,
           platform_auth.pricing_commission_rate_said(a) as said,
           count(*) over () as whole
      from pricing_commission_rates a
     where a.tenant_id = p_tenant
       and (v_status is null or a.status = v_status)
       and (v_subject is null or a.subject_kind = v_subject)
       and (v_source is null or a.source_kind = v_source)
       and (nullif(trim(coalesce(p_search, '')), '') is null
            or a.ref ilike '%' || upper(trim(p_search)) || '%'
            or a.subject_name ilike '%' || trim(p_search) || '%'
            or a.payee_name ilike '%' || trim(p_search) || '%'
            or a.note ilike '%' || trim(p_search) || '%'
            or exists (select 1 from plans pl where pl.id = a.subject_plan_id
                        and pl.name ilike '%' || trim(p_search) || '%'))
     order by a.subject_kind, a.subject_name, a.source_kind, a.version desc, a.created_at desc
     limit v_limit offset v_offset
  ) x;

  -- Five status chips, three rungs and five transactions, each counted over the whole book. The rung and
  -- transaction chips are what make the ladder legible on the board: a clerk looking for "does any
  -- company have a negotiated cut" asks a question a status filter cannot answer.
  select coalesce(jsonb_object_agg(ch.n, cnt.n) filter (where cnt.n > 0), '{}'::jsonb)
    into v_counts
  from (values ('draft'::text), ('pending_signature'), ('published'), ('superseded'), ('withdrawn'),
               ('subj_tenant'), ('subj_plan'), ('subj_platform'),
               ('src_subscription_invoice'), ('src_subscription_payment'), ('src_freight_invoice'),
               ('src_freight_expense'), ('src_payout')) ch(n)
  cross join lateral (
    select count(*)::int as n from pricing_commission_rates a
     where a.tenant_id = p_tenant
       and (ch.n like 'subj_%'  and a.subject_kind = nullif(replace(ch.n, 'subj_', ''), '')
         or ch.n like 'src_%'   and a.source_kind = nullif(replace(ch.n, 'src_', ''), '')
         or a.status = ch.n)
  ) cnt;

  return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total,
    'counts', v_counts, 'limit', v_limit, 'offset', v_offset,
    -- The dropdowns on the desk come from the register, not from a list in the page. This is the reason
    -- section 1 and section 2 are tables at all.
    'subjects', (select coalesce(jsonb_agg(jsonb_build_object('key', s.key, 'label', s.label,
                       'priority', s.priority, 'names', s.names, 'note', s.note)
                       order by s.priority), '[]'::jsonb)
                   from pricing_commission_subjects s),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('key', s.key, 'label', s.label,
                       'side', s.side, 'sort', s.sort, 'note', s.note)
                       order by s.sort), '[]'::jsonb)
                   from pricing_commission_sources s));
end $$;

-- One agreement, with its chain, its paper, its memory and the readings taken under it. The readings ride
-- here because the question a desk asks of an agreement is never only "what is the figure" — it is "and
-- what has the figure produced".
create or replace function platform_auth.pricing_commission_rate_detail(p_tenant uuid, p_rate uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v pricing_commission_rates;
  v_versions jsonb;
  v_approval jsonb;
  v_memory jsonb;
  v_readings jsonb;
begin
  select * into v from pricing_commission_rates where id = p_rate and tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no commission agreement with that number in this book. Quote the CMR number '
        || 'printed on the paper.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'ref', s.ref, 'version', s.version, 'status', s.status, 'basis', s.basis,
           'value', s.value::text, 'currency', s.currency, 'payee_name', s.payee_name,
           'effective_from', s.effective_from::text, 'effective_to', s.effective_to::text,
           'published_at', to_char(s.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'published_by', (select u.full_name from users u where u.id = s.published_by),
           'withdrawn_reason', s.withdrawn_reason)
           order by s.version desc), '[]'::jsonb)
    into v_versions
  from pricing_commission_rates s
   where s.tenant_id = v.tenant_id and s.subject_key = v.subject_key
     and s.source_kind = v.source_kind;

  select jsonb_build_object(
           'id', a.id, 'status', a.status, 'action', a.action, 'reason', a.reason,
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
           'reason', h.reason, 'assessment_ref',
             (select m.ref from pricing_commission_assessments m where m.id = h.assessment_id),
           'actor', (select u.full_name from users u where u.id = h.actor_user_id))
           order by h.at desc), '[]'::jsonb)
    into v_memory
  from (select * from pricing_commission_history p
         where p.rate_id = v.id order by p.at desc limit 20) h;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'ref', m.ref, 'source_kind', m.source_kind, 'source_ref', m.source_ref,
           'source_amount', m.source_amount::text, 'figure', m.figure::text,
           'currency', m.currency, 'status', m.status, 'assessed_on', m.assessed_on::text,
           'carrier_ref', m.carrier_ref, 'void_reason', m.void_reason,
           'assessed_by', (select u.full_name from users u where u.id = m.assessed_by))
           order by m.assessed_on desc, m.created_at desc), '[]'::jsonb)
    into v_readings
  from (select * from pricing_commission_assessments p
         where p.rate_id = v.id order by p.assessed_on desc, p.created_at desc limit 20) m;

  return jsonb_build_object('ok', true,
    'rate', jsonb_build_object(
      'id', v.id, 'ref', v.ref, 'status', v.status, 'version', v.version,
      'subject_kind', v.subject_kind, 'subject_key', v.subject_key, 'subject_name', v.subject_name,
      'subject_tenant_id', v.subject_tenant_id, 'subject_plan_id', v.subject_plan_id,
      'source_kind', v.source_kind,
      'source_label', (select s.label from pricing_commission_sources s where s.key = v.source_kind),
      'source_side', (select s.side from pricing_commission_sources s where s.key = v.source_kind),
      'payee_kind', v.payee_kind, 'payee_id', v.payee_id, 'payee_name', v.payee_name,
      'basis', v.basis, 'value', v.value::text, 'currency', v.currency,
      'floor_amount', v.floor_amount::text, 'cap', v.cap::text,
      'effective_from', v.effective_from::text, 'effective_to', v.effective_to::text,
      'refusals', v.refusals, 'note', v.note, 'said', platform_auth.pricing_commission_rate_said(v),
      'supersedes', (select o.ref from pricing_commission_rates o where o.id = v.supersedes_id),
      'published_by', (select u.full_name from users u where u.id = v.published_by),
      'published_at', to_char(v.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'published_note', v.published_note,
      'withdrawn_by', (select u.full_name from users u where u.id = v.withdrawn_by),
      'withdrawn_at', to_char(v.withdrawn_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'withdrawn_reason', v.withdrawn_reason,
      'created_at', to_char(v.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    'paper', platform_auth.commission_rate_paper(v.id),
    -- The hash is printed so the desk can show the seat what it is signing and a dispute can compare it
    -- against the hash 121 stored. 140's and 141's pair, kept from the app role exactly as theirs is.
    'paper_sha256', platform_auth.commission_rate_sha256(v.id),
    'versions', v_versions, 'approval', v_approval, 'memory', v_memory, 'readings', v_readings);
end $$;

create or replace function platform_auth.pricing_commission_rate_memory(
  p_tenant uuid, p_rate uuid, p_limit int, p_offset int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_limit int;
  v_offset int;
  v_ref text;
  v_rows jsonb;
  v_total int;
begin
  v_limit := least(greatest(coalesce(p_limit, 40), 1), 200);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  select a.ref into v_ref from pricing_commission_rates a
   where a.id = p_rate and a.tenant_id = p_tenant;
  if v_ref is null then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no commission agreement with that number in this book.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'at', to_char(h.at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'what', h.what, 'said', h.said,
           'old_value', h.old_value, 'new_value', h.new_value, 'currency', h.currency,
           'reason', h.reason, 'approval_id', h.approval_id,
           'assessment', (select jsonb_build_object('id', m.id, 'ref', m.ref, 'status', m.status,
                       'figure', m.figure::text, 'currency', m.currency, 'source_ref', m.source_ref)
                           from pricing_commission_assessments m where m.id = h.assessment_id),
           'actor', (select u.full_name from users u where u.id = h.actor_user_id),
           'actor_role', h.actor_role) order by h.at desc, h.id), '[]'::jsonb),
         coalesce(max(h.whole), 0)::int
    into v_rows, v_total
  from (select p.*, count(*) over () as whole
          from pricing_commission_history p
         where p.rate_id = p_rate and p.tenant_id = p_tenant
         order by p.at desc, p.id
         limit v_limit offset v_offset) h;

  return jsonb_build_object('ok', true, 'ref', v_ref, 'rows', v_rows, 'total', v_total,
    'limit', v_limit, 'offset', v_offset);
end $$;

-- The ladder, walked in one office's own register. This is the body that answers the question the office
-- actually asks — "what is this company's cut on a freight invoice today?" — and it answers it by naming
-- the rung that spoke, because a figure with no author is a guess. The priority comes from section 1's
-- rows, so a later migration that decides the plan rung should outrank a negotiated one changes data and
-- not code.
--
-- The book is a parameter, not an afterthought: every rung's agreements live in the office's own register,
-- and the office's standing rung is keyed on the register's nil uuid — the same letters in every office
-- book. A walk that keyed only on the rung would answer one office's cut out of another office's tariff,
-- and `commission_subject_key` cannot tell the two books apart. So the walk names the book it reads, the
-- same way `assess_commission` and the preview's own route name it to every other door.
--
-- Nothing is invented when no rung answers: `no_rate` is returned in the voice of the register, and the
-- desk says "the cut is not zero — it has not been agreed". A resolver that returned 0 would be a way of
-- billing nobody and recording it as a decision.
--
-- The book was added to both signatures, so the old shapes are dropped here rather than left beside
-- them: a second function with the same name and no `tenant_id` in its walk is a callable, unbound
-- ladder, and `create or replace` would never remove the one dev already has. The preview is dropped
-- first only so that nothing that still calls the bare resolver is left standing when it goes.
drop function if exists platform_auth.commission_on(uuid, text, uuid);
drop function if exists platform_auth.commission_rate_in_force(uuid, text, date);
create or replace function platform_auth.commission_rate_in_force(
  p_book uuid, p_company uuid, p_source text, p_on date
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rung pricing_commission_subjects%rowtype;
  v_rate pricing_commission_rates%rowtype;
  v_plan uuid;
  v_key uuid;
begin
  if p_source is null or not exists (select 1 from pricing_commission_sources s where s.key = p_source) then
    return jsonb_build_object('ok', false, 'error', 'bad_source', 'asked', p_source,
      'message', 'The office takes a cut from these: '
        || (select string_agg(s.key, ', ' order by s.sort) from pricing_commission_sources s) || '.');
  end if;
  if p_on is null then
    return jsonb_build_object('ok', false, 'error', 'no_day',
      'message', 'A cut is agreed for days, so the question has to name one.');
  end if;

  for v_rung in select * from pricing_commission_subjects order by priority
  loop
    -- Which uuid this rung is filed under, worked out the same way the copy trigger works it out: the
    -- company's own id, its plan's id, or the office's nil. The resolver never reads `subject_key` from
    -- a hand-written row; it recomputes it, so a rung cannot be jumped by writing a wrong key.
    if v_rung.names = 'company' then
      if p_company is null then continue; end if;
      v_key := p_company;
    elsif v_rung.names = 'plan' then
      -- A plan rung only speaks while the company is actually on the plan: an expired or cancelled
      -- subscription is not an agreement the office is still cutting under.
      select s.plan_id into v_plan from subscriptions s
       where s.tenant_id = p_company
         and s.status in ('trial','active','grace')
         and s.deleted_at is null
       order by s.updated_at desc limit 1;
      if v_plan is null then continue; end if;
      v_key := v_plan;
    else
      v_key := platform_auth.commission_subject_key('platform', null, null);
    end if;

    select * into v_rate from pricing_commission_rates a
     where a.tenant_id = p_book
       and a.subject_kind = v_rung.key
       and a.subject_key = v_key
       and a.source_kind = p_source
       and a.status = 'published'
       and coalesce(a.effective_from, date '-infinity') <= p_on
       and coalesce(a.effective_to, date 'infinity') >= p_on
     order by a.version desc, a.effective_from desc nulls last
     limit 1;
    if found then
      return jsonb_build_object('ok', true,
        'rate_id', v_rate.id, 'ref', v_rate.ref, 'version', v_rate.version,
        'basis', v_rate.basis, 'value', v_rate.value::text, 'currency', v_rate.currency,
        'floor_amount', v_rate.floor_amount::text, 'cap', v_rate.cap::text,
        'effective_from', v_rate.effective_from::text, 'effective_to', v_rate.effective_to::text,
        'payee_kind', v_rate.payee_kind, 'payee_id', v_rate.payee_id, 'payee_name', v_rate.payee_name,
        'subject_kind', v_rate.subject_kind, 'subject_name', v_rate.subject_name,
        'said', platform_auth.pricing_commission_rate_said(v_rate),
        -- Which rung spoke, and what it spoke about: the desk prints this beside the figure, and a
        -- dispute reads it first.
        'rung', jsonb_build_object('key', v_rung.key, 'label', v_rung.label,
                                   'priority', v_rung.priority, 'names', v_rung.names),
        'rung_key', v_key, 'asked_on', p_on::text);
    end if;
  end loop;

  return jsonb_build_object('ok', false, 'error', 'no_rate', 'asked_company', p_company,
    'asked_source', p_source, 'asked_on', p_on::text,
    'ladder', (select coalesce(jsonb_agg(jsonb_build_object('key', s.key, 'label', s.label,
                    'priority', s.priority) order by s.priority), '[]'::jsonb)
                 from pricing_commission_subjects s),
    'message', 'No agreement puts a cut on ' || p_source || ' for this day. The cut is not zero — it has '
      || 'not been agreed on any rung: not with the company, not on its plan, and not as the office''s '
      || 'own standing cut.');
end $$;

-- The preview: a book, a transaction and a question, answered in one read. The figure is computed here
-- from the source's own amount and the rate's own words, so the desk cannot show one number and the door
-- write another — 140's `price_a_job` reason, one table away from the book.
--
-- The book is `$1`, like every other door here: the preview is the promise that `assess_commission` keeps,
-- and that door takes the office's book as its first parameter and refuses a seat that is not the office.
-- A preview that walked the ladder without naming a book would answer one office's question out of
-- another office's register, and the two would disagree with each other rather than with the caller.
--
-- The amount is never taken from the caller. `commission_source_said` reads it out of the register that
-- owns it, and an existing live reading of the same transaction is returned beside the preview so a clerk
-- sees "this has already been cut at CMA-2026-00007" before pressing anything.
create or replace function platform_auth.commission_on(
  p_book uuid, p_company uuid, p_source_kind text, p_source_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_src jsonb;
  v_rate jsonb;
  v_on date;
  v_amount numeric;
  v_money text;
  v_figure numeric(14,2);
  v_raw numeric(14,4);
  v_existing jsonb;
begin
  v_src := platform_auth.commission_source_said(p_source_kind, p_source_id);
  if v_src ->> 'ok' <> 'true' then
    return v_src;
  end if;
  v_amount := (v_src ->> 'amount')::numeric;
  v_money := v_src ->> 'currency';
  -- The day is the transaction's, not today's: an invoice for March is cut at March's agreement.
  v_on := (v_src ->> 'on_day')::date;

  -- The rung is read from the transaction's own company and from no other, because this preview is a
  -- promise about what `assess_commission` writes — and that door has no caller company to ask with. A
  -- desk that names a company the paper does not belong to is shown a refusal rather than a figure the
  -- register would never take: 140's rule that a price worked out in two places disagrees in the third,
  -- kept for a cut.
  if p_company is not null and v_src ->> 'company' is not null
     and (v_src ->> 'company')::uuid <> p_company then
    return jsonb_build_object('ok', false, 'error', 'asked_other_book',
      'asked_company', p_company, 'source', v_src, 'figure', null,
      'message', (v_src ->> 'ref') || ' is filed under another company than the one asked about, so the '
        || 'rung printed here is not the rung it is cut under. Ask about the company the transaction '
        || 'belongs to — or ask with no company at all, which reads the same ladder the door writes.');
  end if;

  v_rate := platform_auth.commission_rate_in_force(p_book, (v_src ->> 'company')::uuid,
                                                   p_source_kind, v_on);
  if v_rate ->> 'ok' <> 'true' then
    return jsonb_build_object('ok', true, 'answer', 'no_rate', 'source', v_src, 'rate', v_rate,
      'figure', null, 'message', v_rate ->> 'message');
  end if;
  -- A flat cut named in one money is not worked out of a transaction in another. This is the mismatch
  -- 138 found in a count, refused here before a desk is shown a figure at all.
  if v_rate ->> 'basis' = 'flat' and v_rate ->> 'currency' <> v_money then
    return jsonb_build_object('ok', true, 'answer', 'money_mismatch', 'source', v_src, 'rate', v_rate,
      'figure', null, 'asked_currency', v_money, 'rate_currency', v_rate ->> 'currency',
      'message', v_rate ->> 'ref' || ' is a flat cut in ' || (v_rate ->> 'currency') || ', and '
        || (v_src ->> 'ref') || ' is in ' || v_money || '. A figure in one money is not taken out of '
        || 'another; make a second agreement in ' || v_money || '.');
  end if;

  v_raw := platform_auth.commission_raw(v_rate ->> 'basis', (v_rate ->> 'value')::numeric, v_amount);
  v_figure := platform_auth.commission_figure(v_rate ->> 'basis', (v_rate ->> 'value')::numeric,
    v_amount,
    nullif(v_rate ->> 'floor_amount', '')::numeric, nullif(v_rate ->> 'cap', '')::numeric);

  select jsonb_build_object('id', m.id, 'ref', m.ref, 'status', m.status, 'figure', m.figure::text,
    'currency', m.currency, 'assessed_on', m.assessed_on::text, 'rate_ref', m.rate_ref,
    'carrier_ref', m.carrier_ref, 'void_reason', m.void_reason,
    'assessed_by', (select u.full_name from users u where u.id = m.assessed_by))
    into v_existing
  from pricing_commission_assessments m
   where m.source_kind = p_source_kind and m.source_id = p_source_id and m.voided_at is null
   order by m.created_at desc limit 1;

  return jsonb_build_object('ok', true, 'answer', 'cut',
    'source', v_src, 'rate', v_rate,
    'raw', v_raw::text, 'figure', v_figure::text, 'currency', v_money,
    -- Which of the three steps moved the figure, said apart: a cut that came out at 30,000 because the
    -- agreement set that least is not a cut that was rounded, and the desk prints a different sentence
    -- for each. Both are false when the raw cut was already the answer.
    'rounded', (v_raw <> round(v_raw, 2)),
    'lifted', (nullif(v_rate ->> 'floor_amount', '')::numeric is not null
               and v_figure > round(v_raw, 2)),
    'clamped', (nullif(v_rate ->> 'cap', '')::numeric is not null
                and v_figure < round(v_raw, 2)),
    'already_assessed', v_existing,
    'asked_on', v_on::text);
end $$;

-- The readings board. A cut is asked about by transaction far more often than by agreement — "has this
-- invoice been cut?" — so the search reaches the transaction's reference and the reading's own number,
-- and the date filter is the day the reading was taken for, which is what a month-end question is about.
create or replace function platform_auth.pricing_commission_assessments(
  p_tenant uuid, p_status text, p_source text, p_search text, p_from date, p_to date,
  p_limit int, p_offset int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_limit int;
  v_offset int;
  v_status text;
  v_source text;
  v_rows jsonb;
  v_counts jsonb;
  v_total int;
begin
  v_limit := least(greatest(coalesce(p_limit, 30), 1), 200);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  v_status := nullif(lower(trim(coalesce(p_status, ''))), '');
  v_source := nullif(lower(trim(coalesce(p_source, ''))), '');
  if v_status is not null and v_status not in ('assessed','discharged','voided') then
    return jsonb_build_object('ok', false, 'error', 'bad_status', 'asked', v_status,
      'message', 'A reading is open, carried by a movement, or voided.');
  end if;
  if v_source is not null and not exists (select 1 from pricing_commission_sources s where s.key = v_source) then
    return jsonb_build_object('ok', false, 'error', 'bad_source', 'asked', v_source,
      'message', 'The office takes a cut from these: '
        || (select string_agg(s.key, ', ' order by s.sort) from pricing_commission_sources s) || '.');
  end if;
  if p_from is not null and p_to is not null and p_to < p_from then
    return jsonb_build_object('ok', false, 'error', 'bad_window',
      'message', 'The last day cannot come before the first day.');
  end if;
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no reading in a book that is not here.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'ref', x.ref, 'status', x.status,
           'rate_id', x.rate_id, 'rate_ref', x.rate_ref, 'rate_version', x.rate_version,
           'rate_basis', x.rate_basis, 'rate_value', x.rate_value, 'rate_currency', x.rate_currency,
           'subject_kind', x.subject_kind, 'subject_name', x.subject_name,
           'payee_kind', x.payee_kind, 'payee_id', x.payee_id, 'payee_name', x.payee_name,
           'source_kind', x.source_kind, 'source_id', x.source_id, 'source_ref', x.source_ref,
           'source_amount', x.source_amount::text, 'raw_amount', x.raw_amount::text,
           'figure', x.figure::text, 'currency', x.currency,
           'assessed_on', x.assessed_on::text, 'note', x.note,
           'assessed_by', (select u.full_name from users u where u.id = x.assessed_by),
           'assessed_role', x.assessed_role,
           'discharged_at', to_char(x.discharged_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'discharged_by', (select u.full_name from users u where u.id = x.discharged_by),
           'carrier_kind', x.carrier_kind, 'carrier_ref', x.carrier_ref,
           'discharge_note', x.discharge_note,
           'voided_at', to_char(x.voided_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'voided_by', (select u.full_name from users u where u.id = x.voided_by),
           'void_reason', x.void_reason,
           'created_at', to_char(x.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
           order by x.assessed_on desc, x.created_at desc), '[]'::jsonb),
         coalesce(max(x.whole), 0)::int
    into v_rows, v_total
  from (
    select m.*, count(*) over () as whole
      from pricing_commission_assessments m
     where m.tenant_id = p_tenant
       and (v_status is null or m.status = v_status)
       and (v_source is null or m.source_kind = v_source)
       and (p_from is null or m.assessed_on >= p_from)
       and (p_to is null or m.assessed_on <= p_to)
       and (nullif(trim(coalesce(p_search, '')), '') is null
            or m.ref ilike '%' || upper(trim(p_search)) || '%'
            or m.source_ref ilike '%' || trim(p_search) || '%'
            or m.rate_ref ilike '%' || upper(trim(p_search)) || '%'
            or m.subject_name ilike '%' || trim(p_search) || '%'
            or m.payee_name ilike '%' || trim(p_search) || '%')
     order by m.assessed_on desc, m.created_at desc
     limit v_limit offset v_offset
  ) x;

  select coalesce(jsonb_object_agg(ch.n, cnt.n) filter (where cnt.n > 0), '{}'::jsonb)
    into v_counts
  from (values ('assessed'::text), ('discharged'), ('voided'),
               ('src_subscription_invoice'), ('src_subscription_payment'), ('src_freight_invoice'),
               ('src_freight_expense'), ('src_payout')) ch(n)
  cross join lateral (
    select count(*)::int as n from pricing_commission_assessments m
     where m.tenant_id = p_tenant
       and (ch.n like 'src_%' and m.source_kind = nullif(replace(ch.n, 'src_', ''), '')
            or m.status = ch.n)
  ) cnt;

  return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'counts', v_counts,
    'limit', v_limit, 'offset', v_offset, 'from', p_from::text, 'to', p_to::text);
end $$;

create or replace function platform_auth.pricing_commission_reading_detail(p_tenant uuid,
  p_assessment uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  m pricing_commission_assessments;
  v_rate jsonb;
  v_memory jsonb;
  v_source jsonb;
  v_carrier jsonb;
begin
  select * into m from pricing_commission_assessments
   where id = p_assessment and tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no reading with that number in this book. Quote the CMA number.');
  end if;

  select jsonb_build_object('id', a.id, 'ref', a.ref, 'status', a.status, 'version', a.version,
    'basis', a.basis, 'value', a.value::text, 'currency', a.currency, 'payee_kind', a.payee_kind,
    'payee_name', a.payee_name, 'effective_from', a.effective_from::text,
    'effective_to', a.effective_to::text,
    'said', platform_auth.pricing_commission_rate_said(a))
    into v_rate
  from pricing_commission_rates a where a.id = m.rate_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'at', to_char(h.at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'what', h.what, 'said', h.said,
           'old_value', h.old_value, 'new_value', h.new_value, 'currency', h.currency,
           'reason', h.reason,
           'actor', (select u.full_name from users u where u.id = h.actor_user_id))
           order by h.at desc), '[]'::jsonb)
    into v_memory
  from pricing_commission_history h
   where h.assessment_id = m.id;

  -- The transaction as it stands now, read through the one body that knows its register. A reading whose
  -- transaction has since been refunded or declined is shown with that fact beside it rather than hidden:
  -- the office still holds the paper that says it asked for the cut.
  v_source := platform_auth.commission_source_said(m.source_kind, m.source_id);

  if m.carrier_kind = 'payout' then
    select jsonb_build_object('kind', 'payout', 'id', p.id, 'ref', p.ref, 'status', p.status,
      'amount', p.amount::text, 'fee_amount', p.fee_amount::text, 'currency', p.currency,
      'payee_kind', p.payee_kind, 'payee_name', p.payee_name,
      'released_at', to_char(p.released_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'paid_at', to_char(p.paid_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      into v_carrier
    from money_payouts p where p.id = m.carrier_id;
  elsif m.carrier_kind = 'posting' then
    select jsonb_build_object('kind', 'posting', 'id', s.id, 'ref', s.ref, 'status', s.status,
      'total', s.total::text, 'currency', s.currency, 'posted_on', s.posted_on::text,
      'memo', s.memo,
      'legs', (select coalesce(jsonb_agg(jsonb_build_object(
                 'account', ac.code, 'direction', e.direction, 'amount', e.amount::text)
                 order by e.direction, ac.code), '[]'::jsonb)
                 from money_entries e join money_accounts ac on ac.id = e.account_id
                where e.posting_id = s.id))
      into v_carrier
    from money_postings s where s.id = m.carrier_id;
  end if;

  return jsonb_build_object('ok', true, 'reading', m, 'rate', v_rate, 'memory', v_memory,
    'source_now', v_source, 'carrier', v_carrier);
end $$;

-- What the office is owed and what it has paid out, over a window, counted per money. 138's rule is the
-- whole design here: TZS and USD figures are summed apart and returned apart, and a desk that wants a
-- single number has to say which money it means. A voided reading is counted in its own column and
-- excluded from every other, because the register keeps the mistake and the mistake is not owed.
create or replace function platform_auth.pricing_commission_summary(
  p_tenant uuid, p_from date, p_to date
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rows jsonb;
  v_by_source jsonb;
  v_by_payee jsonb;
begin
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no cut to count in a book that is not here.');
  end if;
  if p_from is not null and p_to is not null and p_to < p_from then
    return jsonb_build_object('ok', false, 'error', 'bad_window',
      'message', 'The last day cannot come before the first day.');
  end if;

  -- Per money, in one pass: 138's rule is the whole design here. A voided reading is counted in its own
  -- column and excluded from every other, because the register keeps the mistake and the mistake is not
  -- owed.
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', g.currency,
           'reading_count', g.reading_count,
           'open_count', g.open_count, 'open_amount', g.open_amount::text,
           'discharged_count', g.discharged_count, 'discharged_amount', g.discharged_amount::text,
           'void_count', g.void_count, 'void_amount', g.void_amount::text,
           'owed_to_others_amount', g.out_amount::text,
           'kept_by_office_amount', g.in_amount::text)
           order by g.currency), '[]'::jsonb)
    into v_rows
  from (
    select m.currency,
      count(*)::int as reading_count,
      count(*) filter (where m.status = 'assessed')::int as open_count,
      coalesce(sum(m.figure) filter (where m.status = 'assessed'), 0)::numeric(14,2) as open_amount,
      count(*) filter (where m.status = 'discharged')::int as discharged_count,
      coalesce(sum(m.figure) filter (where m.status = 'discharged'), 0)::numeric(14,2)
        as discharged_amount,
      count(*) filter (where m.status = 'voided')::int as void_count,
      coalesce(sum(m.figure) filter (where m.status = 'voided'), 0)::numeric(14,2) as void_amount,
      coalesce(sum(m.figure) filter (where m.status <> 'voided' and m.payee_kind <> 'platform'),
        0)::numeric(14,2) as out_amount,
      coalesce(sum(m.figure) filter (where m.status <> 'voided' and m.payee_kind = 'platform'),
        0)::numeric(14,2) as in_amount
    from pricing_commission_assessments m
     where m.tenant_id = p_tenant
       and (p_from is null or m.assessed_on >= p_from)
       and (p_to is null or m.assessed_on <= p_to)
     group by m.currency
  ) g;

  -- The two breakdowns are their own passes rather than lateral subqueries folded into the group above:
  -- a cut is grouped by transaction and by payee in different money, and one aggregate per question is
  -- the only shape that cannot silently mix the two.
  -- The two breakdowns are their own passes rather than aggregates folded into the group above: a cut is
  -- grouped by transaction and by payee in different money, and one aggregate per question is the only
  -- shape that cannot silently mix the two monies. Voided readings leave both.
  select coalesce(jsonb_agg(jsonb_build_object('currency', b.currency, 'parts', b.parts)
           order by b.currency), '[]'::jsonb)
    into v_by_source
  from (
    select s.currency,
           jsonb_object_agg(s.source_kind, s.n order by s.source_kind) as parts
      from (select m.currency, m.source_kind, sum(m.figure)::numeric(14,2) as n
              from pricing_commission_assessments m
             where m.tenant_id = p_tenant and m.status <> 'voided'
               and (p_from is null or m.assessed_on >= p_from)
               and (p_to is null or m.assessed_on <= p_to)
             group by m.currency, m.source_kind) s
     group by s.currency
  ) b;

  select coalesce(jsonb_agg(jsonb_build_object('currency', b.currency, 'parts', b.parts)
           order by b.currency), '[]'::jsonb)
    into v_by_payee
  from (
    select s.currency,
           jsonb_object_agg(s.payee_kind, s.n order by s.payee_kind) as parts
      from (select m.currency, m.payee_kind, sum(m.figure)::numeric(14,2) as n
              from pricing_commission_assessments m
             where m.tenant_id = p_tenant and m.status <> 'voided'
               and (p_from is null or m.assessed_on >= p_from)
               and (p_to is null or m.assessed_on <= p_to)
             group by m.currency, m.payee_kind) s
     group by s.currency
  ) b;

  return jsonb_build_object('ok', true, 'from', p_from::text, 'to', p_to::text,
    'by_currency', v_rows, 'by_source', v_by_source, 'by_payee', v_by_payee,
    'note', 'The figures are summed per money and never together: a TZS cut and a USD cut are two '
      || 'answers, and a total of both is 138''s defect.');
end $$;

-- What may be named in an id. A rung is agreed with a company or inherited from a plan, a cut owed out
-- names a company, a driver or a staff member, a reading is taken against one of the five transactions and
-- is carried by a payout or a posting — ten lists, in ten registers this card does not own and, on a
-- pricing seat, cannot read. Without this door every one of those fields is an uuid a clerk pastes off
-- another desk, which is the case 134 answered with `money_payees` and 141 never had to face because a
-- code's subject is typed by the person spending it. The names printed here are the names
-- `pricing_commission_names_its_book` copies onto the row and the validity rules are the resolver's own, so
-- a picker cannot offer an id the register would refuse.
create or replace function platform_auth.pricing_commission_choices(
  p_tenant uuid, p_kind text, p_search text, p_limit int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_kind text;
  v_search text;
  v_limit int;
  v_rows jsonb;
  v_matched int;
begin
  v_kind := lower(trim(coalesce(nullif(trim(p_kind), ''), 'company')));
  v_search := nullif(trim(coalesce(p_search, '')), '');
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null
                   and t.type = 'platform') then
    return jsonb_build_object('ok', false, 'error', 'not_the_office',
      'message', 'Only the office that agrees a cut looks for somebody to agree it with.');
  end if;
  if v_kind not in ('company','plan','driver','staff','subscription_invoice','subscription_payment',
                    'freight_invoice','freight_expense','payout','posting') then
    return jsonb_build_object('ok', false, 'error', 'bad_kind', 'asked', p_kind,
      'message', 'A cut is agreed with a company or a plan, owed out to a company, a driver or a staff '
        || 'member, taken from one of these: '
        || (select string_agg(s.key, ', ' order by s.sort) from pricing_commission_sources s)
        || ', and carried by a payout or a posting.');
  end if;
  -- A plan list is a handful of rows and a clerk needs to see all of them to know which one to pick; a
  -- company list is everybody the platform has ever registered, so it is only ever a list on a word. The
  -- transaction lists are cut the other way — most recent first, a word optional — because a clerk who has
  -- just been told "take the cut on INV-2026-00114" knows the number, not the letter.
  if v_kind in ('company','driver','staff') and v_search is not null and char_length(v_search) < 2 then
    return jsonb_build_object('ok', false, 'error', 'search_too_short',
      'message', 'Two characters at least, or no word at all — a one-letter name search is a list of '
        || 'everybody.');
  end if;

  if v_kind = 'company' then
    select coalesce(jsonb_agg(x.row_json order by x.name, x.id), '[]'::jsonb),
           coalesce(max(x.matched), 0)::int
      into v_rows, v_matched
      from (
        select t.name as name, t.id as id, count(*) over () as matched, jsonb_build_object(
          'kind', 'company', 'id', t.id, 'name', t.name,
          'detail', t.type || ' · ' || t.status
                   || (case when pl.name is not null then ' · ' || pl.name else ' · no plan' end),
          'plan', pl.name,
          'agreements', (select count(*)::int from pricing_commission_rates a
                          where a.tenant_id = p_tenant and a.subject_kind = 'tenant'
                            and a.subject_tenant_id = t.id
                            and a.status in ('draft','pending_signature','published'))) as row_json
          from tenants t
          left join plans pl on pl.id = t.plan_id
         where t.type <> 'platform' and t.deleted_at is null
           and (v_search is null or t.name ilike '%' || v_search || '%'
                             or pl.name ilike '%' || v_search || '%')
         order by t.name limit v_limit
      ) x;
  elsif v_kind = 'plan' then
    select coalesce(jsonb_agg(x.row_json order by x.price, x.name, x.id), '[]'::jsonb),
           coalesce(max(x.matched), 0)::int
      into v_rows, v_matched
      from (
        select pl.price_monthly as price, pl.name as name, pl.id as id, count(*) over () as matched,
               jsonb_build_object(
          'kind', 'plan', 'id', pl.id, 'name', 'Plan: ' || pl.name, 'key', pl.key,
          'detail', pl.key || ' · ' || trim(to_char(pl.price_monthly, 'FM999999990')) || ' '
                   || pl.currency || ' a month · ' || pl.seat_limit || ' seats'
                   || (case when not pl.is_active then ' · retired' else '' end),
          'active', pl.is_active,
          'companies', (select count(*)::int from tenants t
                         where t.plan_id = pl.id and t.deleted_at is null
                           and t.type <> 'platform'),
          'agreements', (select count(*)::int from pricing_commission_rates a
                          where a.tenant_id = p_tenant and a.subject_kind = 'plan'
                            and a.subject_plan_id = pl.id
                            and a.status in ('draft','pending_signature','published'))) as row_json
          from plans pl
         where v_search is null or pl.name ilike '%' || v_search || '%'
                                 or pl.key ilike '%' || v_search || '%'
         order by pl.price_monthly, pl.name limit v_limit
      ) x;
  elsif v_kind = 'driver' then
    select coalesce(jsonb_agg(x.row_json order by x.name, x.id), '[]'::jsonb),
           coalesce(max(x.matched), 0)::int
      into v_rows, v_matched
      from (
        select d.full_name as name, d.id as id, count(*) over () as matched, jsonb_build_object(
          'kind', 'driver', 'id', d.id, 'name', d.full_name, 'company', t.name,
          'detail', d.status || ' · ' || t.name
                   || (case when d.deleted_at is not null then ' · off the book' else '' end),
          'archived', d.deleted_at is not null) as row_json
          from drivers d join tenants t on t.id = d.tenant_id
         where t.deleted_at is null
           and (v_search is null or d.full_name ilike '%' || v_search || '%'
                               or t.name ilike '%' || v_search || '%')
         order by d.full_name limit v_limit
      ) x;
  elsif v_kind = 'staff' then
    select coalesce(jsonb_agg(x.row_json order by x.name, x.id), '[]'::jsonb),
           coalesce(max(x.matched), 0)::int
      into v_rows, v_matched
      from (
        select e.full_name as name, e.id as id, count(*) over () as matched, jsonb_build_object(
          'kind', 'staff', 'id', e.id, 'name', e.full_name, 'company', t.name,
          'detail', coalesce(nullif(trim(e.job_title), ''), 'staff') || ' · ' || e.status
                   || ' · ' || t.name
                   || (case when e.deleted_at is not null then ' · off the book' else '' end),
          'archived', e.deleted_at is not null) as row_json
          from employees e join tenants t on t.id = e.tenant_id
         where t.deleted_at is null
           and (v_search is null or e.full_name ilike '%' || v_search || '%'
                               or t.name ilike '%' || v_search || '%')
         order by e.full_name limit v_limit
      ) x;

  -- The five transaction lists. Each WHERE is the arm in `commission_source_said` that prices the same
  -- row, restated: an invoice the resolver answers `source_is_not_real` for has no business being offered
  -- on a picker, and the readings count is here because `assess_commission` refuses a second reading of
  -- one cut for one payee — a clerk who can see that a paper is already cut does not have to press and be
  -- refused to learn it. Money figures are listed because the cut is a share of them: the same figures
  -- `commission_on` already prints for any seat holding the pricing duty.
  elsif v_kind = 'subscription_invoice' then
    select coalesce(jsonb_agg(x.row_json order by x.on_day desc nulls last, x.ref, x.id), '[]'::jsonb),
           coalesce(max(x.matched), 0)::int
      into v_rows, v_matched
      from (
        select i.id as id, i.issued_at::date as on_day, i.number as ref, count(*) over () as matched,
               jsonb_build_object(
          'kind', 'subscription_invoice', 'id', i.id, 'ref', i.number,
          'amount', i.amount_total::text, 'currency', i.currency, 'state', i.status,
          'company', t.name, 'company_tenant_id', i.tenant_id, 'on_day', i.issued_at::date,
          'detail', i.number || ' · ' || trim(to_char(i.amount_total, 'FM999999990.00')) || ' '
                   || i.currency || ' · ' || coalesce(t.name, 'no company')
                   || ' · ' || i.issued_at::date,
          'readings', (select count(*)::int from pricing_commission_assessments m
                        where m.source_kind = 'subscription_invoice' and m.source_id = i.id
                          and m.voided_at is null)) as row_json
          from invoices i left join tenants t on t.id = i.tenant_id
         where i.status not in ('void','draft') and i.amount_total > 0
           and (v_search is null or i.number ilike '%' || v_search || '%'
                             or t.name ilike '%' || v_search || '%')
         order by i.issued_at desc limit v_limit
      ) x;
  elsif v_kind = 'subscription_payment' then
    select coalesce(jsonb_agg(x.row_json order by x.on_day desc nulls last, x.ref, x.id), '[]'::jsonb),
           coalesce(max(x.matched), 0)::int
      into v_rows, v_matched
      from (
        select p.id as id, p.completed_at::date as on_day,
               coalesce(p.intent_reference, p.id::text) as ref, count(*) over () as matched,
               jsonb_build_object(
          'kind', 'subscription_payment', 'id', p.id,
          'ref', coalesce(p.intent_reference, p.id::text),
          'amount', p.amount::text, 'currency', p.currency, 'state', p.status,
          'company', t.name, 'company_tenant_id', p.tenant_id, 'on_day', p.completed_at::date,
          'detail', coalesce(p.intent_reference, left(p.id::text, 8)) || ' · '
                   || trim(to_char(p.amount, 'FM999999990.00')) || ' ' || p.currency
                   || ' · ' || coalesce(t.name, 'no company') || ' · ' || p.completed_at::date,
          'readings', (select count(*)::int from pricing_commission_assessments m
                        where m.source_kind = 'subscription_payment' and m.source_id = p.id
                          and m.voided_at is null)) as row_json
          from payments p left join tenants t on t.id = p.tenant_id
         where p.status = 'approved' and p.completed_at is not null and p.amount > 0
           and (v_search is null or p.intent_reference ilike '%' || v_search || '%'
                             or t.name ilike '%' || v_search || '%')
         order by p.completed_at desc limit v_limit
      ) x;
  elsif v_kind = 'freight_invoice' then
    select coalesce(jsonb_agg(x.row_json order by x.on_day desc nulls last, x.ref, x.id), '[]'::jsonb),
           coalesce(max(x.matched), 0)::int
      into v_rows, v_matched
      from (
        select f.id as id, f.issue_date as on_day, f.invoice_number as ref, count(*) over () as matched,
               jsonb_build_object(
          'kind', 'freight_invoice', 'id', f.id, 'ref', f.invoice_number,
          'amount', f.total::text, 'currency', f.currency, 'state', f.status,
          'company', t.name, 'company_tenant_id', f.tenant_id, 'on_day', f.issue_date,
          'detail', f.invoice_number || ' · ' || trim(to_char(f.total, 'FM999999990.00')) || ' '
                   || f.currency || ' · ' || coalesce(t.name, 'no company')
                   || ' · ' || coalesce(f.issue_date::text, 'no day'),
          'readings', (select count(*)::int from pricing_commission_assessments m
                        where m.source_kind = 'freight_invoice' and m.source_id = f.id
                          and m.voided_at is null)) as row_json
          from freight_invoices f left join tenants t on t.id = f.tenant_id
         where f.deleted_at is null and f.status <> 'cancelled' and f.total > 0
           and (v_search is null or f.invoice_number ilike '%' || v_search || '%'
                             or t.name ilike '%' || v_search || '%')
         order by f.issue_date desc nulls last, f.created_at desc limit v_limit
      ) x;
  elsif v_kind = 'freight_expense' then
    select coalesce(jsonb_agg(x.row_json order by x.on_day desc nulls last, x.ref, x.id), '[]'::jsonb),
           coalesce(max(x.matched), 0)::int
      into v_rows, v_matched
      from (
        select x2.id as id, x2.expense_date as on_day, left(x2.supplier_name, 60) as ref,
               count(*) over () as matched,
               jsonb_build_object(
          'kind', 'freight_expense', 'id', x2.id, 'ref', left(x2.supplier_name, 60),
          'amount', x2.amount::text, 'currency', x2.currency, 'state', x2.status,
          'company', t.name, 'company_tenant_id', x2.tenant_id, 'on_day', x2.expense_date,
          'detail', left(x2.supplier_name, 60) || ' · '
                   || trim(to_char(x2.amount, 'FM999999990.00')) || ' ' || x2.currency
                   || ' · ' || coalesce(t.name, 'no company')
                   || ' · ' || coalesce(x2.expense_date::text, 'no day'),
          'readings', (select count(*)::int from pricing_commission_assessments m
                        where m.source_kind = 'freight_expense' and m.source_id = x2.id
                          and m.voided_at is null)) as row_json
          from freight_expenses x2 left join tenants t on t.id = x2.tenant_id
         where x2.deleted_at is null and x2.status <> 'cancelled' and x2.amount > 0
           and (v_search is null or x2.supplier_name ilike '%' || v_search || '%'
                             or t.name ilike '%' || v_search || '%')
         order by x2.expense_date desc nulls last, x2.created_at desc limit v_limit
      ) x;
  elsif v_kind = 'payout' then
    select coalesce(jsonb_agg(x.row_json order by x.on_day desc nulls last, x.ref, x.id), '[]'::jsonb),
           coalesce(max(x.matched), 0)::int
      into v_rows, v_matched
      from (
        select m2.id as id, coalesce(m2.paid_at, m2.released_at)::date as on_day, m2.ref as ref,
               count(*) over () as matched,
               jsonb_build_object(
          'kind', 'payout', 'id', m2.id, 'ref', m2.ref,
          'amount', m2.amount::text, 'currency', m2.currency, 'state', m2.status,
          'fee_amount', m2.fee_amount::text,
          'company', coalesce(t.name, 'no company'), 'company_tenant_id', m2.payee_tenant_id,
          'book', m2.tenant_id, 'book_name', coalesce(bb.name, m2.tenant_id::text),
          -- A payout is asked for two different reasons and only one of them cares whose book raised it.
          -- As a transaction to cut from, a payout in a company's book is exactly the right answer — the
          -- ladder is resolved from the company the money lands at. As the movement that *carries* a cut,
          -- the pointer door only looks in the office's own book, so the desk says so with this flag
          -- instead of letting a clerk press a pointer the register answers with `no_such_payout`.
          'raised_in_this_book', m2.tenant_id = p_tenant,
          'on_day', coalesce(m2.paid_at, m2.released_at)::date,
          'payee_kind', m2.payee_kind, 'payee_id', m2.payee_id, 'payee_name', m2.payee_name,
          'detail', m2.ref || ' · ' || trim(to_char(m2.amount, 'FM999999990.00')) || ' ' || m2.currency
                   || ' to ' || m2.payee_name || ' · ' || coalesce(t.name, m2.tenant_id::text)
                   || ' · ' || coalesce(m2.paid_at, m2.released_at)::date
                   || (case when m2.tenant_id = p_tenant then ''
                            else ' · raised in ' || coalesce(bb.name, 'another book') end),
          'readings', (select count(*)::int from pricing_commission_assessments m
                        where m.source_kind = 'payout' and m.source_id = m2.id
                          and m.voided_at is null)) as row_json
          from money_payouts m2 left join tenants t on t.id = m2.payee_tenant_id
                               left join tenants bb on bb.id = m2.tenant_id
         where m2.status not in ('raised','pending_signature','declined','failed')
           and coalesce(m2.paid_at, m2.released_at) is not null and m2.amount > 0
           and (v_search is null or m2.ref ilike '%' || v_search || '%'
                             or m2.payee_name ilike '%' || v_search || '%'
                             or t.name ilike '%' || v_search || '%')
         order by coalesce(m2.paid_at, m2.released_at) desc limit v_limit
      ) x;
  -- The second movement a cut can be carried by. A posting is only ever a carrier — it is not one of the
  -- five transactions a cut is taken from — so this list is kept to the office's own book, which is exactly
  -- where `discharge_commission_assessment` looks one up. A picker that offered a posting from a company's
  -- book would be offering a pointer the register answers with `no_such_posting`.
  -- The legs are printed in the same shape the reading detail prints its carrier's, and a `fee_leg` is left
  -- NULL rather than coalesced to zero: the office keeping a cut is discharged against a credit on
  -- FEE-INCOME, and a posting with no such line is a paper the desk must say so about before it presses.
  else
    select coalesce(jsonb_agg(x.row_json order by x.on_day desc nulls last, x.ref, x.id), '[]'::jsonb),
           coalesce(max(x.matched), 0)::int
      into v_rows, v_matched
      from (
        select s.id as id, s.posted_on as on_day, s.ref as ref, count(*) over () as matched,
               jsonb_build_object(
          'kind', 'posting', 'id', s.id, 'ref', s.ref, 'state', s.status,
          'amount', s.total::text, 'currency', s.currency, 'on_day', s.posted_on,
          'memo', s.memo, 'book', s.tenant_id, 'source_kind', s.source_kind,
          'source_ref', s.source_ref,
          'legs', (select coalesce(jsonb_agg(jsonb_build_object(
                     'account', a.code, 'direction', e.direction, 'amount', e.amount::text)
                     order by e.direction, a.code), '[]'::jsonb)
                     from money_entries e join money_accounts a on a.id = e.account_id
                    where e.posting_id = s.id and e.tenant_id = s.tenant_id),
          'fee_leg', (select sum(e.amount)::text from money_entries e
                       join money_accounts a on a.id = e.account_id
                      where e.posting_id = s.id and e.tenant_id = s.tenant_id
                        and e.direction = 'credit' and a.code in ('FEE-INCOME','FEE-INCOME-USD')),
          'cost_leg', (select sum(e.amount)::text from money_entries e
                       join money_accounts a on a.id = e.account_id
                      where e.posting_id = s.id and e.tenant_id = s.tenant_id
                        and e.direction = 'debit' and a.code in ('COST-OPS','COST-OPS-USD')),
          'detail', s.ref || ' · ' || trim(to_char(s.total, 'FM999999990.00')) || ' ' || s.currency
                   || ' · ' || s.memo || ' · ' || s.posted_on::text,
          'carried', (select count(*)::int from pricing_commission_assessments m
                       where m.carrier_kind = 'posting' and m.carrier_id = s.id
                         and m.voided_at is null)) as row_json
          from money_postings s
         where s.tenant_id = p_tenant and s.status <> 'reversed'
           and (v_search is null or s.ref ilike '%' || v_search || '%'
                             or s.memo ilike '%' || v_search || '%'
                             or s.source_ref ilike '%' || v_search || '%')
         order by s.posted_on desc nulls last, s.raised_at desc limit v_limit
      ) x;
  end if;

  return jsonb_build_object('ok', true, 'kind', v_kind, 'rows', coalesce(v_rows, '[]'::jsonb),
    'count', coalesce(v_matched, 0), 'returned', jsonb_array_length(coalesce(v_rows, '[]'::jsonb)),
    'limit', v_limit, 'search', v_search,
    'note', 'The office''s own standing cut names no company and no plan, and the office keeping a cut '
      || 'names no payee.');
end $$;

-- ============================================================
-- 10. the draft doors
-- ============================================================

-- Open an agreement. The subject, the transaction and the payee are chosen here and frozen by the guard
-- in section 6: a desk that could move a cut from one company to another after the fact is a desk that
-- can retarget a signed paper.
--
-- The version is the next free number on this rung for this transaction, so a second agreement opened on
-- the same ladder step cannot collide with the first in `pricing_commission_rate_one_version_per_ladder`;
-- the ordinary way a version appears is `clone_pricing_commission_rate` below, and the door reads the rung
-- through `commission_subject_key` rather than trusting a caller to name a uuid.
create or replace function platform_auth.open_pricing_commission_rate(
  p_tenant uuid, p_subject_kind text, p_subject_tenant uuid, p_subject_plan uuid,
  p_source_kind text, p_payee_kind text, p_payee_id uuid, p_basis text, p_value numeric,
  p_currency text, p_floor numeric, p_cap numeric, p_effective_from date, p_effective_to date,
  p_note text, p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_subject text;
  v_source text;
  v_payee text;
  v_basis text;
  v_cur text;
  v_note text;
  v_key uuid;
  v_version int;
  v_new pricing_commission_rates;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can open a commission agreement.');
  end if;
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null
                   and t.type = 'platform') then
    return jsonb_build_object('ok', false, 'error', 'not_the_office',
      'message', 'A cut is agreed in the office''s own book. Pick the platform tenant.');
  end if;

  v_subject := lower(trim(coalesce(p_subject_kind, '')));
  v_source := lower(trim(coalesce(p_source_kind, '')));
  v_payee := lower(trim(coalesce(p_payee_kind, 'platform')));
  v_basis := lower(trim(coalesce(p_basis, '')));
  v_cur := nullif(upper(trim(coalesce(p_currency, ''))), '');
  v_note := trim(coalesce(p_note, ''));

  if not exists (select 1 from pricing_commission_subjects s where s.key = v_subject) then
    return jsonb_build_object('ok', false, 'error', 'bad_subject', 'asked', p_subject_kind,
      'message', 'Say who the cut is agreed with, in the words the ladder walks: '
        || (select string_agg(s.key, ', ' order by s.priority) from pricing_commission_subjects s)
        || '.');
  end if;
  if v_subject = 'tenant' and p_subject_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'no_company',
      'message', 'A cut agreed with a company has to say which company.');
  end if;
  if v_subject = 'tenant' and p_subject_plan is not null then
    return jsonb_build_object('ok', false, 'error', 'two_subjects',
      'message', 'One agreement is agreed with one thing: name the company or the plan, not both.');
  end if;
  if v_subject = 'plan' and p_subject_plan is null then
    return jsonb_build_object('ok', false, 'error', 'no_plan',
      'message', 'A cut inherited from a plan has to say which plan.');
  end if;
  if v_subject = 'plan' and not exists (select 1 from plans pl where pl.id = p_subject_plan) then
    return jsonb_build_object('ok', false, 'error', 'no_plan', 'asked', p_subject_plan,
      'message', 'There is no plan with that id for the office to attach a cut to.');
  end if;
  if v_subject = 'platform' and (p_subject_tenant is not null or p_subject_plan is not null) then
    return jsonb_build_object('ok', false, 'error', 'two_subjects',
      'message', 'The office''s own standing cut names no company and no plan.');
  end if;
  if not exists (select 1 from pricing_commission_sources s where s.key = v_source) then
    return jsonb_build_object('ok', false, 'error', 'bad_source', 'asked', p_source_kind,
      'message', 'The office takes a cut from these: '
        || (select string_agg(s.key, ', ' order by s.sort) from pricing_commission_sources s) || '.');
  end if;
  if v_payee not in ('platform','company','driver','staff') then
    return jsonb_build_object('ok', false, 'error', 'bad_payee', 'asked', p_payee_kind,
      'message', 'A cut is kept by the office or owed out to a company, a driver or a staff member.');
  end if;
  if v_payee = 'platform' and p_payee_id is not null then
    return jsonb_build_object('ok', false, 'error', 'payee_has_an_id',
      'message', 'The office keeping its own cut names no register row — leave the payee id empty.');
  end if;
  if v_payee <> 'platform' and p_payee_id is null then
    return jsonb_build_object('ok', false, 'error', 'payee_has_no_id',
      'message', 'A cut owed out to a person has to say which person.');
  end if;

  if v_basis not in ('percent_of_amount','flat') then
    return jsonb_build_object('ok', false, 'error', 'bad_basis', 'asked', p_basis,
      'message', 'A cut is worked out in one of two ways: a percentage of the transaction, or a flat '
        || 'sum named in a money.');
  end if;
  if p_value is null or p_value <= 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_value', 'asked', p_value,
      'message', 'The figure is what the cut is worth: a positive number. A zero cut is no agreement — '
        || 'leave the rung unanswered and the desk will say the cut has not been agreed.');
  end if;
  if v_basis = 'percent_of_amount' and p_value > 100 then
    return jsonb_build_object('ok', false, 'error', 'percent_too_wide', 'asked', p_value,
      'message', p_value || '% is not a percentage. A cut above 100 takes the transaction away and '
        || 'owes the office the difference.');
  end if;
  if v_basis = 'flat' and v_cur is null then
    return jsonb_build_object('ok', false, 'error', 'flat_needs_a_money',
      'message', 'A flat cut has to be named in a money: TZS or USD. A percentage carries no money '
        || 'because it is worked out in the transaction''s own.');
  end if;
  if v_basis = 'percent_of_amount' and v_cur is not null then
    return jsonb_build_object('ok', false, 'error', 'percent_carries_a_money', 'asked', v_cur,
      'message', 'A percentage is computed in whatever money the transaction is in, so naming one here '
        || 'is the mismatch 138 found in a count, written into an agreement.');
  end if;
  if v_cur is not null and v_cur not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'bad_currency', 'asked', v_cur,
      'message', 'The book keeps two monies: TZS and USD.');
  end if;
  if p_floor is not null and p_floor < 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_floor', 'asked', p_floor,
      'message', 'A least is a positive figure, or no figure at all.');
  end if;
  if p_cap is not null and p_cap < 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_cap', 'asked', p_cap,
      'message', 'A most is a positive figure, or no figure at all.');
  end if;
  if p_floor is not null and p_cap is not null and p_floor > p_cap then
    return jsonb_build_object('ok', false, 'error', 'floor_above_ceiling', 'floor', p_floor,
      'cap', p_cap,
      'message', 'The least cannot be above the most. A cut with that window is refused by the table, '
        || 'and the desk would show a figure the register cannot hold.');
  end if;
  if p_effective_from is not null and p_effective_to is not null
     and p_effective_to < p_effective_from then
    return jsonb_build_object('ok', false, 'error', 'bad_window',
      'message', 'The last day cannot come before the first day.');
  end if;
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say in 8-600 characters what this agreement is: the second seat reads it before '
        || 'signing the figure.');
  end if;

  v_key := platform_auth.commission_subject_key(v_subject,
            case when v_subject = 'tenant' then p_subject_tenant end,
            case when v_subject = 'plan' then p_subject_plan end);
  -- The chain is counted inside the book that opens it. A platform rung's key is the register's nil
  -- uuid and is the same letters in every office, so an unbound count would let the first office to
  -- sign a platform-wide cut hand the second office a version 2 of a paper it had never seen.
  select coalesce(max(a.version), 0) + 1 into v_version
    from pricing_commission_rates a
   where a.tenant_id = p_tenant
     and a.subject_key = v_key and a.source_kind = v_source;

  insert into pricing_commission_rates (id, tenant_id, ref, subject_kind, subject_tenant_id,
      subject_plan_id, subject_key, subject_name, source_kind, payee_kind, payee_id, payee_name,
      basis, value, currency, floor_amount, cap, effective_from, effective_to, version, status,
      note, created_by, updated_by)
  values (gen_random_uuid(), p_tenant,
          'CMR-' || to_char(now(), 'YYYY') || '-'
                  || lpad(nextval('pricing_commission_rate_number_seq')::text, 5, '0'),
          v_subject, case when v_subject = 'tenant' then p_subject_tenant end,
          case when v_subject = 'plan' then p_subject_plan end,
          v_key, '', v_source, v_payee, p_payee_id, '',
          v_basis, p_value, v_cur, p_floor, p_cap, p_effective_from, p_effective_to,
          v_version, 'draft', v_note, p_actor, p_actor)
  returning * into v_new;

  insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role)
  values (p_tenant, v_new.id, 'state', platform_auth.pricing_commission_rate_said(v_new), null,
      'draft', v_new.currency,
      'Opened on the ' || v_new.source_kind || ' rung of ' || v_new.subject_name || '.',
      p_actor, p_role);
  -- The draft's own row is the memory's anchor, and `pricing_commission_history` points at it with a
  -- foreign key that has no cascade — so `discard_pricing_commission_rate` below, and nothing else, is
  -- the door that can end a draft, and it sweeps this row before it sweeps the agreement.

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_commission_rates', v_new.id, 'pricing.commission_opened', null,
    jsonb_build_object('ref', v_new.ref, 'subject_kind', v_new.subject_kind,
      'subject_name', v_new.subject_name, 'source_kind', v_new.source_kind,
      'payee_kind', v_new.payee_kind, 'payee_name', v_new.payee_name, 'basis', v_new.basis,
      'value', v_new.value::text, 'currency', v_new.currency, 'floor_amount', v_new.floor_amount::text,
      'cap', v_new.cap::text, 'version', v_new.version, 'effective_from', v_new.effective_from::text,
      'effective_to', v_new.effective_to::text, 'note', v_new.note, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'rate',
    platform_auth.pricing_commission_rate_detail(p_tenant, v_new.id));
end $$;

-- Edit a draft. The figures and the window move; the identity does not, and neither does the basis.
--
-- A flat cut and a percentage cut are two different agreements, not two spellings of one: a seat that
-- signs "3 percent of a payout" and a seat that signs "50,000 on a payout" signed different promises, and
-- an edit that could turn one into the other would let the second version of a paper be signed against a
-- paper nobody proposed. Change the basis by cloning and refusing the old draft.
--
-- Presence-based like a driver's record and 141's charge: an absent half keeps the column and a word in
-- `p_clear` empties it, because a draft whose ceiling can only ever be raised is a draft a clerk has to
-- throw away and re-open to fix.
create or replace function platform_auth.edit_pricing_commission_rate(
  p_tenant uuid, p_rate uuid, p_value numeric, p_floor numeric, p_cap numeric,
  p_effective_from date, p_effective_to date, p_note text, p_clear text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v pricing_commission_rates;
  v_clears text[];
  v_w text;
  v_note text;
  v_floor numeric;
  v_cap numeric;
  v_from date;
  v_to date;
  v_after pricing_commission_rates;
  v_before jsonb;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can edit an agreement.');
  end if;
  select * into v from pricing_commission_rates where id = p_rate and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no commission agreement with that number in this book.');
  end if;
  if v.status = 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'paper_is_out', 'ref', v.ref,
      'message', v.ref || ' is waiting for a second seat. Refuse that paper before moving a figure under '
        || 'it — the signature is cut on the bytes, and the bytes changed.');
  end if;
  if v.published_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_lived', 'ref', v.ref,
      'message', v.ref || ' has been a live agreement, so its figures are frozen: clone it forward and '
        || 'the company is cut under the new version from its own start day.');
  end if;
  if v.status <> 'draft' then
    return jsonb_build_object('ok', false, 'error', 'not_a_draft', 'ref', v.ref, 'status', v.status,
      'message', 'Only a draft is edited.');
  end if;

  v_note := trim(coalesce(p_note, v.note));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'The note is the sentence a second seat reads, and it is 8-600 characters.');
  end if;
  if p_value is not null and p_value <= 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_value', 'asked', p_value,
      'message', 'The figure is what the cut is worth: a positive number.');
  end if;
  if p_value is not null and v.basis = 'percent_of_amount' and p_value > 100 then
    return jsonb_build_object('ok', false, 'error', 'percent_too_wide', 'asked', p_value,
      'message', p_value || '% is not a percentage.');
  end if;
  if p_value is not null and v.basis = 'flat' and v.currency is null then
    return jsonb_build_object('ok', false, 'error', 'flat_needs_a_money',
      'message', 'A flat cut has to be named in a money, and this one lost its.');
  end if;

  v_clears := array(select distinct lower(trim(w))
                      from regexp_split_to_table(coalesce(p_clear, ''), ',') w
                     where trim(w) <> '');
  foreach v_w in array v_clears loop
    if v_w not in ('floor_amount', 'cap', 'effective_to') then
      return jsonb_build_object('ok', false, 'error', 'bad_clear', 'asked', v_w,
        'message', 'Nothing on an agreement is cleared by that word. It can empty: floor_amount, cap, '
          || 'effective_to.');
    end if;
  end loop;
  -- The resulting pair, not the incoming one: a desk that clears the floor while an old ceiling sits
  -- under it is making a legal move, and refusing it because the guard compared the wrong halves is how
  -- a register teaches a clerk to throw the draft away instead.
  v_floor := case when 'floor_amount' = any (v_clears) then null else coalesce(p_floor, v.floor_amount) end;
  v_cap := case when 'cap' = any (v_clears) then null else coalesce(p_cap, v.cap) end;
  v_from := coalesce(p_effective_from, v.effective_from);
  v_to := case when 'effective_to' = any (v_clears) then null
               else coalesce(p_effective_to, v.effective_to) end;
  if v_floor is not null and v_cap is not null and v_floor > v_cap then
    return jsonb_build_object('ok', false, 'error', 'floor_above_ceiling',
      'floor_amount', v_floor, 'cap', v_cap,
      'message', 'The least cannot be above the most, whichever way the pair is being moved.');
  end if;
  if v_from is not null and v_to is not null and v_to < v_from then
    return jsonb_build_object('ok', false, 'error', 'bad_window',
      'message', 'The last day cannot come before the first day.');
  end if;

  v_before := jsonb_build_object('value', v.value::text, 'floor_amount', v.floor_amount::text,
    'cap', v.cap::text, 'effective_from', v.effective_from::text,
    'effective_to', v.effective_to::text, 'note', v.note,
    'said', platform_auth.pricing_commission_rate_said(v));

  update pricing_commission_rates
     set value = coalesce(p_value, value),
         floor_amount = case when 'floor_amount' = any (v_clears) then null
                             else coalesce(p_floor, floor_amount) end,
         cap = case when 'cap' = any (v_clears) then null else coalesce(p_cap, cap) end,
         effective_from = coalesce(p_effective_from, effective_from),
         effective_to = case when 'effective_to' = any (v_clears) then null
                             else coalesce(p_effective_to, effective_to) end,
         note = v_note,
         updated_by = p_actor
   where id = v.id;

  -- The two lines the memory keeps: the figure and the window, each written only if it moved. A draft's
  -- own edits belong in the memory and not only in the audit because the second seat reads this panel
  -- before signing, and "the ceiling was raised twice on the way here" is the sentence that decides a
  -- signature. `discard_pricing_commission_rate` is the one door allowed to delete these lines, and the
  -- memory guard in section 6 says why.
  select * into v_after from pricing_commission_rates where id = v.id;

  if v_after.value is distinct from v.value
     or v_after.floor_amount is distinct from v.floor_amount
     or v_after.cap is distinct from v.cap then
    insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
        currency, reason, actor_user_id, actor_role)
    values (p_tenant, v.id, 'figure', platform_auth.pricing_commission_rate_said(v_after),
        v.value::text, v_after.value::text, v_after.currency,
        'Draft figure moved by ' || v_seat || ' (least ' || coalesce(v.floor_amount::text, 'none')
          || ' to ' || coalesce(v_after.floor_amount::text, 'none') || ', most '
          || coalesce(v.cap::text, 'none') || ' to ' || coalesce(v_after.cap::text, 'none') || ').',
        p_actor, p_role);
  end if;
  if v_after.effective_from is distinct from v.effective_from
     or v_after.effective_to is distinct from v.effective_to then
    insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
        currency, reason, actor_user_id, actor_role)
    values (p_tenant, v.id, 'window', platform_auth.pricing_commission_rate_said(v_after),
        coalesce(v.effective_from::text, 'no day') || ' to '
          || coalesce(v.effective_to::text, 'open'),
        coalesce(v_after.effective_from::text, 'no day') || ' to '
          || coalesce(v_after.effective_to::text, 'open'), v_after.currency,
        'Draft window moved by ' || v_seat || '.', p_actor, p_role);
  end if;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_commission_rates', v.id, 'pricing.commission_edited', v_before,
    jsonb_build_object('ref', v.ref, 'subject_name', v.subject_name, 'source_kind', v.source_kind,
      'basis', v.basis, 'value', coalesce(p_value, v.value)::text,
      'floor_amount', case when 'floor_amount' = any (v_clears) then null
                           else coalesce(p_floor, v.floor_amount)::text end,
      'cap', case when 'cap' = any (v_clears) then null else coalesce(p_cap, v.cap)::text end,
      'effective_from', coalesce(p_effective_from, v.effective_from)::text,
      'effective_to', case when 'effective_to' = any (v_clears) then null
                           else coalesce(p_effective_to, v.effective_to)::text end,
      'cleared', v_clears, 'note', v_note, 'seat', v_seat));

  return platform_auth.pricing_commission_rate_detail(p_tenant, v.id);
end $$;

-- A draft nobody was asked to sign is thrown away. 141 learned which column to read here and the lesson
-- is kept: the gate is the paper's own marks — a status that left `draft`, an `approval_id`, or a
-- `published_at` — because those are exactly what the keep-guard in section 6 refuses a delete on. A
-- discard door that gates on a softer word than the trigger does would let a press POST, take a 23514
-- from the guard and show the clerk a system error instead of the register's sentence.
create or replace function platform_auth.discard_pricing_commission_rate(
  p_tenant uuid, p_rate uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_reason text;
  v pricing_commission_rates;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can throw away a draft agreement.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters why the draft is going: it is the only sentence that will say '
        || 'the agreement existed.');
  end if;
  select * into v from pricing_commission_rates where id = p_rate and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no commission agreement with that number in this book.');
  end if;
  if v.status <> 'draft' or v.approval_id is not null or v.published_at is not null then
    return jsonb_build_object('ok', false, 'error', 'kept', 'ref', v.ref, 'status', v.status,
      'message', v.ref || ' is a ' || v.status
        || case when v.approval_id is not null then ' paper that a seat was asked to sign'
                when v.published_at is not null then ' agreement that has been live'
                else '' end
        || ', so it is kept. A live agreement is ended by withdrawing it or by a new version, and an '
        || 'unsigned paper is refused on Approvals.');
  end if;

  delete from pricing_commission_history
   where rate_id = v.id and tenant_id = p_tenant;
  delete from pricing_commission_rates where id = v.id and tenant_id = p_tenant;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_commission_rates', v.id, 'pricing.commission_discarded',
    jsonb_build_object('ref', v.ref, 'subject_name', v.subject_name, 'source_kind', v.source_kind,
      'basis', v.basis, 'value', v.value::text, 'currency', v.currency, 'version', v.version,
      'said', platform_auth.pricing_commission_rate_said(v)),
    jsonb_build_object('reason', v_reason, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'discarded', v.ref, 'reason', v_reason);
end $$;

-- A new version of an agreement that has lived. The figure is copied forward rather than retyped — the
-- office is changing one thing, not writing the agreement again from memory — and the start day is
-- demanded here because a version with no day cannot close the window of the one it replaces.
create or replace function platform_auth.clone_pricing_commission_rate(
  p_tenant uuid, p_rate uuid, p_effective_from date, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_src pricing_commission_rates;
  v_new pricing_commission_rates;
  v_note text;
  v_version int;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can put a new version of an agreement in front of the office.');
  end if;
  if p_effective_from is null then
    return jsonb_build_object('ok', false, 'error', 'no_start',
      'message', 'A new version has to say the day the new cut starts: the agreement it replaces is '
        || 'closed the day before, and that is only a sentence with a date in it.');
  end if;
  select * into v_src from pricing_commission_rates
   where id = p_rate and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no commission agreement with that number in this book.');
  end if;
  if v_src.published_at is null then
    return jsonb_build_object('ok', false, 'error', 'has_not_lived', 'ref', v_src.ref,
      'message', v_src.ref || ' was never a live agreement. Edit the draft, or throw it away — a version '
        || 'chain is the history of what the office actually cut people under.');
  end if;
  if v_src.status = 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'paper_is_out', 'ref', v_src.ref,
      'message', v_src.ref || ' is waiting for a second seat. Answer that paper before cloning it.');
  end if;
  v_note := trim(coalesce(p_note, v_src.note));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say in 8-600 characters what this version changes.');
  end if;

  select coalesce(max(a.version), 0) + 1 into v_version
    from pricing_commission_rates a
   where a.tenant_id = p_tenant
     and a.subject_key = v_src.subject_key and a.source_kind = v_src.source_kind;

  insert into pricing_commission_rates (id, tenant_id, ref, subject_kind, subject_tenant_id,
      subject_plan_id, subject_key, subject_name, source_kind, payee_kind, payee_id, payee_name,
      basis, value, currency, floor_amount, cap, effective_from, version, supersedes_id, status,
      note, created_by, updated_by)
  select gen_random_uuid(), p_tenant,
         'CMR-' || to_char(now(), 'YYYY') || '-'
                 || lpad(nextval('pricing_commission_rate_number_seq')::text, 5, '0'),
         s.subject_kind, s.subject_tenant_id, s.subject_plan_id, s.subject_key, s.subject_name,
         s.source_kind, s.payee_kind, s.payee_id, s.payee_name,
         s.basis, s.value, s.currency, s.floor_amount, s.cap,
         p_effective_from, v_version, s.id, 'draft',
         v_note, p_actor, p_actor
    from pricing_commission_rates s
   where s.id = v_src.id
  returning * into v_new;

  insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role)
  values (p_tenant, v_new.id, 'state', platform_auth.pricing_commission_rate_said(v_new), null,
      'draft', v_new.currency,
      'Opened as version ' || v_new.version || ' of ' || v_src.ref || ', to start '
        || p_effective_from::text || '.', p_actor, p_role);
  insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role)
  values (p_tenant, v_src.id, 'window', platform_auth.pricing_commission_rate_said(v_src),
      coalesce(v_src.effective_to::text, 'open'),
      'a new version starts ' || p_effective_from::text, v_src.currency,
      v_new.ref || ' was cloned forward to replace this version.', p_actor, p_role);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_commission_rates', v_new.id, 'pricing.commission_cloned',
    jsonb_build_object('ref', v_src.ref, 'version', v_src.version,
      'value', v_src.value::text, 'effective_to', v_src.effective_to::text),
    jsonb_build_object('ref', v_new.ref, 'version', v_new.version, 'supersedes', v_src.ref,
      'subject_name', v_new.subject_name, 'source_kind', v_new.source_kind, 'basis', v_new.basis,
      'value', v_new.value::text, 'currency', v_new.currency,
      'effective_from', v_new.effective_from::text, 'note', v_new.note, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'supersedes', v_src.ref, 'rate',
    platform_auth.pricing_commission_rate_detail(p_tenant, v_new.id));
end $$;

-- ============================================================
-- 11. the signature: one hand cannot set what the office takes out of somebody else's money
-- ============================================================

-- Put the paper in front of a second seat. Everything the apply re-checks is checked here too, because
-- the office should not ask a person to sign an agreement the register will refuse to publish: a seat
-- that is asked for a signature on a paper whose days are already taken by a live agreement is being
-- asked to approve a collision.
create or replace function platform_auth.propose_pricing_commission_rate(
  p_tenant uuid, p_rate uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v pricing_commission_rates;
  v_reason text;
  v_paper jsonb;
  v_sha text;
  v_id uuid;
  v_open uuid;
  v_clash pricing_commission_rates;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can ask for a cut to be signed.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'The reason must be 8-600 characters: it is the sentence the second seat signs.');
  end if;
  select * into v from pricing_commission_rates
   where id = p_rate and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no commission agreement with that number in this book.');
  end if;
  if v.status = 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'already_open', 'ref', v.ref,
      'approval_id', v.approval_id,
      'message', v.ref || ' is already waiting for a second seat. Refuse that paper first.');
  end if;
  if v.published_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_lived', 'ref', v.ref,
      'message', v.ref || ' has been a live cut. Clone it forward — an agreement that was signed is not '
        || 'signed twice.');
  end if;
  if v.status <> 'draft' then
    return jsonb_build_object('ok', false, 'error', 'not_a_draft', 'ref', v.ref, 'status', v.status,
      'message', 'Only a draft can be put up for a signature.');
  end if;
  if v.effective_from is null then
    return jsonb_build_object('ok', false, 'error', 'no_start', 'ref', v.ref,
      'message', v.ref || ' has no start day, so the ladder could never tell which agreement ruled a '
        || 'transaction. A cut with no day cannot go live.');
  end if;

  -- The collision the section-6 guard will refuse at the publish, found now. A paper whose days are
  -- already held by a live agreement on the same rung and the same transaction cannot be spent, and
  -- asking a seat to sign it wastes a signature. The search stays in this paper's own book: a platform
  -- rung's key is the register's nil uuid, so an unbound walk would have one office's live cut refuse
  -- — and name the ref of — another office's paper.
  --
  -- The version a clone replaces is excluded, and it has to be: a live cut runs open-ended until its
  -- successor is signed, so every cloned version would otherwise collide with the very row it is
  -- standing for. `apply` closes that row the day before the new one starts (section 6), which is the
  -- handover the desk promises in words. Any other live agreement on the same days still refuses, so a
  -- second, unrelated cut on one rung cannot be asked for a signature over the first.
  select * into v_clash from pricing_commission_rates a
   where a.tenant_id = v.tenant_id
     and a.id <> v.id
     and a.id is distinct from v.supersedes_id
     and a.subject_key = v.subject_key
     and a.source_kind = v.source_kind
     and a.status = 'published'
     and coalesce(a.effective_from, date '-infinity') <= coalesce(v.effective_to, date 'infinity')
     and coalesce(a.effective_to, date 'infinity') >= v.effective_from
   order by a.effective_from nulls first limit 1;
  if found then
    return jsonb_build_object('ok', false, 'error', 'days_are_taken', 'ref', v.ref,
      'clash_ref', v_clash.ref, 'clash_from', v_clash.effective_from::text,
      'clash_to', v_clash.effective_to::text,
      'message', v.ref || ' and ' || v_clash.ref || ' both put a ' || v.source_kind || ' cut on '
        || v.subject_name || ' for the same days. Clone ' || v_clash.ref
        || ' forward instead — a new version closes the one it replaces.');
  end if;

  v_paper := platform_auth.commission_rate_paper(v.id);
  v_sha := encode(extensions.digest(v_paper::text, 'sha256'), 'hex');

  begin
    insert into platform_approvals (id, action, target_kind, target_id, payload, payload_sha256,
        reason, status, proposed_by, proposed_role, proposed_ip, proposed_ua, expires_at)
    values (gen_random_uuid(), 'pricing.commission', 'pricing_commission_rate', v.id::text,
        v_paper, v_sha, v_reason, 'pending', p_actor, p_role, p_ip,
        left(coalesce(p_ua, ''), 300), now() + interval '7 days')
    returning id into v_id;
  exception when unique_violation then
    select a.id into v_open from platform_approvals a
     where a.action = 'pricing.commission' and a.target_kind = 'pricing_commission_rate'
       and a.target_id = v.id::text and a.status = 'pending'
     order by a.created_at desc limit 1;
    return jsonb_build_object('ok', false, 'error', 'already_open', 'open_id', v_open,
      'message', 'A signature for this version is already open and waiting for a second seat.');
  end;

  update pricing_commission_rates
     set status = 'pending_signature', approval_id = v_id, updated_by = p_actor
   where id = v.id;

  insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role, approval_id)
  values (p_tenant, v.id, 'state', platform_auth.pricing_commission_rate_said(v), 'draft',
      'pending_signature', v.currency,
      'Put up for a second seat: ' || v_reason, p_actor, p_role, v_id);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_commission_rates', v.id, 'pricing.commission_publish_proposed',
    jsonb_build_object('status', v.status, 'approval_id', v.approval_id),
    jsonb_build_object('ref', v.ref, 'subject_kind', v.subject_kind, 'subject_name', v.subject_name,
      'source_kind', v.source_kind, 'payee_kind', v.payee_kind, 'payee_name', v.payee_name,
      'basis', v.basis, 'value', v.value::text, 'currency', v.currency,
      'floor_amount', v.floor_amount::text, 'cap', v.cap::text, 'version', v.version,
      'effective_from', v.effective_from::text, 'effective_to', v.effective_to::text,
      'reason', v_reason, 'payload_sha256', v_sha, 'approval_id', v_id, 'seat', v_seat,
      'expires_at', to_char(now() + interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));

  return jsonb_build_object('ok', true, 'approval_id', v_id, 'action', 'pricing.commission',
    'target_kind', 'pricing_commission_rate', 'target_id', v.id, 'ref', v.ref,
    'paper', v_paper, 'payload_sha256', v_sha,
    'said', platform_auth.pricing_commission_rate_said(v),
    'expires_at', to_char(now() + interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rate', platform_auth.pricing_commission_rate_detail(p_tenant, v.id));
end $$;

-- The second seat says no. 121's order is kept exactly: the signature is answered first, because a paper
-- still open on Approvals while the register calls its draft free is two registers disagreeing about
-- whether a thing is waiting. The `approval_id` stays attached — the row is now a draft that carries the
-- mark of a paper nobody signed, which is what the refusals count and the keep-guard both read.
create or replace function platform_auth.refuse_pricing_commission_rate(
  p_tenant uuid, p_rate uuid, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v pricing_commission_rates;
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
  select * into v from pricing_commission_rates
   where id = p_rate and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no commission agreement with that number in this book.');
  end if;
  if v.status <> 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'nothing_open', 'ref', v.ref, 'status', v.status,
      'message', 'No signature is standing on ' || v.ref || '. Refusing an agreement the office never '
        || 'asked anyone to sign is not a thing a register can record.');
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
      'message', 'The signature on ' || v.ref || ' was released. An agreement that has been signed is '
        || 'spent on Approvals or withdrawn from this desk — it is not refused from here.');
  end if;

  update pricing_commission_rates
     set status = 'draft', refusals = refusals + 1, updated_by = p_actor
   where id = v.id;

  insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role, approval_id)
  values (p_tenant, v.id, 'state', platform_auth.pricing_commission_rate_said(v), 'pending_signature',
      'draft', v.currency, 'Refused by '
      || coalesce((select u.full_name from users u where u.id = p_actor), 'a second seat')
      || ': ' || v_note, p_actor, p_role, v_a.id);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_commission_rates', v.id, 'pricing.commission_publish_refused',
    jsonb_build_object('status', v.status, 'approval_id', v_a.id, 'paper_sha256', v_a.payload_sha256),
    jsonb_build_object('ref', v.ref, 'subject_name', v.subject_name, 'source_kind', v.source_kind,
      'basis', v.basis, 'value', v.value::text, 'payee_name', v.payee_name,
      'note', v_note, 'refusals', v.refusals + 1, 'seat', v_seat,
      'proposed_by', (select u.full_name from users u where u.id = v_a.proposed_by)));

  return jsonb_build_object('ok', true,
    'rate', platform_auth.pricing_commission_rate_detail(p_tenant, v.id),
    'refusals', v.refusals + 1, 'approval_id', v_a.id);
end $$;

-- Spend the signature and put the cut in force.
--
-- Called inside the same transaction as `decide_approval` and `claim_approval`, in 121's order, and it
-- expects the paper already spent by the seat calling it. The bytes are rebuilt from the row before a
-- single column moves: a figure typed in the seven days a paper waited is refused here rather than
-- charged under a signature that never described it. 142's own stake in that promise is the sharpest of
-- the three pricing registers — a moved percent is a different sum taken out of every transaction the
-- rung touches.
create or replace function platform_auth.apply_pricing_commission_rate(
  p_approval_id uuid, p_actor_user_id uuid, p_actor_role text, p_actor_ip text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a       platform_approvals%rowtype;
  v         pricing_commission_rates;
  v_old     pricing_commission_rates;
  v_paper   jsonb;
  v_now     text;
  v_close_to date;
  v_to      date;
  v_seated  int;
  v_said    text;
begin
  select * into v_a from platform_approvals where id = p_approval_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no signature with that number.');
  end if;
  if v_a.action <> 'pricing.commission' or v_a.target_kind <> 'pricing_commission_rate' then
    return jsonb_build_object('ok', false, 'error', 'not_a_commission',
      'message', 'That signature is not a publish of a commission agreement.');
  end if;
  if v_a.status <> 'applied' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'approval_status', v_a.status,
      'message', 'The signature was not spent by this call.');
  end if;
  if v_a.decided_by <> p_actor_user_id then
    return jsonb_build_object('ok', false, 'error', 'unauthorised',
      'message', 'Only the seat that released a signature may spend it.');
  end if;

  select * into v from pricing_commission_rates
   where id = v_a.target_id::uuid for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'The agreement this signature was cut on is no longer in the book.');
  end if;
  if v.status <> 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'status', v.status, 'ref', v.ref,
      'message', v.ref || ' is not waiting for that signature any more.');
  end if;

  v_paper := platform_auth.commission_rate_paper(v.id);
  v_now := encode(extensions.digest(v_paper::text, 'sha256'), 'hex');
  if v_now <> v_a.payload_sha256 then
    -- The paper is already spent when this branch is reached: 121's `claim_approval` burns it to
    -- `applied` before the effect runs. A refusal that left the row `pending_signature` would strand
    -- the draft for good — `edit` answers `paper_is_out`, `propose` answers `already_open`, `discard`
    -- answers `not_a_draft`, and the only door that could free the row is the one that just said no.
    -- 140's and 141's apply stop there. This one hands the draft back into the state
    -- `refuse_pricing_commission_rate` leaves: a draft carrying the mark of a paper nobody signed, and
    -- the figure the second seat never saw still standing for them to look at. `refusals` is not moved
    -- — nobody refused; the proposer's own bytes did.
    update pricing_commission_rates
       set status = 'draft', updated_by = p_actor_user_id
     where id = v.id;

    insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
        currency, reason, actor_user_id, actor_role, approval_id)
    values (v.tenant_id, v.id, 'state', platform_auth.pricing_commission_rate_said(v),
        'pending_signature', 'draft', v.currency,
        'Freed without a signature: the seat signed ' || v_a.payload_sha256 || ' and the row read '
        || v_now || ' when the paper was spent. The figure stands as the draft has it.',
        p_actor_user_id, p_actor_role, v_a.id);

    perform platform_auth.money_audit(v.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip, null,
      'pricing_commission_rates', v.id, 'pricing.commission_publish_refused',
      jsonb_build_object('status', v.status, 'approval_id', v_a.id, 'paper_sha256', v_a.payload_sha256),
      jsonb_build_object('ref', v.ref, 'subject_name', v.subject_name, 'source_kind', v.source_kind,
        'basis', v.basis, 'value', v.value::text, 'payee_name', v.payee_name,
        'signed_sha256', v_a.payload_sha256, 'row_sha256', v_now, 'freed_to', 'draft',
        'proposed_by', (select u.full_name from users u where u.id = v_a.proposed_by)));

    return jsonb_build_object('ok', false, 'error', 'paper_moved', 'ref', v.ref,
      'signed_sha256', v_a.payload_sha256, 'row_sha256', v_now, 'freed_to', 'draft',
      'message', 'The figure on ' || v.ref || ' is not the one that was signed, so nothing was put in '
        || 'force. ' || v.ref || ' is handed back as a draft rather than left waiting on a signature '
        || 'that is already spent: check the figure, then put it up for a second seat again.');
  end if;
  if v.effective_from is null then
    return jsonb_build_object('ok', false, 'error', 'no_start', 'ref', v.ref,
      'message', v.ref || ' lost its start day. A cut with no day cannot go live.');
  end if;

  -- 140's and 141's ordering, kept exactly: the window the previous version was valid for closes the day
  -- before the new one starts, and only then is the new one published — otherwise the overlap guard sees
  -- the collision it is being asked to create and refuses the publish it is standing for.
  v_close_to := v.effective_from - 1;
  v_seated := 0;
  for v_old in
    select * from pricing_commission_rates
     where tenant_id = v.tenant_id
       and subject_key = v.subject_key
       and source_kind = v.source_kind
       and status = 'published' and id <> v.id
       and effective_from <= v.effective_from
       and coalesce(effective_to, date 'infinity') >= v.effective_from
     order by effective_from desc
  loop
    v_to := greatest(least(coalesce(v_old.effective_to, date 'infinity'), v_close_to),
                     v_old.effective_from);
    v_said := platform_auth.pricing_commission_rate_said(v_old);

    update pricing_commission_rates
       set status = 'superseded', effective_to = v_to
     where id = v_old.id;

    insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
        currency, reason, actor_user_id, actor_role, approval_id)
    values (v.tenant_id, v_old.id, 'window', v_said, v_old.effective_to::text, v_to::text,
        v_old.currency,
        'Closed by ' || v.ref || ' version ' || v.version || ', which this signature published.',
        p_actor_user_id, p_actor_role, v_a.id);
    insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
        currency, reason, actor_user_id, actor_role, approval_id)
    values (v.tenant_id, v_old.id, 'state', v_said, 'published', 'superseded', v_old.currency,
        'Replaced by ' || v.ref || ' version ' || v.version || '.',
        p_actor_user_id, p_actor_role, v_a.id);
    v_seated := v_seated + 1;
  end loop;

  update pricing_commission_rates
     set status = 'published', published_by = p_actor_user_id, published_at = now(),
         published_note = v_a.reason, updated_by = p_actor_user_id
   where id = v.id;

  insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role, approval_id)
  values (v.tenant_id, v.id, 'figure', platform_auth.pricing_commission_rate_said(v), null,
      v.value::text, v.currency,
      'In force on ' || v.subject_name || ' for a ' || v.source_kind || ', kept by ' || v.payee_name
        || ', from ' || v.effective_from::text || '.',
      p_actor_user_id, p_actor_role, v_a.id);
  insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role, approval_id)
  values (v.tenant_id, v.id, 'state', platform_auth.pricing_commission_rate_said(v),
      'pending_signature', 'published', v.currency,
      'Signed by ' || coalesce((select u.full_name from users u where u.id = v_a.decided_by),
                               'a second seat')
        || ' and effective from ' || v.effective_from::text || '.',
      p_actor_user_id, p_actor_role, v_a.id);

  perform platform_auth.money_audit(v.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip, null,
    'pricing_commission_rates', v.id, 'pricing.commission_published',
    jsonb_build_object('status', v.status, 'approval_id', v.approval_id, 'value', v.value::text),
    jsonb_build_object('ref', v.ref, 'subject_kind', v.subject_kind, 'subject_name', v.subject_name,
      'source_kind', v.source_kind, 'payee_kind', v.payee_kind, 'payee_name', v.payee_name,
      'basis', v.basis, 'value', v.value::text, 'currency', v.currency,
      'floor_amount', v.floor_amount::text, 'cap', v.cap::text, 'version', v.version,
      'effective_from', v.effective_from::text, 'superseded_versions', v_seated,
      'payload_sha256', v_a.payload_sha256, 'approval_id', v_a.id,
      'signed_by', (select u.full_name from users u where u.id = v_a.decided_by),
      'proposed_by', (select u.full_name from users u where u.id = v_a.proposed_by)));

  return jsonb_build_object('ok', true, 'rate_id', v.id, 'ref', v.ref,
    'subject_kind', v.subject_kind, 'subject_name', v.subject_name, 'source_kind', v.source_kind,
    'version', v.version, 'basis', v.basis, 'value', v.value::text, 'currency', v.currency,
    'payee_kind', v.payee_kind, 'payee_name', v.payee_name,
    'effective_from', v.effective_from::text, 'superseded_versions', v_seated,
    'approval_id', v_a.id, 'published_by', p_actor_user_id,
    'rate', platform_auth.pricing_commission_rate_detail(v.tenant_id, v.id));
end $$;

-- ============================================================
-- 12. the stop
-- ============================================================

-- End a live agreement on a day, with a sentence. One seat is enough here and 140's and 141's reason
-- holds: a withdrawal stops the office asking for a cut it has not yet taken, and the register that
-- refuses a clerk the way down would push them toward leaving a rate live and hoping nobody quotes it.
--
-- The stop day cannot be in the past. A cut the office took under an agreement it "withdrew" last month
-- would be an agreement retroactively unmade, and the readings already taken under it are the record of
-- what was asked — 142's own reason for keeping them.
create or replace function platform_auth.withdraw_pricing_commission_rate(
  p_tenant uuid, p_rate uuid, p_effective_to date, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v pricing_commission_rates;
  v_reason text;
  v_open int;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can stop an agreement.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters why the cut stops: the sentence is read beside the last day '
        || 'it applied.');
  end if;
  if p_effective_to is null then
    return jsonb_build_object('ok', false, 'error', 'no_stop_day',
      'message', 'A stop needs a day: an agreement that simply says "withdrawn" leaves the ladder '
        || 'without an answer for the transactions between its last live day and now.');
  end if;
  if p_effective_to < current_date then
    return jsonb_build_object('ok', false, 'error', 'stop_is_in_the_past', 'asked', p_effective_to,
      'message', 'The stop day is ' || p_effective_to || ' and today is ' || current_date
        || '. An agreement cannot be unmade over the days it was quoted under; a cut already taken is '
        || 'answered by voiding the reading, not by rewriting the agreement.');
  end if;

  select * into v from pricing_commission_rates
   where id = p_rate and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no commission agreement with that number in this book.');
  end if;
  if v.status <> 'published' then
    return jsonb_build_object('ok', false, 'error', 'not_live', 'ref', v.ref, 'status', v.status,
      'message', v.ref || ' is ' || v.status || '. A draft is thrown away, an unsigned paper is refused '
        || 'on Approvals, and a version that has been replaced has already stopped.');
  end if;
  if v.effective_from is not null and p_effective_to < v.effective_from then
    return jsonb_build_object('ok', false, 'error', 'empty_window', 'ref', v.ref,
      'message', v.ref || ' started ' || v.effective_from || ' and would stop ' || p_effective_to
        || ': a window cannot end before it opens.');
  end if;

  update pricing_commission_rates
     set status = 'withdrawn', effective_to = p_effective_to, withdrawn_by = p_actor,
         withdrawn_at = now(), withdrawn_reason = v_reason, updated_by = p_actor
   where id = v.id;

  insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role)
  values (p_tenant, v.id, 'window', platform_auth.pricing_commission_rate_said(v),
      coalesce(v.effective_to::text, 'open'), p_effective_to::text, v.currency, v_reason,
      p_actor, p_role);
  insert into pricing_commission_history (tenant_id, rate_id, what, said, old_value, new_value,
      currency, reason, actor_user_id, actor_role)
  values (p_tenant, v.id, 'state', platform_auth.pricing_commission_rate_said(v), 'published',
      'withdrawn', v.currency, v_reason, p_actor, p_role);

  -- The readings do not move. An agreement stops asking on its stop day and everything it already asked
  -- for stays owed until a seat carries it or voids it — a stop that silently cancelled open readings
  -- would be a book act done by a pricing desk.
  select count(*)::int into v_open from pricing_commission_assessments
   where rate_id = v.id and status = 'assessed';

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_commission_rates', v.id, 'pricing.commission_withdrawn',
    jsonb_build_object('status', v.status, 'effective_to', v.effective_to::text),
    jsonb_build_object('ref', v.ref, 'subject_name', v.subject_name, 'source_kind', v.source_kind,
      'value', v.value::text, 'stop_day', p_effective_to::text, 'reason', v_reason,
      'open_readings', v_open, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'stopped', v.ref, 'effective_to', p_effective_to::text,
    'open_readings', v_open,
    'message', v.ref || ' stops on ' || p_effective_to || '. ' || v_open
      || ' reading(s) already taken under it stay open until the office carries them or voids them — '
      || 'a stopped agreement does not repay a cut it already asked for.',
    'rate', platform_auth.pricing_commission_rate_detail(p_tenant, v.id));
end $$;

-- ============================================================
-- 13. the readings: one cut, against one named transaction
-- ============================================================

-- Take the cut. The amount is read out of the transaction's own register and never typed, the day is the
-- transaction's and not today's, the rung is the ladder's answer and not the clerk's choice, and the
-- figure is the arithmetic in section 7 working the rate's own words against the money's own amount.
--
-- Every refusal below is the register declining to invent something: a transaction that is not real, a
-- cut that is not agreed, a money that does not match, a figure that is nothing, a cut bigger than the
-- money it sits on, and a transaction already cut. A door that assessed through any of those would be a
-- way of making liabilities out of nothing, which is the one thing 141's header said this migration
-- cannot do.
create or replace function platform_auth.assess_commission(
  p_tenant uuid, p_source_kind text, p_source_id uuid, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_src jsonb;
  v_rate jsonb;
  v_note text;
  v_key uuid;
  v_on date;
  v_amount numeric;
  v_money text;
  v_basis text;
  v_value numeric;
  v_raw numeric(14,4);
  v_figure numeric(14,2);
  v_new pricing_commission_assessments;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can take a cut.');
  end if;
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null
                   and t.type = 'platform') then
    return jsonb_build_object('ok', false, 'error', 'not_the_office',
      'message', 'A cut is taken in the office''s own book.');
  end if;
  v_note := nullif(trim(coalesce(p_note, '')), '');
  if v_note is not null and (char_length(v_note) < 8 or char_length(v_note) > 600) then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'A note beside a reading is either nothing or 8-600 characters.');
  end if;

  v_src := platform_auth.commission_source_said(p_source_kind, p_source_id);
  if v_src ->> 'ok' <> 'true' then
    return v_src;
  end if;
  v_amount := (v_src ->> 'amount')::numeric;
  v_money := v_src ->> 'currency';
  v_on := (v_src ->> 'on_day')::date;

  v_rate := platform_auth.commission_rate_in_force(p_tenant, (v_src ->> 'company')::uuid,
                                                  p_source_kind, v_on);
  if v_rate ->> 'ok' <> 'true' then
    return jsonb_build_object('ok', false, 'error', 'no_rate', 'source', v_src, 'ladder',
      v_rate -> 'ladder', 'message', v_rate ->> 'message');
  end if;
  v_basis := v_rate ->> 'basis';
  v_value := (v_rate ->> 'value')::numeric;

  if v_basis = 'flat' and v_rate ->> 'currency' <> v_money then
    return jsonb_build_object('ok', false, 'error', 'money_mismatch',
      'rate_currency', v_rate ->> 'currency', 'source_currency', v_money, 'ref', v_rate ->> 'ref',
      'message', (v_rate ->> 'ref') || ' is a flat cut in ' || (v_rate ->> 'currency') || ' and '
        || (v_src ->> 'ref') || ' is in ' || v_money || '. 138 sums a count per money and refuses the '
        || 'other side of it; a register refuses it before a reading is written.');
  end if;

  v_raw := platform_auth.commission_raw(v_basis, v_value, v_amount);
  v_figure := platform_auth.commission_figure(v_basis, v_value, v_amount,
    nullif(v_rate ->> 'floor_amount', '')::numeric, nullif(v_rate ->> 'cap', '')::numeric);

  if v_figure is null or v_figure <= 0 then
    return jsonb_build_object('ok', false, 'error', 'nothing_to_cut', 'raw', v_raw::text,
      'message', 'The cut worked out at nothing against ' || (v_src ->> 'ref') || '. A reading of zero '
        || 'is a row nobody owes; the register keeps none.');
  end if;
  if v_figure > v_amount then
    return jsonb_build_object('ok', false, 'error', 'floor_above_the_money', 'figure', v_figure::text,
      'amount', v_amount::text, 'ref', v_rate ->> 'ref',
      'message', (v_rate ->> 'ref') || ' asks ' || v_figure || ' out of ' || (v_src ->> 'ref')
        || ', which is only ' || v_amount || ' — the least the agreement sets is bigger than the '
        || 'transaction it is cut from. Fix the agreement, not the reading.');
  end if;

  if exists (select 1 from pricing_commission_assessments m
              where m.source_kind = p_source_kind and m.source_id = p_source_id
                and m.payee_kind = v_rate ->> 'payee_kind'
                and m.payee_id is not distinct from (v_rate ->> 'payee_id')::uuid
                and m.voided_at is null) then
    return jsonb_build_object('ok', false, 'error', 'already_assessed',
      'message', (v_src ->> 'ref') || ' has already been cut for ' || (v_rate ->> 'payee_name')
        || '. A second reading of the same cut is the double-count this register exists to refuse; void '
        || 'the first one if the figure was wrong.');
  end if;

  insert into pricing_commission_assessments (id, tenant_id, ref, rate_id, rate_ref, rate_version,
      rate_basis, rate_value, rate_currency, subject_kind, subject_key, subject_name, payee_kind,
      payee_id, payee_name, source_kind, source_id, source_ref, source_amount, currency, raw_amount,
      figure, assessed_on, status, note, assessed_by, assessed_role)
  values (gen_random_uuid(), p_tenant,
          'CMA-' || to_char(now(), 'YYYY') || '-'
                  || lpad(nextval('pricing_commission_assessment_number_seq')::text, 5, '0'),
          (v_rate ->> 'rate_id')::uuid, v_rate ->> 'ref', (v_rate ->> 'version')::int,
          v_basis, trim(to_char(v_value, 'FM999999990.9999')), v_rate ->> 'currency',
          v_rate ->> 'subject_kind',
          coalesce((v_rate ->> 'rung_key')::uuid,
                   platform_auth.commission_subject_key(v_rate ->> 'subject_kind', null, null)),
          v_rate ->> 'subject_name', v_rate ->> 'payee_kind',
          (v_rate ->> 'payee_id')::uuid, v_rate ->> 'payee_name',
          p_source_kind, p_source_id, v_src ->> 'ref', v_amount, v_money, v_raw, v_figure,
          v_on, 'assessed', v_note, p_actor, p_role)
  returning * into v_new;

  insert into pricing_commission_history (tenant_id, rate_id, assessment_id, what, said, old_value,
      new_value, currency, reason, actor_user_id, actor_role)
  values (p_tenant, v_new.rate_id, v_new.id, 'assess', platform_auth.pricing_commission_rate_said(
            (select a from pricing_commission_rates a where a.id = v_new.rate_id)),
      null, v_new.figure::text, v_new.currency,
      'Cut taken against ' || v_new.source_ref || ' for ' || v_new.assessed_on::text || '.',
      p_actor, p_role);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_commission_assessments', v_new.id, 'pricing.commission_assessed', null,
    jsonb_build_object('ref', v_new.ref, 'rate_ref', v_new.rate_ref, 'rate_version', v_new.rate_version,
      'basis', v_new.rate_basis, 'rate_value', v_new.rate_value, 'subject_name', v_new.subject_name,
      'source_kind', v_new.source_kind, 'source_ref', v_new.source_ref,
      'source_id', v_new.source_id, 'source_amount', v_new.source_amount::text,
      'raw', v_new.raw_amount::text, 'figure', v_new.figure::text, 'currency', v_new.currency,
      'assessed_on', v_new.assessed_on::text, 'payee_kind', v_new.payee_kind,
      'payee_name', v_new.payee_name, 'note', v_new.note, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'reading',
    platform_auth.pricing_commission_reading_detail(p_tenant, v_new.id));
end $$;

-- The movement that carried the cut. This is the half of the promise 141's header could not let 142 skip:
-- a register of liabilities is only honest if the claim "this one has been paid" is checked against the
-- book rather than typed beside the row. So the door takes a pointer — a payout or a posting — and reads
-- the figure *out of the book*, then refuses the pointer when the movement does not carry the cut the
-- register computed.
--
-- Two shapes, because a cut is kept or owed and the book says them differently:
--   * kept by the office (`payee_kind = 'platform'`): 134 books a payout's `fee_amount` to FEE-INCOME at
--     the moment the cash leaves, so a *paid* payout whose fee equals the figure is the movement; or a
--     posted paper carrying a credit leg of exactly the figure on the fee income line of that money.
--   * owed out to a company, driver or staff member: a released or paid payout aimed at that same payee
--     for exactly the figure; or a posted paper carrying a debit leg of exactly the figure on the cost
--     line of that money.
-- A payout still `raised` or `pending_signature` carries nothing and is refused, and a `reversed` posting
-- is refused. This door writes no leg: 133's `record_money_posting` and 134's doors still own the book,
-- and a seat that points a reading at one of their movements must hold `control.money.post` — the duty
-- that lets a seat write in the book is the duty that lets a seat claim the book already did.
create or replace function platform_auth.discharge_commission_assessment(
  p_tenant uuid, p_assessment uuid, p_carrier_kind text, p_carrier_id uuid, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v pricing_commission_assessments;
  v_rate pricing_commission_rates;
  v_payout money_payouts;
  v_posting money_postings;
  v_leg numeric(14,2);
  v_fee_code text;
  v_cost_code text;
  v_note text;
  v_ref text;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can say a cut has been carried.');
  end if;
  if not exists (select 1 from user_roles ur
                   join roles r on r.id = ur.role_id
                   join role_permissions rp on rp.role_id = ur.role_id
                  where ur.user_id = p_actor and r.tenant_id is null
                    and rp.permission_key = 'control.money.post'
                    and (ur.expires_at is null or ur.expires_at > now())) then
    return jsonb_build_object('ok', false, 'error', 'no_money_duty',
      'message', 'Carrying a cut names a movement in 133''s book, and a seat that cannot write in the '
        || 'book cannot claim the book already did. Ask for control.money.post.');
  end if;
  if p_carrier_kind is null or p_carrier_kind not in ('payout','posting') then
    return jsonb_build_object('ok', false, 'error', 'bad_carrier', 'asked', p_carrier_kind,
      'message', 'A cut is carried by a payout or a posting — the two movements the book itself makes. '
        || 'Nothing else is a payment.');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say in 8-600 characters what carried the cut; the sentence is read beside the '
        || 'movement''s own number.');
  end if;

  select * into v from pricing_commission_assessments
   where id = p_assessment and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no cut reading with that number in this book.');
  end if;
  if v.status = 'discharged' then
    return jsonb_build_object('ok', false, 'error', 'already_carried', 'ref', v.ref,
      'carrier', v.carrier_ref,
      'message', v.ref || ' is already carried by ' || v.carrier_ref || '. A cut is paid once, and a '
        || 'second movement pointed at it would be the double-count the register exists to refuse.');
  end if;
  if v.status = 'voided' then
    return jsonb_build_object('ok', false, 'error', 'is_voided', 'ref', v.ref,
      'message', v.ref || ' was cancelled on ' || v.voided_at::date || ' and cancelled the cut it '
        || 'claimed. A cancelled reading owes nothing, so there is nothing to carry.');
  end if;

  select * into v_rate from pricing_commission_rates where id = v.rate_id and tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'rate_missing', 'ref', v.ref,
      'message', v.ref || ' reads ' || v.rate_ref || ', and that agreement is not in this book. '
        || 'The register cannot be answered for a paper this office never signed.');
  end if;

  v_fee_code := 'FEE-INCOME' || case when v.currency = 'USD' then '-USD' else '' end;
  v_cost_code := 'COST-OPS' || case when v.currency = 'USD' then '-USD' else '' end;

  if p_carrier_kind = 'payout' then
    select * into v_payout from money_payouts
     where id = p_carrier_id and tenant_id = p_tenant;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'no_such_payout',
        'message', 'There is no payout ' || p_carrier_id || ' in this book. A pointer at a movement the '
          || 'office never raised is how a liability is called paid by a keystroke.');
    end if;
    if v_payout.status not in ('released','paid') then
      return jsonb_build_object('ok', false, 'error', 'payout_has_not_moved', 'ref', v_payout.ref,
        'payout_status', v_payout.status,
        'message', v_payout.ref || ' is ' || v_payout.status || '. A raised paper is a plan and an '
          || 'unsigned one is a question; neither is money that left, so neither carries ' || v.ref || '.');
    end if;
    if v_payout.currency <> v.currency then
      return jsonb_build_object('ok', false, 'error', 'carrier_is_other_money', 'ref', v_payout.ref,
        'payout_currency', v_payout.currency, 'reading_currency', v.currency,
        'message', v_payout.ref || ' moves ' || v_payout.currency || ' and ' || v.ref || ' is a cut in '
          || v.currency || '. 138 counts a sum per money and refuses the other side of it; the register '
          || 'refuses it before a seat marks a cut carried.');
    end if;
    if v.payee_kind = 'platform' then
      -- The office keeping the cut is the one case 134 already books on its own: the fee line. It is only
      -- evidence once the cash has left, because that is the moment 134 posts it to FEE-INCOME.
      if v_payout.status <> 'paid' then
        return jsonb_build_object('ok', false, 'error', 'fee_is_not_booked_yet', 'ref', v_payout.ref,
          'payout_status', v_payout.status,
          'message', v_payout.ref || ' carries a fee of ' || v_payout.fee_amount || ' but has not been '
            || 'paid, so the office''s part sits on no income line yet. ' || v.ref || ' is kept by the '
            || 'office and is discharged against a paid payout or a posted ' || v_fee_code || ' leg.');
      end if;
      if v_payout.fee_amount <> v.figure then
        return jsonb_build_object('ok', false, 'error', 'carrier_does_not_carry_the_cut',
          'ref', v_payout.ref, 'asked', v.figure::text, 'carries', v_payout.fee_amount::text,
          'message', v.ref || ' is a cut of ' || v.figure || ' ' || v.currency || ' the office keeps, and '
            || v_payout.ref || ' carries a fee of ' || v_payout.fee_amount
            || '. The register reads the figure out of the movement, so a fee typed to match nothing is '
            || 'refused — fix the payout or void the reading, not the pointer.');
      end if;
    else
      if v_payout.payee_kind <> v.payee_kind
        or v_payout.payee_id is distinct from v.payee_id then
        return jsonb_build_object('ok', false, 'error', 'carrier_is_another_payee', 'ref', v_payout.ref,
          'payout_payee', v_payout.payee_name, 'reading_payee', v.payee_name,
          'message', v.ref || ' is owed to ' || v.payee_name || ' (' || v.payee_kind || '), and '
            || v_payout.ref || ' pays ' || v_payout.payee_name || ' (' || v_payout.payee_kind
            || '). A cut paid to the wrong person is not carried; it is still owed.');
      end if;
      if v_payout.amount <> v.figure then
        return jsonb_build_object('ok', false, 'error', 'carrier_does_not_carry_the_cut',
          'ref', v_payout.ref, 'asked', v.figure::text, 'carries', v_payout.amount::text,
          'message', v.ref || ' is a cut of ' || v.figure || ' ' || v.currency || ' owed to '
            || v.payee_name || ', and ' || v_payout.ref || ' sends ' || v_payout.amount
            || '. The gap is the part nobody has been paid, and the register keeps counting it.');
      end if;
    end if;
    v_ref := v_payout.ref;
  else
    select * into v_posting from money_postings
     where id = p_carrier_id and tenant_id = p_tenant;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'no_such_posting',
        'message', 'There is no posting ' || p_carrier_id || ' in this book.');
    end if;
    if v_posting.status = 'reversed' then
      return jsonb_build_object('ok', false, 'error', 'posting_is_reversed', 'ref', v_posting.ref,
        'message', v_posting.ref || ' has been reversed. An undone movement cannot be the proof a cut '
          || 'was carried; point the reading at the paper that stands, or leave it open.');
    end if;
    if v_posting.currency <> v.currency then
      return jsonb_build_object('ok', false, 'error', 'carrier_is_other_money', 'ref', v_posting.ref,
        'posting_currency', v_posting.currency, 'reading_currency', v.currency,
        'message', v_posting.ref || ' is a ' || v_posting.currency || ' paper and ' || v.ref
          || ' is a cut in ' || v.currency || '. One currency per posting is 133''s rule, and the '
          || 'register keeps it.');
    end if;
    if v.payee_kind = 'platform' then
      select e.amount into v_leg from money_entries e
        join money_accounts a on a.id = e.account_id
       where e.posting_id = v_posting.id
         and e.tenant_id = p_tenant
         and a.code = v_fee_code
         and e.direction = 'credit';
      if v_leg is null then
        return jsonb_build_object('ok', false, 'error', 'carrier_has_no_such_leg', 'ref', v_posting.ref,
          'looked_for', 'a credit leg on ' || v_fee_code,
          'message', v.ref || ' is a cut the office keeps, and ' || v_posting.ref || ' has no leg on '
            || v_fee_code || '. A cut the office took is income, and income has a line: post it or point '
            || 'the reading at the paper that does.');
      end if;
      if v_leg <> v.figure then
        return jsonb_build_object('ok', false, 'error', 'carrier_does_not_carry_the_cut',
          'ref', v_posting.ref, 'asked', v.figure::text, 'carries', v_leg::text,
          'message', v.ref || ' is a cut of ' || v.figure || ' ' || v.currency || ' and ' || v_posting.ref
            || ' books ' || v_leg || ' to ' || v_fee_code || '. The register reads the figure out of the '
            || 'leg, so the two books cannot drift apart on a pointer.');
      end if;
    else
      select e.amount into v_leg from money_entries e
        join money_accounts a on a.id = e.account_id
       where e.posting_id = v_posting.id
         and e.tenant_id = p_tenant
         and a.code = v_cost_code
         and e.direction = 'debit';
      if v_leg is null then
        return jsonb_build_object('ok', false, 'error', 'carrier_has_no_such_leg', 'ref', v_posting.ref,
          'looked_for', 'a debit leg on ' || v_cost_code,
          'message', v.ref || ' is owed out to ' || v.payee_name || ', and ' || v_posting.ref
            || ' has no leg on ' || v_cost_code || '. What the office pays an agent is a cost it bears; '
            || 'a posting with no cost line has not carried this cut.');
      end if;
      if v_leg <> v.figure then
        return jsonb_build_object('ok', false, 'error', 'carrier_does_not_carry_the_cut',
          'ref', v_posting.ref, 'asked', v.figure::text, 'carries', v_leg::text,
          'message', v.ref || ' is a cut of ' || v.figure || ' ' || v.currency || ' owed to '
            || v.payee_name || ', and ' || v_posting.ref || ' books ' || v_leg || ' to ' || v_cost_code
            || '. The gap is still owed, and the register keeps counting it.');
      end if;
    end if;
    v_ref := v_posting.ref;
  end if;

  update pricing_commission_assessments
     set status = 'discharged', discharged_at = now(), discharged_by = p_actor,
         carrier_kind = p_carrier_kind, carrier_id = p_carrier_id, carrier_ref = v_ref,
         discharge_note = v_note
   where id = v.id;

  insert into pricing_commission_history (tenant_id, rate_id, assessment_id, what, said, old_value,
      new_value, currency, reason, actor_user_id, actor_role)
  values (p_tenant, v.rate_id, v.id, 'discharge',
      platform_auth.pricing_commission_rate_said(v_rate), 'assessed',
      p_carrier_kind || ' ' || v_ref, v.currency, v_note, p_actor, p_role);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_commission_assessments', v.id, 'pricing.commission_discharged',
    jsonb_build_object('status', v.status, 'carrier_ref', v.carrier_ref),
    jsonb_build_object('ref', v.ref, 'figure', v.figure::text, 'currency', v.currency,
      'source_ref', v.source_ref, 'payee_kind', v.payee_kind, 'payee_name', v.payee_name,
      'carrier_kind', p_carrier_kind, 'carrier_id', p_carrier_id, 'carrier_ref', v_ref,
      'movement_total', case when p_carrier_kind = 'payout' then v_payout.amount::text
                             else v_posting.total::text end,
      'booked_leg', case when p_carrier_kind = 'payout' then 'payout fee/payable'
                         else v_leg::text end,
      'note', v_note, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'ref', v.ref, 'carried_by', v_ref,
    'carrier_kind', p_carrier_kind, 'carrier_id', p_carrier_id,
    'message', v.ref || ' is carried by ' || v_ref || ': the register read ' || v.figure || ' '
      || v.currency || ' out of ' || (case when p_carrier_kind = 'payout' then v_payout.ref
                                           else v_posting.ref end)
      || ' and the movement carries exactly that.',
    'reading', platform_auth.pricing_commission_reading_detail(p_tenant, v.id));
end $$;

-- Cancel a reading. The register keeps the mistake and stops counting it: 138's void column exists for
-- exactly this, and a void is the only way a wrong figure leaves a sum without disappearing from the
-- record. The void does not touch the book — there is nothing to touch, because a cut the office has not
-- carried moved no money. A discharged reading is therefore refused here in the same words the pointer
-- above would use: a movement that has carried a cut is answered in the book, by 133's reversal, and the
-- register will not be made to disagree with it.
create or replace function platform_auth.void_commission_assessment(
  p_tenant uuid, p_assessment uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v pricing_commission_assessments;
  v_rate pricing_commission_rates;
  v_reason text;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can cancel a cut.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters why the reading is cancelled: the sentence is the only thing '
        || 'that explains a void to whoever reads the count next month.');
  end if;

  select * into v from pricing_commission_assessments
   where id = p_assessment and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no cut reading with that number in this book.');
  end if;
  if v.status = 'voided' then
    return jsonb_build_object('ok', false, 'error', 'already_voided', 'ref', v.ref,
      'message', v.ref || ' was already cancelled on ' || v.voided_at::date || ' by the reason '
        || quote_literal(v.void_reason) || '.');
  end if;
  if v.status = 'discharged' then
    return jsonb_build_object('ok', false, 'error', 'already_carried', 'ref', v.ref,
      'carrier', v.carrier_ref,
      'message', v.ref || ' was carried by ' || v.carrier_ref || '. The money moved, so cancelling the '
        || 'reading would leave the register disagreeing with the book; answer it in the book — reverse '
        || 'the posting or let the payout fail — and take the corrected cut against the paper that '
        || 'stands. This reading stays discharged: the transaction was cut once.');
  end if;

  select * into v_rate from pricing_commission_rates where id = v.rate_id and tenant_id = p_tenant;

  update pricing_commission_assessments
     set status = 'voided', voided_at = now(), voided_by = p_actor, void_reason = v_reason
   where id = v.id;

  insert into pricing_commission_history (tenant_id, rate_id, assessment_id, what, said, old_value,
      new_value, currency, reason, actor_user_id, actor_role)
  values (p_tenant, v.rate_id, v.id, 'void',
      case when v_rate.id is null then v.rate_ref
           else platform_auth.pricing_commission_rate_said(v_rate) end,
      'assessed', 'voided', v.currency, v_reason, p_actor, p_role);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_commission_assessments', v.id, 'pricing.commission_voided',
    jsonb_build_object('status', v.status),
    jsonb_build_object('ref', v.ref, 'rate_ref', v.rate_ref, 'figure', v.figure::text,
      'currency', v.currency, 'source_kind', v.source_kind, 'source_ref', v.source_ref,
      'payee_name', v.payee_name, 'assessed_on', v.assessed_on::text, 'reason', v_reason,
      'seat', v_seat));

  return jsonb_build_object('ok', true, 'voided', v.ref, 'figure', v.figure::text,
    'message', v.ref || ' is cancelled and drops out of every count except the void column. '
      || v.source_ref || ' is free for a corrected reading — the same cut, taken once.',
    'reading', platform_auth.pricing_commission_reading_detail(p_tenant, v.id));
end $$;

-- ============================================================
-- 14. the duties this card uses, and the grants on the doors
-- ============================================================

-- No new duty, and that is a decision rather than an omission. 140 minted `control.pricing.view`,
-- `.manage` and `.publish`, and they were minted for exactly this shape of work: read a price register,
-- draft and change one, and be the seat that signs it. A commission is the third pricing card on the same
-- desk, so it joins the same three keys. The fourth key a commission *does* need already exists: 133's
-- `control.money.post`, because a seat that says a cut has been carried is asserting a fact about the
-- book, and only a seat that can write in the book may assert one. A seat that holds the pricing duties
-- and not the money duty can draft, sign and assess a cut, and the discharge panel says so in words
-- instead of pretending the press would work.
--
-- The census in section 15 asserts all four keys exist and that no fifth was minted here: a duty key with
-- no seat is a nav entry that answers a clerk with an empty ladder, which is 140's own refusal.
do $$
declare
  v_missing text;
begin
  select string_agg(need.k, ', ' order by need.k) into v_missing
    from (values ('control.pricing.view'), ('control.pricing.manage'),
                 ('control.pricing.publish'), ('control.money.post')) as need(k)
   where not exists (select 1 from permissions p where p.key = need.k);
  if v_missing is not null then
    raise exception '142: this card gates itself on % and the register has no such duty', v_missing
      using errcode = '23514';
  end if;
  if not exists (select 1 from role_permissions rp
                   join roles r on r.id = rp.role_id
                  where r.tenant_id is null and rp.permission_key = 'control.money.post') then
    raise exception '142: no platform role holds control.money.post, so no seat could ever discharge a '
      'cut and the register would hold debts it can only ever count'
      using errcode = '23514';
  end if;
  if exists (select 1 from permissions where key like 'control.pricing.%'
               and key not in ('control.pricing.view','control.pricing.manage','control.pricing.publish')) then
    raise exception '142: a fourth pricing duty has appeared. The commission card joins 140''s three; a '
      'fourth is a nav entry nobody granted'
      using errcode = '23514';
  end if;
end $$;

-- The internal bodies first: the arithmetic, the resolver's parts, the paper builder, the trigger guards
-- and the `said` printer. They are the register's own working, and a client role that could call
-- `commission_figure` with its own numbers would be holding a calculator pointed at nothing, while a role
-- that could call a guard body could ask it about a row it cannot see. Revoked from every non-owner role,
-- including the app role. The doors still call them: a door and the body it calls were created by the same
-- owner in this file, and an owner always holds execute on its own functions — which is exactly what a
-- `from ... app_runtime` revoke leaves untouched.
revoke execute on function
  platform_auth.commission_subject_key(text, uuid, uuid),
  platform_auth.commission_raw(text, numeric, numeric),
  platform_auth.commission_figure(text, numeric, numeric, numeric, numeric),
  platform_auth.commission_source_said(text, uuid),
  platform_auth.commission_rate_paper(uuid),
  platform_auth.commission_rate_sha256(uuid),
  platform_auth.pricing_commission_rate_said(pricing_commission_rates),
  platform_auth.pricing_commission_history_is_kept(),
  platform_auth.pricing_commission_rate_is_kept(),
  platform_auth.pricing_commission_rate_is_immutable(),
  platform_auth.pricing_one_commission_per_day(),
  platform_auth.pricing_commission_names_its_book(),
  platform_auth.pricing_commission_reading_is_kept(),
  platform_auth.pricing_commission_reading_keeps_its_facts(),
  platform_auth.commission_rate_in_force(uuid, uuid, text, date)
from public, anon, authenticated, service_role, app_runtime;

-- The reads. `commission_rate_in_force` stays internal on purpose: it is the ladder's answer to "which
-- agreement rules this day", and the desk's question is "what is the cut", which is `commission_on` — the
-- one body that answers the ladder *and* the money *and* whether the transaction has already been cut. A
-- desk given the bare rung would render a figure it had not checked against the transaction's money, and
-- that mismatch is 138's defect.
grant execute on function
  platform_auth.pricing_commission_rates(uuid, text, text, text, text, int, int),
  platform_auth.pricing_commission_rate_detail(uuid, uuid),
  platform_auth.pricing_commission_rate_memory(uuid, uuid, int, int),
  platform_auth.commission_on(uuid, uuid, text, uuid),
  platform_auth.pricing_commission_assessments(uuid, text, text, text, date, date, int, int),
  platform_auth.pricing_commission_reading_detail(uuid, uuid),
  platform_auth.pricing_commission_summary(uuid, date, date),
  platform_auth.pricing_commission_choices(uuid, text, text, int)
to app_runtime;

-- The doors. Every one of them takes the book's uuid as its first argument and binds it in every
-- statement: this schema's role can bypass row-level security, so a door that trusted the policy would be
-- a door with no lock on it.
grant execute on function
  platform_auth.open_pricing_commission_rate(uuid, text, uuid, uuid, text, text, uuid, text, numeric,
    text, numeric, numeric, date, date, text, uuid, text, text, text),
  platform_auth.edit_pricing_commission_rate(uuid, uuid, numeric, numeric, numeric, date, date, text,
    text, uuid, text, text, text),
  platform_auth.discard_pricing_commission_rate(uuid, uuid, text, uuid, text, text, text),
  platform_auth.clone_pricing_commission_rate(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.propose_pricing_commission_rate(uuid, uuid, text, uuid, text, text, text),
  platform_auth.refuse_pricing_commission_rate(uuid, uuid, text, uuid, text, text, text),
  platform_auth.apply_pricing_commission_rate(uuid, uuid, text, text),
  platform_auth.withdraw_pricing_commission_rate(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.assess_commission(uuid, text, uuid, text, uuid, text, text, text),
  platform_auth.discharge_commission_assessment(uuid, uuid, text, uuid, text, uuid, text, text, text),
  platform_auth.void_commission_assessment(uuid, uuid, text, uuid, text, text, text)
to app_runtime;

-- The doors stay granted to `app_runtime` — that is the only role the API connects as — and are then
-- taken back from every Supabase-side role. 141's reason in its own words: `create or replace function`
-- hands EXECUTE back to PUBLIC, so a grant list that is not followed by a revoke list is a desk whose
-- doors are open to every authenticated session in the building. `authenticated` is a company's clerk,
-- not the office.
revoke all on function
  platform_auth.pricing_commission_rates(uuid, text, text, text, text, int, int),
  platform_auth.pricing_commission_rate_detail(uuid, uuid),
  platform_auth.pricing_commission_rate_memory(uuid, uuid, int, int),
  platform_auth.commission_on(uuid, uuid, text, uuid),
  platform_auth.pricing_commission_assessments(uuid, text, text, text, date, date, int, int),
  platform_auth.pricing_commission_reading_detail(uuid, uuid),
  platform_auth.pricing_commission_summary(uuid, date, date),
  platform_auth.pricing_commission_choices(uuid, text, text, int),
  platform_auth.open_pricing_commission_rate(uuid, text, uuid, uuid, text, text, uuid, text, numeric,
    text, numeric, numeric, date, date, text, uuid, text, text, text),
  platform_auth.edit_pricing_commission_rate(uuid, uuid, numeric, numeric, numeric, date, date, text,
    text, uuid, text, text, text),
  platform_auth.discard_pricing_commission_rate(uuid, uuid, text, uuid, text, text, text),
  platform_auth.clone_pricing_commission_rate(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.propose_pricing_commission_rate(uuid, uuid, text, uuid, text, text, text),
  platform_auth.refuse_pricing_commission_rate(uuid, uuid, text, uuid, text, text, text),
  platform_auth.apply_pricing_commission_rate(uuid, uuid, text, text),
  platform_auth.withdraw_pricing_commission_rate(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.assess_commission(uuid, text, uuid, text, uuid, text, text, text),
  platform_auth.discharge_commission_assessment(uuid, uuid, text, uuid, text, uuid, text, text, text),
  platform_auth.void_commission_assessment(uuid, uuid, text, uuid, text, text, text)
from public, anon, authenticated, service_role;

-- The two numbering sequences: owner and definer doors only. A client role that could `nextval` a ref
-- would leave the office a hole in its own numbering to explain, and 134's, 135's and 141's gates all
-- count the same thing.
revoke all on pricing_commission_rate_number_seq from public, anon, authenticated, service_role, app_runtime;
revoke all on pricing_commission_assessment_number_seq from public, anon, authenticated, service_role, app_runtime;

-- ============================================================
-- 15. the census: the words, the bodies and the figures have to agree
-- ============================================================

-- 141's lesson, written as a refusal rather than a promise. A table that lists a source word the resolver
-- has no arm for is a desk offering a transaction the register cannot price; an agreement whose rung key
-- is not the one the ladder computes is a version chain nobody walks; and a reading whose figure cannot be
-- rebuilt from its own printed rate is a book that has already drifted from the paper it cites. Each block
-- below is a question the migration can answer only once, and it answers it by refusing to finish.
do $$
declare
  v_tables int;
  v_unprotected int;
  v_readers int;
  v_writers int;
  v_subjects int;
  v_bad_subject int;
  v_sources int;
  v_no_arm int;
  v_no_list int;
  v_choice_src text;
  v_stray_word int;
  v_bad_figure int;
  v_bad_key int;
  v_orphan_reading int;
  v_unsigned_reading int;
  v_drift int;
  v_dead_word int;
  v_leaks int;
  v_internal_grants int;
  v_seq_holders int;
  v_words int;
  v_kinds int;
  v_duties int;
  v_live int;
  v_open int;
  v_src text;
  v_quoted text;
begin
  select count(*)::int into v_tables from pg_tables
   where schemaname = 'public'
     and tablename in ('pricing_commission_subjects','pricing_commission_sources',
                       'pricing_commission_rates','pricing_commission_history',
                       'pricing_commission_assessments');
  if v_tables <> 5 then
    raise exception '142: the cut register is % of its five tables', v_tables;
  end if;

  select count(*)::int into v_unprotected from pg_tables t
   where t.schemaname = 'public'
     and t.tablename in ('pricing_commission_subjects','pricing_commission_sources',
                         'pricing_commission_rates','pricing_commission_history',
                         'pricing_commission_assessments')
     and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where c.relname = t.tablename and n.nspname = 'public' and c.relrowsecurity);
  if v_unprotected <> 0 then
    raise exception '142: % of the cut registers can be read without a book being named', v_unprotected;
  end if;

  select count(distinct c.relname)::int into v_readers
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relname in ('pricing_commission_subjects','pricing_commission_sources',
                       'pricing_commission_rates','pricing_commission_history',
                       'pricing_commission_assessments')
     and a.grantee = (select oid from pg_roles where rolname = 'app_runtime')
     and a.privilege_type = 'SELECT';
  if v_readers <> 5 then
    raise exception '142: the app role reads the cut registers through a door; it must read all five and '
      'it reads %', v_readers;
  end if;

  -- Not one direct write, in either direction. The register's whole argument is that a cut is written by a
  -- door that names a transaction and reads a figure; a role with INSERT on the table can do neither.
  select count(*)::int into v_writers
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relname in ('pricing_commission_subjects','pricing_commission_sources',
                       'pricing_commission_rates','pricing_commission_history',
                       'pricing_commission_assessments')
     and a.grantee = (select oid from pg_roles where rolname = 'app_runtime')
     and a.privilege_type in ('INSERT','UPDATE','DELETE');
  if v_writers <> 0 then
    raise exception '142: the app role writes cuts through a door and holds % direct write grant(s)',
      v_writers;
  end if;

  -- The ladder, in the order the resolver walks it. A fourth rung would be a rung the `continue` in
  -- `commission_rate_in_force` has no rule for, and the resolver would walk past it in silence.
  select count(*)::int into v_subjects from pricing_commission_subjects;
  if v_subjects <> 3 then
    raise exception '142: the ladder is three rungs — the company, its plan, the office''s own — and it '
      'holds %', v_subjects;
  end if;
  select count(*)::int into v_bad_subject from pricing_commission_subjects s
   where (s.key, s.priority, s.names) not in
         (('tenant',1,'company'), ('plan',2,'plan'), ('platform',3,'none'));
  if v_bad_subject <> 0 then
    raise exception '142: % rung(s) are filed under a priority or a naming rule the resolver was not '
      'written against', v_bad_subject;
  end if;

  -- The five transactions, and the resolver's arms. This is the check the header promised: a word in the
  -- table that `commission_source_said` has no branch for would be priced by nothing, and a branch for a
  -- word the table does not carry would be an arm the desk can never reach.
  select count(*)::int into v_sources from pricing_commission_sources;
  if v_sources <> 5 then
    raise exception '142: the office cuts five kinds of transaction and the register lists %', v_sources;
  end if;
  if exists (select 1 from pricing_commission_sources
              where (key, side, sort) not in
                    (('subscription_invoice','in',1), ('subscription_payment','in',2),
                     ('freight_invoice','in',3), ('freight_expense','out',4), ('payout','out',5))) then
    raise exception '142: a source is filed under a side or an order the doors were not written against';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth' and p.proname = 'commission_source_said';
  if v_src is null then
    raise exception '142: the register has no body that knows where a transaction''s money is';
  end if;
  select count(*)::int into v_no_arm from pricing_commission_sources s
   where position(chr(39) || s.key || chr(39) in v_src) = 0;
  if v_no_arm <> 0 then
    raise exception '142: % source word(s) are listed for the desk and have no arm in '
      'commission_source_said, so they would be priced by nothing', v_no_arm;
  end if;
  v_quoted := 'p_source_kind = ' || chr(39);
  select count(*)::int into v_stray_word
    from (select distinct mm[1] as w
            from regexp_matches(v_src, v_quoted || '([a-z_0-9]+)' || chr(39), 'g') as t(mm)) found
   where not exists (select 1 from pricing_commission_sources s where s.key = found.w);
  if v_stray_word <> 0 then
    raise exception '142: the resolver branches on % transaction word(s) the register does not list — a '
      'branch the desk can never reach is a branch nobody tests', v_stray_word;
  end if;

  -- The same five words against the picker. `pricing_commission_choices` is the door a clerk uses to find a
  -- transaction to cut, so a word the resolver prices and the picker cannot list is a cut that can only be
  -- taken by pasting an uuid — which is the hole the door was written to close.
  select prosrc into v_choice_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth' and p.proname = 'pricing_commission_choices';
  if v_choice_src is null then
    raise exception '142: the register has no picker, so an agreement would have to be opened by uuid';
  end if;
  select count(*)::int into v_no_list from pricing_commission_sources s
   where position(chr(39) || s.key || chr(39) in v_choice_src) = 0;
  if v_no_list <> 0 then
    raise exception '142: % source word(s) are priced by the register and cannot be picked off the desk',
      v_no_list;
  end if;

  -- The figures as the table allows them and as the arithmetic needs them. A percent carrying a currency
  -- would be a flat dressed as one, and a rung key that is not the recomputed one is a version chain the
  -- ladder walks past — 141's defect, this time against the body that computes the key.
  select count(*)::int into v_bad_figure from pricing_commission_rates r
   where (r.basis = 'percent_of_amount' and (r.currency is not null or r.value > 100))
      or (r.basis = 'flat' and r.currency is null);
  if v_bad_figure <> 0 then
    raise exception '142: % agreement(s) carry a basis and a money that the resolver cannot work out',
      v_bad_figure;
  end if;
  select count(*)::int into v_bad_key from pricing_commission_rates r
   where r.subject_key is distinct from
         platform_auth.commission_subject_key(r.subject_kind, r.subject_tenant_id, r.subject_plan_id);
  if v_bad_key <> 0 then
    raise exception '142: % agreement(s) are keyed on a rung the register''s own key function would not '
      'have chosen, so the ladder would answer a different question than the version chain is kept on',
      v_bad_key;
  end if;

  -- The readings replay. Every stored figure is worked again from the rate the reading itself printed and
  -- the transaction the reading itself named; two arithmetic paths is how a desk shows one figure and the
  -- book carries another. A published agreement's floor and cap are frozen by the immutability guard, so
  -- the replay has a stable pair to work against.
  select count(*)::int into v_orphan_reading from pricing_commission_assessments m
   where not exists (select 1 from pricing_commission_rates r
                      where r.id = m.rate_id and r.tenant_id = m.tenant_id);
  if v_orphan_reading <> 0 then
    raise exception '142: % reading(s) cite an agreement this book does not have', v_orphan_reading;
  end if;
  select count(*)::int into v_unsigned_reading from pricing_commission_assessments m
    join pricing_commission_rates r on r.id = m.rate_id
   where r.published_at is null;
  if v_unsigned_reading <> 0 then
    raise exception '142: % reading(s) were cut under an agreement no second seat signed',
      v_unsigned_reading;
  end if;
  select count(*)::int into v_drift
    from pricing_commission_assessments m
    join pricing_commission_rates r on r.id = m.rate_id
   where m.raw_amount <> platform_auth.commission_raw(m.rate_basis, m.rate_value::numeric,
                                                     m.source_amount)
      or m.figure <> platform_auth.commission_figure(m.rate_basis, m.rate_value::numeric,
                                                     m.source_amount, r.floor_amount, r.cap)
      or m.subject_key is distinct from r.subject_key
      or m.payee_kind <> r.payee_kind
      or m.payee_id is distinct from r.payee_id;
  if v_drift <> 0 then
    raise exception '142: % reading(s) no longer replay from the rate they print — the register and the '
      'paper it cites have drifted apart', v_drift;
  end if;

  -- Six memory words, and every one of them written by a door. A word the CHECK allows and no body can
  -- write is a clerk asked to look for a change that never happened; this is the dead-vocabulary mistake
  -- this file already made and corrected once.
  select count(*)::int into v_dead_word
    from (values ('figure'), ('window'), ('state'), ('assess'), ('discharge'), ('void')) as w(word)
   where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'platform_auth'
                        and p.proname in ('open_pricing_commission_rate','edit_pricing_commission_rate',
                                          'clone_pricing_commission_rate','propose_pricing_commission_rate',
                                          'refuse_pricing_commission_rate','apply_pricing_commission_rate',
                                          'withdraw_pricing_commission_rate','assess_commission',
                                          'discharge_commission_assessment','void_commission_assessment')
                        and position(chr(39) || w.word || chr(39) in p.prosrc) > 0);
  if v_dead_word <> 0 then
    raise exception '142: the history table allows % word(s) no door can write', v_dead_word;
  end if;

  -- The doors, pointed at from outside the register.
  select coalesce(count(*)::int, 0) into v_leaks
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join aclexplode(p.proacl) a
   where n.nspname = 'platform_auth'
     and p.proname in ('pricing_commission_rates','pricing_commission_rate_detail',
                       'pricing_commission_rate_memory','commission_on',
                       'pricing_commission_assessments','pricing_commission_reading_detail',
                       'pricing_commission_summary','open_pricing_commission_rate',
                       'edit_pricing_commission_rate','discard_pricing_commission_rate',
                       'pricing_commission_choices',
                       'clone_pricing_commission_rate','propose_pricing_commission_rate',
                       'refuse_pricing_commission_rate','apply_pricing_commission_rate',
                       'withdraw_pricing_commission_rate','assess_commission',
                       'discharge_commission_assessment','void_commission_assessment')
     and (a.grantee = 0
          or a.grantee = any (select oid from pg_roles
                               where rolname in ('anon','authenticated','service_role')));
  if v_leaks <> 0 then
    raise exception '142: % of the cut doors are still grantable to a client role or to PUBLIC', v_leaks;
  end if;

  select coalesce(count(*)::int, 0) into v_internal_grants
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join aclexplode(p.proacl) a
   where n.nspname = 'platform_auth'
     and p.proname in ('commission_subject_key','commission_raw','commission_figure',
                       'commission_source_said','commission_rate_paper','commission_rate_sha256',
                       'pricing_commission_rate_said','commission_rate_in_force',
                       'pricing_commission_history_is_kept','pricing_commission_rate_is_kept',
                       'pricing_commission_rate_is_immutable','pricing_one_commission_per_day',
                       'pricing_commission_names_its_book','pricing_commission_reading_is_kept',
                       'pricing_commission_reading_keeps_its_facts')
     and (a.grantee = 0 or a.grantee = (select oid from pg_roles where rolname = 'app_runtime'));
  if v_internal_grants <> 0 then
    raise exception '142: the arithmetic and the guards are the register''s own working, and % of them '
      'still answer a caller', v_internal_grants;
  end if;

  -- The signature's door has to be reachable, or a paper a second seat signed could never be spent.
  if not exists (select 1 from pg_roles r
                  where r.rolname = 'app_runtime'
                    and has_function_privilege(r.oid,
                          'platform_auth.apply_pricing_commission_rate(uuid, uuid, text, text)',
                          'EXECUTE')) then
    raise exception '142: the door that spends a commission signature is not executable by the app role';
  end if;
  if not exists (select 1 from pg_roles r
                  where r.rolname = 'app_runtime'
                    and has_function_privilege(r.oid,
                          'platform_auth.discharge_commission_assessment(uuid, uuid, text, uuid, text, '
                          || 'uuid, text, text, text)', 'EXECUTE')) then
    raise exception '142: the door that says a cut has been carried is not executable by the app role';
  end if;

  select coalesce(count(*)::int, 0) into v_seq_holders
    from pg_class cl cross join aclexplode(cl.relacl) a
   where cl.relkind = 'S'
     and cl.relname in ('pricing_commission_rate_number_seq','pricing_commission_assessment_number_seq')
     and a.grantee <> cl.relowner;
  if v_seq_holders <> 0 then
    raise exception '142: % grant(s) let a role besides the owner take a cut number without writing a '
      'cut', v_seq_holders;
  end if;

  -- The neighbours stay as they were sealed: 140's twenty-one price words, 141's two charge words, and the
  -- three pricing duties this card joins instead of extending.
  select count(*)::int into v_words from pricing_dimensions;
  if v_words <> 21 then
    raise exception '142: 140''s price vocabulary holds % words, not the 21 it was sealed with', v_words;
  end if;
  select count(*)::int into v_kinds from pricing_addendum_kinds;
  if v_kinds <> 2 then
    raise exception '142: 141''s charge register holds % words, not the 2 it was sealed with', v_kinds;
  end if;
  select count(*)::int into v_duties from permissions where key like 'control.pricing.%';
  if v_duties <> 3 then
    raise exception '142: the pricing duties are three and this migration adds none — it found %',
      v_duties;
  end if;

  select count(*)::int into v_live from pricing_commission_rates
   where status = 'published'
     and effective_from <= current_date
     and coalesce(effective_to, date 'infinity') >= current_date;
  select count(*)::int into v_open from pricing_commission_assessments where status = 'assessed';
  raise notice '142: the cut register is open — % rung(s) the ladder walks, % transaction(s) it cuts, % '
    'live agreement(s) today, % open reading(s) owed or kept. Nothing here writes a leg: a cut is carried '
    'by pointing at a payout or a posting whose figure the register read for itself',
    v_subjects, v_sources, v_live, v_open;
end $$;

commit;
