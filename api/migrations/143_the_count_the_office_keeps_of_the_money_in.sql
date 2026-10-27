-- 143: the count the office keeps of the money that came in, and the figure it hoped for
--
-- The control panel's revenue screen has always answered from live arithmetic: 066's `control_revenue`
-- walks `invoices`, 068's `control_revenue_mix` walks invoices into subscriptions into plans, and 088's
-- allocation walks the same invoices again by a different road. Every one of those answers is a
-- *re-derivation* — correct on the day it is asked, and gone the moment the rows underneath it change.
-- 133 to 142 gave the office a book. This migration stops the revenue screen re-deriving and makes it
-- read the book once and keep what it read.
--
-- Why a count is kept as a row and not recomputed on every page. The spec's word is "persisted nightly
-- snapshots", and the reason is not speed: an office that reports a month is answerable for the figure it
-- reported, not for whatever the same query says in March. 133's legs cannot be rewritten and 140's price
-- keeps the version a signature stood on; a count is the same kind of act — somebody said "this is what
-- came in on the 26th" — and a saying that cannot be produced again is a saying the office cannot stand
-- behind. So the snapshot row carries its own `revisions`, the reading it replaced in `previous`, and the
-- seat and the minute it was taken.
--
-- Why the ledger is the only thing it reads. A snapshot built from `invoices` would be the same live
-- arithmetic wearing a stored date, and the book would go on being the thing nobody counts. Every figure
-- here comes from `money_entries` on accounts whose `kind` is `income`, through `money_postings`, and
-- nothing else. That has a consequence the desk has to say out loud: the book holds only what a seat or a
-- door has posted into it. Where nothing has been posted, the honest answer is that the register has
-- nothing for that day — which is 133's own refusal, aimed at the count rather than at the chart. The
-- screens that derive from invoices stay exactly where they are; this register does not replace them, it
-- answers a different question ("what did the book say") from a different table.
--
-- Why a movement's own status is not a filter. 133 reverses a movement by posting a *mirror on today's
-- date* and stamping the original `reversed`. A count that read only `status = 'posted'` would therefore
-- show the 26th with its fee income erased (the original no longer passes the filter) and today carrying a
-- debit against income that undoes a movement nobody counted — one day stripped of money it genuinely
-- earned, the next made negative by a correction that belongs to the earlier day's business. Walking every
-- leg of every movement on the day, whatever the movement's status has since become, gives each day its
-- own truth: the original stays on the day it was earned and the mirror lands on the day the office signed
-- it, which is exactly what "the money came in on this day" means in a book that answers by day. The count
-- reports how many of a day's movements have since been undone, so the desk never mistakes a day for clean
-- because the paper under it changed.
--
-- Why one money per row. 138's defect was a USD count that had a TZS figure summed into it. A snapshot is
-- keyed `(tenant_id, snapshot_day, currency)` and cannot hold two monies, and the door that counts a week
-- takes one reading per money per day rather than one total for the week. A share, an attainment and a gap
-- are all arithmetic on one money; adding the two together is how the office reports a figure that is
-- neither of the two amounts it holds.
--
-- Why a cut that does not sum to its total is refused by the table. The screen offers the day split by
-- account, by the kind of movement, by the desk whose seat raised it and by the road the movement names.
-- Four arrays, and the temptation in every one of them is to drop the rows that are awkward — an account
-- nobody recognises, a movement whose `source_id` is empty. Each array therefore carries its own `total`
-- per bucket, the table CHECKs that each array sums to the same `income` the row reports, and whatever the
-- door cannot resolve is filed under a named bucket ("no road named", "no desk named") instead of
-- vanishing. A cut that quietly omits 20 percent of the day is the worst kind of report, because it looks
-- like a smaller number rather than like a lie, and a CHECK is the only thing on this screen that notices.
--
-- Why the desk and the road are usually *not* named, and why the columns exist anyway. The book carries
-- `source_kind`, `source_id` and `source_ref`; a movement raised by the money desk names a paper rather
-- than a trip, and `invoices` has no road on it at all. So today nearly every figure lands in the unnamed
-- bucket, and the desk says so in words. The join is real and not invented: a movement whose source is a
-- trip, a transport request or a consolidation is filed under that road, and one raised by a seat that
-- stands in a department is filed under that desk. When those registers start posting into the book the
-- cut is already there — which is the whole reason it is written now rather than after the first clerk
-- asks for a road's figures and is handed a single unexplained total.
--
-- Why an ambition is a separate register and a separate duty. A target is the office saying what it means
-- to earn; a count is the office recording what came in. One hand should not do both, for 135's exact
-- reason — a reconciliation a seat can order because it can move money is a report that cannot catch that
-- seat — so `control.revenue.count` and `control.revenue.target` are two keys, seeded onto two different
-- role sets, and section 10 refuses to finish unless the sets really differ. A target is not a signature:
-- nothing moves when an ambition is written down, so 121's register is not involved, and a target that is
-- withdrawn keeps its row because its withdrawal is a decision somebody made.
--
-- What is deliberately not here. No scheduler: this schema has no `pg_cron` and 085's collector is the
-- nearest thing to one, so the nightly act is a door (`count_revenue_days`) that the API's own loop calls
-- for yesterday and the desk can call for any window, and every day it has already counted answers
-- `unchanged` rather than double-counting. No currency conversion: TZS and USD are never added and never
-- exchanged, and a USD month is shown beside a TZS month, not inside it. And no restatement of a counted
-- day by a later reversal: the mirror lands on its own day, which is the paragraph above, and a desk that
-- wants the corrected figure re-takes the day the mirror stands in.
begin;

-- ============================================================
-- 1. the one body a cut is summed by, and the words a movement kind is printed in
-- ============================================================

-- Written before the table because the table's CHECK calls it. It is deliberately not a view, not a
-- trigger and not a second query: it is the arithmetic behind the invariant, and an invariant that lives
-- only in a door is one the next door forgets. Immutable because it reads nothing but its own argument,
-- which is the only kind of function a CHECK may hold.
create or replace function platform_auth.revenue_cut_sum(p_cuts jsonb) returns numeric
language plpgsql immutable set search_path = public as $$
declare
  v numeric := 0;
  v_row jsonb;
begin
  if jsonb_typeof(p_cuts) <> 'array' then
    return 0;
  end if;
  for v_row in select jsonb_array_elements(p_cuts) loop
    -- A bucket whose figure is not a number adds nothing rather than aborting the statement: the
    -- table's own shape checks say a cut is an array of objects, and a malformed figure is refused by
    -- the sum check it does not produce, not by an exception escaping a constraint.
    begin
      v := v + (v_row ->> 'total')::numeric;
    exception when others then
      null;
    end;
  end loop;
  return v::numeric(14,2);
end $$;

-- The display words for 133's closed list of movement kinds. Not an array of columns and not a route's
-- switch: one body, so the register's own list and the desk's own list cannot drift apart, which is the
-- rule 142's section-15 census enforces for the commission sources.
create or replace function platform_auth.revenue_source_said(p_kind text) returns text
language sql immutable set search_path = public as $$
  select case p_kind
    when 'opening'   then 'An opening balance'
    when 'manual'    then 'Typed at the desk'
    when 'adjustment'then 'An adjustment'
    when 'reversal'  then 'A reversal'
    when 'invoice'   then 'An invoice'
    when 'payment'   then 'A payment'
    when 'refund'    then 'A refund'
    when 'payout'    then 'A payout'
    when 'fee'       then 'A fee'
    when 'escrow'    then 'An escrow movement'
    when 'cost'      then 'A cost'
    when 'payroll'   then 'Payroll'
    when 'tax'       then 'A tax figure'
    else coalesce(nullif(trim(p_kind), ''), 'unknown') || ' (a word the register does not know)'
  end
$$;

-- ============================================================
-- 2. the periods a target and a count can be measured over
-- ============================================================

-- Three words, and the day each one starts on. Derived rather than typed: a clerk who enters the 17th and
-- means "that week" gets the Monday the week actually starts on, and the answer says so. A target keyed on
-- an arbitrary day inside a month would be a month with three targets in it.
create or replace function platform_auth.revenue_period_start(p_kind text, p_day date) returns date
language sql immutable set search_path = public as $$
  select case p_kind
    when 'day'   then p_day
    when 'week'  then date_trunc('week', p_day)::date
    when 'month' then date_trunc('month', p_day)::date
  end
$$;

-- Where a period ends, exclusive. One body, because the window fold, the target reads and the keep-guard on
-- a target all need the same end day, and a `+ 7` typed in one place against an `interval '1 month'` in
-- another is how a week stops being seven days. The end is the first day of the next period, not the last
-- day of this one, so a day can never fall inside two folds.
create or replace function platform_auth.revenue_period_end(p_kind text, p_start date) returns date
language sql immutable set search_path = public as $$
  select case p_kind
    when 'day'   then p_start + 1
    when 'week'  then p_start + 7
    when 'month' then (p_start + interval '1 month')::date
    else p_start + 1
  end
$$;

-- The sentence the desk prints beside a figure. `D` in a format string is the day of the WEEK, not the day
-- of the month — a label built with it called the 27th "tuesday 3 Oct", which is a wrong date in a place
-- the arithmetic cannot argue with. `DD` is the day of the month, and FM is what stops the padded weekday
-- and month names from trailing spaces into the middle of the sentence.
create or replace function platform_auth.revenue_period_label(p_kind text, p_start date) returns text
language sql immutable set search_path = public as $$
  select case p_kind
    when 'day'   then to_char(p_start, 'FMDay FMDD FMMonth YYYY')
    when 'week'  then 'week from ' || to_char(p_start, 'FMDD') || ' ' || to_char(p_start, 'FMMonth')
                     || ' to ' || to_char(p_start + 6, 'FMDD') || ' ' || to_char(p_start + 6, 'FMMonth YYYY')
    when 'month' then to_char(p_start, 'FMMonth YYYY')
    else p_start::text
  end
$$;

-- Which granularities a window may be folded at. The set is data rather than three `if`s in a body
-- because the desk's segmented control, the window fold and the target match all read it, and a fourth
-- word added here is a fourth option on the screen without a second file being edited.
create table if not exists revenue_periods (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key in ('day','week','month')),
  label text not null check (char_length(trim(label)) between 3 and 40),
  -- How the fold is done, spelled once: `date_trunc` for a week or a month, nothing for a day. The
  -- window body reads this instead of carrying its own case, so a period the register lists is a period
  -- the register can actually fold.
  trunc text not null check (trunc in ('none','week','month')),
  sort int not null check (sort between 1 and 9),
  note text check (note is null or char_length(trim(note)) between 8 and 600),
  constraint revenue_periods_one_word unique (key),
  constraint revenue_periods_one_order unique (sort)
);

alter table revenue_periods enable row level security;
create policy revenue_periods_readable on revenue_periods for select to app_runtime using (true);
grant select on revenue_periods to app_runtime;
revoke all on revenue_periods from public, anon, authenticated, service_role;

insert into revenue_periods (key, label, trunc, sort, note) values
  ('day',   'A day',   'none',  1, 'One snapshot per money. What the book moved between two midnights.'),
  ('week',  'A week',  'week',  2, 'Four or five readings summed. The week starts on Monday, because that '
                                 || 'is the day the office opens.'),
  ('month', 'A month', 'month', 3, 'The period a target is usually promised on and a report is usually '
                                 || 'asked for.')
on conflict (key) do nothing;

-- ============================================================
-- 3. the count: one day, one money, one reading
-- ============================================================

create sequence if not exists revenue_snapshot_number_seq;

create table if not exists revenue_snapshots (
  id uuid primary key default gen_random_uuid(),
  -- Whose book was counted. 133's rule unchanged: the column names the owner of the book, and the office's
  -- own count is filed under the platform tenant. A company's count is a later row set in the same table,
  -- not a later column — the legs it will read are already keyed this way.
  tenant_id uuid not null references tenants(id),
  ref text not null unique check (ref ~ '^RSV-[0-9]{4}-[0-9]{5,}$'),
  -- The day counted, which is the day the movements carry — not the day the reading was taken. A movement
  -- posted late for the 3rd belongs to the 3rd's count.
  snapshot_day date not null,
  currency text not null check (currency in ('TZS','USD')),
  -- The answer. Credits to income accounts minus debits to income accounts, which is what "income" means
  -- in a double-entry book and what makes a contra day printable as a negative figure instead of being
  -- filed as zero.
  income numeric(14,2) not null default 0,
  credit_total numeric(14,2) not null default 0 check (credit_total >= 0),
  debit_total numeric(14,2) not null default 0 check (debit_total >= 0),
  -- The population the reading stood on. `postings` counts only movements that carried an income leg: a
  -- day with twelve cost movements and no income is a day with nothing to count, and reporting twelve
  -- would read as twelve earnings.
  postings int not null default 0 check (postings >= 0),
  entries int not null default 0 check (entries >= 0),
  -- Of those movements, how many have since been reversed. A count that hides this is a count that lets a
  -- clerk call a day clean on the strength of paper that has changed under it.
  reversed_postings int not null default 0 check (reversed_postings >= 0
                                                  and reversed_postings <= postings),
  -- The four cuts. Each an array of objects carrying `total`, each summing to `income` — the checks below
  -- say so and the table refuses anything that does not. Buckets the door cannot resolve are named, never
  -- dropped.
  by_account jsonb not null default '[]'::jsonb,
  by_source jsonb not null default '[]'::jsonb,
  by_desk jsonb not null default '[]'::jsonb,
  by_route jsonb not null default '[]'::jsonb,
  -- A reading is re-taken, not corrected. `revisions` counts how many times the office has counted this
  -- day and `previous` holds the figures the last re-take replaced, so a month that moved is a month that
  -- can say what it used to be.
  revisions int not null default 1 check (revisions >= 1),
  previous jsonb check (previous is null or jsonb_typeof(previous) = 'object'),
  first_taken_at timestamptz not null default now(),
  taken_by uuid not null references users(id),
  taken_at timestamptz not null default now(),
  note text check (note is null or char_length(trim(note)) between 8 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint revenue_snapshot_one_reading_per_day
    unique (tenant_id, snapshot_day, currency),
  -- The figure is the two piles, always. If they could disagree the screen would print whichever it
  -- liked.
  constraint revenue_snapshot_is_a_difference check (income = credit_total - debit_total),
  -- A cut cannot leave money out.
  constraint revenue_snapshot_accounts_add_up check (platform_auth.revenue_cut_sum(by_account) = income),
  constraint revenue_snapshot_sources_add_up  check (platform_auth.revenue_cut_sum(by_source)  = income),
  constraint revenue_snapshot_desks_add_up    check (platform_auth.revenue_cut_sum(by_desk)    = income),
  constraint revenue_snapshot_roads_add_up    check (platform_auth.revenue_cut_sum(by_route)   = income),
  constraint revenue_snapshot_cuts_are_arrays check (
    jsonb_typeof(by_account) = 'array' and jsonb_typeof(by_source) = 'array'
    and jsonb_typeof(by_desk) = 'array' and jsonb_typeof(by_route) = 'array'),
  -- An empty reading is genuinely empty in every direction. The row exists to say "the office counted this
  -- day and the book had nothing", and a row that says zero income over four arrays of figures is a row
  -- that means something else entirely.
  constraint revenue_snapshot_empty_is_empty check (
    postings > 0 or (income = 0 and credit_total = 0 and debit_total = 0 and entries = 0
                     and by_account = '[]'::jsonb and by_source = '[]'::jsonb
                     and by_desk = '[]'::jsonb and by_route = '[]'::jsonb)),
  -- A day that was counted twice says what the first counting said.
  constraint revenue_snapshot_remembers check (revisions = 1 or previous is not null),
  -- The first taking is a fact about the row, not a field the next re-take is allowed to lose.
  constraint revenue_snapshot_keeps_its_first_moment check (first_taken_at <= taken_at)
);

-- The screen's hottest read is the register, newest day first, for one book and one money.
create index if not exists revenue_snapshots_book_day_idx
  on revenue_snapshots (tenant_id, currency, snapshot_day desc, taken_at desc);

alter table revenue_snapshots enable row level security;
create policy revenue_snapshots_tenant on revenue_snapshots for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on revenue_snapshots to app_runtime;
revoke all on revenue_snapshots from public, anon, authenticated, service_role;

-- ============================================================
-- 4. the ambition: one figure per book, per money, per period
-- ============================================================

create sequence if not exists revenue_target_number_seq;

create table if not exists revenue_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ref text not null unique check (ref ~ '^RTG-[0-9]{4}-[0-9]{5,}$'),
  -- One money, same as the count. A TZS ambition measured against a figure that has USD summed into it is
  -- 138's defect wearing a percentage sign.
  currency text not null check (currency in ('TZS','USD')),
  period_kind text not null check (period_kind in ('day','week','month')),
  -- The period's own first day. The door derives it from whatever day the clerk named and the CHECK below
  -- makes the row agree with the word, so a "monthly" target dated the 17th cannot exist.
  period_start date not null,
  amount numeric(14,2) not null check (amount > 0 and amount <= 10000000000),
  note text check (note is null or char_length(trim(note)) between 8 and 600),
  -- live: what the office is currently measured against. withdrawn: the ambition stopped, and the row and
  -- its reason stay. There is no draft — a target nobody has committed to is a number in a notebook.
  status text not null default 'live' check (status in ('live','withdrawn')),
  withdrawn_by uuid references users(id),
  withdrawn_at timestamptz,
  withdrawn_reason text check (withdrawn_reason is null
                               or char_length(trim(withdrawn_reason)) between 8 and 600),
  raised_by uuid not null references users(id),
  raised_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint revenue_target_period_is_aligned check (
    (period_kind = 'day')
    or (period_kind = 'week'  and extract(isodow from period_start) = 1)
    or (period_kind = 'month' and period_start = date_trunc('month', period_start)::date)),
  constraint revenue_target_stop_is_explained check (
    (status = 'live' and withdrawn_by is null and withdrawn_at is null and withdrawn_reason is null)
    or (status = 'withdrawn' and withdrawn_by is not null and withdrawn_at is not null
        and char_length(trim(coalesce(withdrawn_reason, ''))) >= 8))
);

-- One ambition per book per money per period. Partial, the way 133 made an idempotency key unique only
-- while it was set: a withdrawn target must not block the office from stating a new one for the same
-- month, and must not be overwritten either — its row is the record of what was promised first.
-- An index rather than a table constraint, because a unique constraint cannot be partial: the two arms
-- of that rule (one live promise per period, and a stopped promise that stays out of the way) can only
-- be enforced together by an index that carries the predicate.
create unique index if not exists revenue_target_one_per_period_idx
  on revenue_targets (tenant_id, currency, period_kind, period_start)
  where status = 'live';

create index if not exists revenue_targets_book_period_idx
  on revenue_targets (tenant_id, currency, period_start desc, period_kind);

alter table revenue_targets enable row level security;
create policy revenue_targets_tenant on revenue_targets for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on revenue_targets to app_runtime;
revoke all on revenue_targets from public, anon, authenticated, service_role;

-- ============================================================
-- 5. the guards
-- ============================================================

-- The day and the money are the row's identity, and the moment of the first counting is a fact about it
-- rather than a field the next re-take is allowed to lose. As in 142, a re-take is an UPDATE that raises
-- `revisions` by exactly one and carries what it replaced: a jump of two would mean a reading that left no
-- trace, and a re-take that kept the old `revisions` would tell the desk the day was counted once when it
-- was counted twice.
create or replace function platform_auth.revenue_snapshot_header_is_immutable() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.id                 is distinct from OLD.id
     or NEW.tenant_id       is distinct from OLD.tenant_id
     or NEW.ref             is distinct from OLD.ref
     or NEW.snapshot_day    is distinct from OLD.snapshot_day
     or NEW.currency        is distinct from OLD.currency
     or NEW.first_taken_at  is distinct from OLD.first_taken_at then
    raise exception '143: % counts the % of % — a reading''s day and money are its identity, and one of '
      'them moved', OLD.ref, OLD.currency, OLD.snapshot_day
      using errcode = '23514';
  end if;
  if NEW.revisions < OLD.revisions or NEW.revisions > OLD.revisions + 1 then
    raise exception '143: % cannot go from its reading % to reading %: a day is re-taken one count at a '
      'time, and the reading it replaces is carried in previous', OLD.ref, OLD.revisions, NEW.revisions
      using errcode = '23514';
  end if;
  if NEW.revisions > OLD.revisions and NEW.previous is null then
    raise exception '143: % is being re-taken without the figures the last count produced', OLD.ref
      using errcode = '23514';
  end if;
  return NEW;
end $$;

create trigger revenue_snapshot_headers_are_immutable
  before update on revenue_snapshots
  for each row execute function platform_auth.revenue_snapshot_header_is_immutable();

-- A count of a day that had money is kept. The row is the office's own statement about its book on a day
-- the book moved, and 140's rule for a price a seat was asked to sign applies with more force here: the
-- statement has already been read out. A reading of a day that turned out to hold nothing is thrown away
-- through `discard_revenue_day` — that is the one case where the row asserted nothing, and a mis-clicked
-- desk or a fixture run must not accumulate permanent zeros the register cannot answer with.
create or replace function platform_auth.revenue_snapshot_is_kept() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if OLD.postings > 0 then
    raise exception '143: % counted % movement(s) on % in % and is kept: a day the book moved is answered '
      'by re-taking the count, never by erasing it', OLD.ref, OLD.postings, OLD.snapshot_day, OLD.currency
      using errcode = '23514';
  end if;
  return OLD;
end $$;

create trigger revenue_snapshots_are_kept
  before delete on revenue_snapshots
  for each row execute function platform_auth.revenue_snapshot_is_kept();

-- A target's period, its money and its figure are what it promised; the only change a live target can
-- undergo is to stop. Reviving a withdrawn one would make the register's history a re-write, and the
-- partial unique index already lets the office state a fresh ambition for the same period.
create or replace function platform_auth.revenue_target_header_is_immutable() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.id          is distinct from OLD.id
     or NEW.tenant_id    is distinct from OLD.tenant_id
     or NEW.ref          is distinct from OLD.ref
     or NEW.currency     is distinct from OLD.currency
     or NEW.period_kind  is distinct from OLD.period_kind
     or NEW.period_start is distinct from OLD.period_start then
    raise exception '143: % is a % figure of % for % — an ambition''s period and money are its identity, '
      'and one of them moved. Set a new target instead',
      OLD.ref, OLD.period_kind, OLD.amount, OLD.period_start
      using errcode = '23514';
  end if;
  if NEW.amount <> OLD.amount then
    raise exception '143: % promised % and cannot be re-typed: withdraw it and set the new figure as its '
      'own target', OLD.ref, OLD.amount using errcode = '23514';
  end if;
  if OLD.status = 'withdrawn' and NEW.status = 'live' then
    raise exception '143: % was withdrawn and does not come back: a revived ambition would overwrite the '
      'reason it stopped', OLD.ref using errcode = '23514';
  end if;
  return NEW;
end $$;

create trigger revenue_target_headers_are_immutable
  before update on revenue_targets
  for each row execute function platform_auth.revenue_target_header_is_immutable();

-- What the office has been measured against is kept. A target that a count has fallen inside is the figure
-- an attainment was calculated from, and a target whose stopping was recorded is a decision the register
-- has to be able to show. Only an ambition nobody ever counted against — a slip of the keyboard for next
-- March — can be thrown away.
create or replace function platform_auth.revenue_target_is_kept() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_end date;
begin
  -- The same helper the window fold and the target reads use. A second copy of `+ 7` and `+ 1 month` here
  -- would let the guard keep a target over a period the register does not count as its own.
  v_end := platform_auth.revenue_period_end(OLD.period_kind, OLD.period_start);
  if OLD.withdrawn_at is not null then
    raise exception '143: % was withdrawn on %, so its row and its reason are kept',
      OLD.ref, OLD.withdrawn_at::date
      using errcode = '23514';
  end if;
  if exists (select 1 from revenue_snapshots s
              where s.tenant_id = OLD.tenant_id and s.currency = OLD.currency
                and s.snapshot_day >= OLD.period_start and s.snapshot_day < v_end) then
    raise exception '143: % has already been counted against — a day inside % has been read — so the figure '
      'stays. Withdraw it if the ambition has stopped', OLD.ref, OLD.period_start
      using errcode = '23514';
  end if;
  return OLD;
end $$;

create trigger revenue_targets_are_kept
  before delete on revenue_targets
  for each row execute function platform_auth.revenue_target_is_kept();

-- ============================================================
-- 6. the two joins a cut needs, and the words they answer with
-- ============================================================

-- Which road a movement names. A book movement carries `source_kind`, `source_id` and a reference printed
-- as text; the only registers it can point at that have a road on them are a trip, a transport request and
-- a consolidation. Anything else — an invoice, which has no road at all, a payout, a hand-typed correction
-- — answers NULL, and the reading files that money under a named bucket rather than dropping it. The
-- book's tenant is bound in every arm: this schema's role bypasses row-level security, so a resolver that
-- looked an id up without its owner would let one office read another's road names.
create or replace function platform_auth.revenue_route_named(
  p_tenant uuid, p_source_id uuid
) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select r.name from trips t join routes r on r.id = t.route_id
      where t.id = p_source_id and t.tenant_id = p_tenant),
    (select r.name from transport_requests q join routes r on r.id = q.route_id
      where q.id = p_source_id and q.tenant_id = p_tenant),
    (select r.name from consolidations k join routes r on r.id = k.route_id
      where k.id = p_source_id and k.tenant_id = p_tenant)
  )
$$;

-- Which desk raised a movement: the department the seat stood in on the day counted, not the one it sits in
-- today. Midday is the instant asked about, because a membership that opened that morning or was released
-- that afternoon still held the day. A head outranks a member when a seat stands in two teams and the
-- earliest membership breaks the tie, so re-taking a day gives the same answer it gave the first time.
create or replace function platform_auth.revenue_desk_named(
  p_tenant uuid, p_seat uuid, p_day date
) returns text
language sql stable security definer set search_path = public as $$
  select d.name
    from platform_seat_departments s
    join platform_departments d on d.id = s.department_id
   where s.tenant_id = p_tenant and s.user_id = p_seat
     and s.starts_at <= p_day + time '12:00:00'
     and (s.ends_at is null or s.ends_at > p_day + time '00:00:00')
     and (s.released_at is null or s.released_at > p_day + time '00:00:00')
   order by (s.standing = 'head') desc, s.starts_at asc
   limit 1
$$;

-- ============================================================
-- 7. the reading: the arithmetic, written once
-- ============================================================

-- Every figure a snapshot can hold is produced here, and the doors call it instead of carrying their own
-- copy — the rule 142 states for `commission_figure`. `legs` is the whole population and the whole filter:
-- income accounts, this book, this day, this money, whatever the movement's own status has since become.
-- No `posted` filter appears anywhere, for the reason in the header: the mirror of a reversal is its own
-- movement on its own day, and filtering on status would strip the day that earned the money and charge
-- today with a correction that belongs to the earlier business.
--
-- The four cuts are built from the same two CTEs, so they cannot disagree with the figure they are
-- supposed to explain: each bucket is a partial sum of the same rows, and the sums are exact because every
-- ledger amount is already stored to the penny.
create or replace function platform_auth.revenue_read_day(
  p_tenant uuid, p_day date, p_money text
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  with legs as (
    select l.posting_id, l.source_kind, l.source_id, l.raised_by, l.status,
           l.code, l.label, l.direction, l.amount
      from platform_auth.revenue_income_legs(p_tenant) l
     where l.posted_on = p_day and l.currency = p_money
  ), per_posting as (
    select posting_id, source_kind, source_id, raised_by, status,
           sum(case when direction = 'credit' then amount else -amount end) as contrib
      from legs group by 1,2,3,4,5
  )
  select jsonb_build_object(
      'currency', p_money,
      'day', p_day::text,
      'credit_total', coalesce((select sum(amount) from legs where direction = 'credit'), 0)::numeric(14,2),
      'debit_total',  coalesce((select sum(amount) from legs where direction = 'debit'),  0)::numeric(14,2),
      'income',       coalesce((select sum(contrib) from per_posting), 0)::numeric(14,2),
      'entries',  coalesce((select count(*) from legs), 0)::int,
      'postings', coalesce((select count(*) from per_posting), 0)::int,
      'reversed_postings',
        coalesce((select count(*) from per_posting where status = 'reversed'), 0)::int,
      'by_account', coalesce((
        select jsonb_agg(x order by (x ->> 'total')::numeric desc, x ->> 'key')
          from (
            select jsonb_build_object(
                     'key', code, 'label', label,
                     'credit', sum(case when direction = 'credit' then amount else 0 end)::numeric(14,2),
                     'debit',  sum(case when direction = 'debit'  then amount else 0 end)::numeric(14,2),
                     'total',  sum(case when direction = 'credit' then amount
                                        else -amount end)::numeric(14,2)) as x
              from legs group by code, label) q), '[]'::jsonb),
      'by_source', coalesce((
        select jsonb_agg(x order by (x ->> 'total')::numeric desc, x ->> 'key')
          from (
            select jsonb_build_object(
                     'key', source_kind,
                     'label', platform_auth.revenue_source_said(source_kind),
                     'postings', count(*)::int,
                     'total', sum(contrib)::numeric(14,2)) as x
              from per_posting group by source_kind) q), '[]'::jsonb),
      'by_desk', coalesce((
        select jsonb_agg(x order by (x ->> 'total')::numeric desc, x ->> 'key')
          from (
            select jsonb_build_object(
                     'key',   coalesce(desk, 'no desk named'),
                     'label', coalesce(desk, 'No desk named'),
                     'postings', count(*)::int,
                     'total', sum(contrib)::numeric(14,2)) as x
              from (select pp.contrib,
                           platform_auth.revenue_desk_named(p_tenant, pp.raised_by, p_day) as desk
                      from per_posting pp) d
             group by desk) q), '[]'::jsonb),
      'by_route', coalesce((
        select jsonb_agg(x order by (x ->> 'total')::numeric desc, x ->> 'key')
          from (
            select jsonb_build_object(
                     'key',   coalesce(road, 'no road named'),
                     'label', coalesce(road, 'No road named'),
                     'postings', count(*)::int,
                     'total', sum(contrib)::numeric(14,2)) as x
              from (select pp.contrib,
                           platform_auth.revenue_route_named(p_tenant, pp.source_id) as road
                      from per_posting pp) r
             group by road) q), '[]'::jsonb)
    ) into v_out
    from (select 1) one;

  return v_out;
end $$;

-- ============================================================
-- 8. the population, written once
-- ============================================================

-- What an income leg is: the single definition every figure in this register is built from. It is a
-- function rather than a repeated CTE on purpose — the reading of a day, the list of days that still want
-- counting and the window that folds both must agree about which legs exist, and a filter typed twice is a
-- filter that drifts. 142 states the same rule for `commission_figure`; a state list that called a day
-- "uncounted" while the reader called the same day empty would be the register arguing with itself on one
-- screen.
--
-- `posted_on` and `currency` come out rather than being filtered here because the callers differ: one wants
-- a day, one wants a window, one wants the last 120 days. The tenant is bound in the only place it can be
-- bound — this body — because the role that runs it bypasses row-level security.
create or replace function platform_auth.revenue_income_legs(p_tenant uuid)
returns table (posted_on date, currency text, posting_id uuid, source_kind text, source_id uuid,
              raised_by uuid, status text, code text, label text, direction text, amount numeric)
language sql stable security definer set search_path = public as $$
  select p.posted_on, p.currency, p.id, p.source_kind, p.source_id, p.raised_by, p.status,
         a.code, a.label, e.direction, e.amount
    from money_entries e
    join money_accounts a on a.id = e.account_id and a.tenant_id = e.tenant_id
    join money_postings p on p.id = e.posting_id
   where e.tenant_id = p_tenant and a.kind = 'income'
$$;

-- 133 indexes `money_postings` by the day it was *raised*, which is the column the ledger register is cut
-- by. This register is cut by the day the money is said to have moved, and every read here asks that
-- question — a folded month, a sweep of ninety days, the state list. 133 dropped its own day index when it
-- found the ledger did not use it; this one is created because the reads in sections 9 to 11 do.
create index if not exists money_postings_counted_day_idx
  on money_postings (tenant_id, posted_on, currency);

-- The seat that counted a day, printed. 121's own rule for naming a platform seat: the name it carries, or
-- the local part of the address it signed up with. A register that showed a bare uuid would be asking the
-- office to remember which seat was which.
create or replace function platform_auth.revenue_seat_said(p_seat uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(u.full_name), ''), split_part(u.email, '@', 1))
    from users u where u.id = p_seat
$$;

-- ============================================================
-- 9. the reads
-- ============================================================

-- One reading, whole: the figures, the four cuts, the revision it replaced and the ambitions that day sat
-- inside. A withdrawn target is listed too, because "the month promised 8M and this day delivered 300k" is
-- a sentence about the ambition the office held then, not the one it holds now.
create or replace function platform_auth.revenue_snapshot_detail(
  p_tenant uuid, p_snapshot uuid
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v revenue_snapshots;
begin
  select * into v from revenue_snapshots where id = p_snapshot and tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no count of the book with that number in this book.');
  end if;

  return jsonb_build_object(
    'ok', true, 'id', v.id, 'ref', v.ref,
    'day', v.snapshot_day::text, 'currency', v.currency,
    'income', v.income, 'credit_total', v.credit_total, 'debit_total', v.debit_total,
    'postings', v.postings, 'entries', v.entries, 'reversed_postings', v.reversed_postings,
    'by_account', v.by_account, 'by_source', v.by_source, 'by_desk', v.by_desk, 'by_route', v.by_route,
    'revisions', v.revisions, 'previous', v.previous,
    'retaken', v.revisions > 1,
    'first_taken_at', to_char(v.first_taken_at, 'YYYY-MM-DD HH24:MI'),
    'taken_at', to_char(v.taken_at, 'YYYY-MM-DD HH24:MI'),
    'taken_by', v.taken_by, 'taken_by_name', platform_auth.revenue_seat_said(v.taken_by),
    'note', v.note,
    'week_start', platform_auth.revenue_period_start('week', v.snapshot_day)::text,
    'month_start', platform_auth.revenue_period_start('month', v.snapshot_day)::text,
    'targets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ref', t.ref, 'kind', t.period_kind, 'start', t.period_start::text,
               'label', platform_auth.revenue_period_label(t.period_kind, t.period_start),
               'amount', t.amount, 'currency', t.currency, 'status', t.status,
               'withdrawn_reason', t.withdrawn_reason) order by t.period_start)
        from revenue_targets t
       where t.tenant_id = v.tenant_id and t.currency = v.currency
         and v.snapshot_day >= t.period_start
         and v.snapshot_day < platform_auth.revenue_period_end(t.period_kind, t.period_start)),
      '[]'::jsonb));
end $$;

-- The register itself, newest day first. The count and the total travel with the page over the whole
-- filtered window rather than over the rows on it: a clerk shown twelve readings and a figure that came
-- from a different twelve will add the column by hand and get the wrong answer.
create or replace function platform_auth.revenue_snapshot_list(
  p_tenant uuid, p_currency text, p_from date, p_to date, p_limit int, p_offset int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_money text;
  v_limit int;
  v_offset int;
  v_rows jsonb;
  v_all int;
  v_sum numeric;
begin
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no count to read in a book that is not here.');
  end if;
  v_money := upper(trim(coalesce(p_currency, 'TZS')));
  if v_money not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'name_the_money', 'asked', p_currency,
      'message', 'The register counts one money at a time: TZS or USD. A list that summed both would be '
        || '138''s defect back again.');
  end if;
  if p_from is not null and p_to is not null and p_to < p_from then
    return jsonb_build_object('ok', false, 'error', 'bad_window',
      'message', 'The last day cannot come before the first day.');
  end if;
  v_limit := least(greatest(coalesce(p_limit, 40), 1), 200);
  v_offset := greatest(coalesce(p_offset, 0), 0);

  select count(*)::int, coalesce(sum(s.income), 0)::numeric(14,2)
    into v_all, v_sum
    from revenue_snapshots s
   where s.tenant_id = p_tenant and s.currency = v_money
     and (p_from is null or s.snapshot_day >= p_from)
     and (p_to is null or s.snapshot_day <= p_to);

  select coalesce(jsonb_agg(g.j order by g.day desc, g.taken_at desc), '[]'::jsonb)
    into v_rows
    from (
      select s.snapshot_day as day, s.taken_at,
             jsonb_build_object(
               'id', s.id, 'ref', s.ref, 'day', s.snapshot_day::text, 'currency', s.currency,
               'income', s.income, 'credit_total', s.credit_total, 'debit_total', s.debit_total,
               'postings', s.postings, 'entries', s.entries,
               'reversed_postings', s.reversed_postings, 'revisions', s.revisions,
               'retaken', s.revisions > 1,
               'taken_at', to_char(s.taken_at, 'YYYY-MM-DD HH24:MI'),
               'taken_by_name', platform_auth.revenue_seat_said(s.taken_by),
               'note', s.note,
               'accounts', jsonb_array_length(s.by_account),
               'sources', jsonb_array_length(s.by_source),
               'desks', jsonb_array_length(s.by_desk),
               'roads', jsonb_array_length(s.by_route)) as j
        from revenue_snapshots s
       where s.tenant_id = p_tenant and s.currency = v_money
         and (p_from is null or s.snapshot_day >= p_from)
         and (p_to is null or s.snapshot_day <= p_to)
       order by s.snapshot_day desc, s.taken_at desc
       limit v_limit offset v_offset
    ) g;

  return jsonb_build_object('ok', true, 'currency', v_money,
    'from_day', p_from::text, 'to_day', p_to::text,
    'counted_days', coalesce(v_all, 0), 'window_income', coalesce(v_sum, 0),
    'rows', coalesce(v_rows, '[]'::jsonb), 'limit', v_limit, 'offset', v_offset);
end $$;

-- How current the register is, per money, and which days it still has not read. This is the read that
-- decides whether a month's figure is a month: an office that reports March from a register that stopped on
-- the 21st is reporting part of March as all of it. A day is a gap only when the book actually moved income
-- on it — a day with nothing to read is not missing, it is empty.
create or replace function platform_auth.revenue_count_state(
  p_tenant uuid, p_days int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_days int;
  v_from date;
  v_rows jsonb;
begin
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no book to report a count for.');
  end if;
  v_days := least(greatest(coalesce(p_days, 120), 1), 730);
  v_from := current_date - (v_days - 1);

  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', c.currency,
           'snapshots', coalesce(x.snapshots, 0),
           'first_day', x.first_day, 'last_day', x.last_day,
           'revisions', coalesce(x.revisions, 0),
           'income_in_window', coalesce(x.in_window, 0),
           'yesterday_counted', coalesce(x.yes, false),
           'today_counted', coalesce(x.tod, false),
           'uncounted_count', coalesce(y.missing_count, 0),
           'uncounted_days', coalesce(y.missing, '[]'::jsonb),
           'next_day', y.next_day) order by c.currency), '[]'::jsonb)
    into v_rows
    from (values ('TZS'), ('USD')) as c(currency)
    left join lateral (
      select count(*)::int as snapshots,
             to_char(min(s.snapshot_day), 'YYYY-MM-DD') as first_day,
             to_char(max(s.snapshot_day), 'YYYY-MM-DD') as last_day,
             sum(s.revisions)::int as revisions,
             coalesce(sum(s.income) filter (where s.snapshot_day >= v_from), 0)::numeric(14,2)
               as in_window,
             bool_or(s.snapshot_day = current_date - 1) as yes,
             bool_or(s.snapshot_day = current_date) as tod
        from revenue_snapshots s
       where s.tenant_id = p_tenant and s.currency = c.currency
    ) x on true
    left join lateral (
      select count(*)::int as missing_count,
             coalesce(jsonb_agg(d.day order by d.day desc), '[]'::jsonb) as missing,
             min(d.day) as next_day
        from (
          select distinct to_char(l.posted_on, 'YYYY-MM-DD') as day
            from platform_auth.revenue_income_legs(p_tenant) l
           where l.currency = c.currency and l.posted_on >= v_from
             and not exists (select 1 from revenue_snapshots s
                              where s.tenant_id = p_tenant and s.currency = c.currency
                                and s.snapshot_day = l.posted_on)
        ) d
    ) y on true;

  return jsonb_build_object('ok', true, 'since', v_from::text, 'days', v_days,
    'today', current_date::text, 'currencies', v_rows,
    'message', 'A day the book moved income and the office never read is a gap in the register, not a day '
      || 'with nothing in it. Count it from the desk, or let the nightly sweep reach it.');
end $$;

-- Actual against ambition, folded at the granularity the clerk asked for. One money, always: the fold sums
-- readings, and a sum that crossed two monies is the defect 138 was written to stop.
--
-- A period with a target and no readings is still printed (the office promised and has not been counted),
-- and a period the book moved inside without a reading carries its `uncounted_days` — so "the month made
-- 4.1M" cannot be printed beside a month missing eleven days without the screen saying so.
create or replace function platform_auth.revenue_window(
  p_tenant uuid, p_kind text, p_from date, p_to date, p_currency text
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_kind text;
  v_money text;
  v_starts date[];
  v_rows jsonb;
  v_actual numeric;
  v_target numeric;
begin
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no window to fold in a book that is not here.');
  end if;
  v_kind := lower(trim(coalesce(p_kind, 'month')));
  if v_kind not in ('day','week','month') then
    return jsonb_build_object('ok', false, 'error', 'bad_period', 'asked', p_kind,
      'message', 'A window folds by day, week or month. The register lists the three words it knows.');
  end if;
  v_money := upper(trim(coalesce(p_currency, 'TZS')));
  if v_money not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'name_the_money', 'asked', p_currency,
      'message', 'Name one money. A fold that added TZS to USD answers neither of the two questions.');
  end if;
  if p_from is null then
    return jsonb_build_object('ok', false, 'error', 'no_window',
      'message', 'A window needs a first day: an open-ended fold would walk the book from its first '
        || 'movement and answer twenty seconds after the clerk stopped reading the screen.');
  end if;
  v_starts := array(
    select distinct platform_auth.revenue_period_start(v_kind, g.d::date)
      from generate_series(p_from::timestamp,
                           coalesce(p_to, current_date)::timestamp, interval '1 day') g(d));
  if v_starts is null or array_length(v_starts, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'bad_window',
      'message', 'The last day cannot come before the first day, and the first day cannot be in the '
        || 'future of the last one.');
  end if;
  if array_length(v_starts, 1) > 60 then
    return jsonb_build_object('ok', false, 'error', 'window_too_wide',
      'periods', array_length(v_starts, 1),
      'message', 'That window is ' || array_length(v_starts, 1) || ' periods wide and this fold prints at '
        || 'most 60. Narrow it, or read the register itself.');
  end if;

  select coalesce(jsonb_agg(w.j order by w.period_start desc), '[]'::jsonb),
         coalesce(sum(w.actual), 0)::numeric(14,2),
         coalesce(sum(w.target_amount), 0)::numeric(14,2)
    into v_rows, v_actual, v_target
    from (
      select ps.period_start,
             coalesce(a.actual, 0)::numeric(14,2) as actual,
             t.amount as target_amount,
             jsonb_build_object(
               'period_start', ps.period_start::text,
               'period_end', ps.period_end::text,
               'label', platform_auth.revenue_period_label(v_kind, ps.period_start),
               'currency', v_money,
               'actual', coalesce(a.actual, 0)::numeric(14,2),
               'snapshots', coalesce(a.snapshots, 0),
               'days_counted', coalesce(a.days_counted, 0),
               'reversed_postings', coalesce(a.reversed_postings, 0),
               'uncounted_count', coalesce(u.missing_count, 0),
               'uncounted_days', coalesce(u.missing, '[]'::jsonb),
               'complete', coalesce(u.missing_count, 0) = 0 and coalesce(a.days_counted, 0) > 0,
               'target', case when t.id is null then null::jsonb else jsonb_build_object(
                   'ref', t.ref, 'amount', t.amount, 'note', t.note,
                   'raised_by_name', platform_auth.revenue_seat_said(t.raised_by)) end,
               'gap', case when t.id is null then null::numeric
                     else (t.amount - coalesce(a.actual, 0))::numeric(14,2) end,
               'attainment', case when t.id is null or t.amount <= 0 then null::numeric
                     else round(coalesce(a.actual, 0) / t.amount * 100, 1) end) as j
        from (select s1 as period_start,
                     platform_auth.revenue_period_end(v_kind, s1) as period_end
                from unnest(v_starts) s1) ps
        left join lateral (
          select count(*)::int as snapshots, count(distinct s.snapshot_day)::int as days_counted,
                 coalesce(sum(s.income), 0)::numeric(14,2) as actual,
                 coalesce(sum(s.reversed_postings), 0)::int as reversed_postings
            from revenue_snapshots s
           where s.tenant_id = p_tenant and s.currency = v_money
             and s.snapshot_day >= ps.period_start and s.snapshot_day < ps.period_end
        ) a on true
        left join lateral (
          select count(*)::int as missing_count,
                 coalesce(jsonb_agg(m.day order by m.day desc), '[]'::jsonb) as missing
            from (
              select distinct to_char(l.posted_on, 'YYYY-MM-DD') as day, l.posted_on
                from platform_auth.revenue_income_legs(p_tenant) l
               where l.currency = v_money
                 and l.posted_on >= ps.period_start and l.posted_on < ps.period_end
            ) m
           where not exists (select 1 from revenue_snapshots s
                              where s.tenant_id = p_tenant and s.currency = v_money
                                and s.snapshot_day = m.posted_on)
        ) u on true
        left join revenue_targets t
               on t.tenant_id = p_tenant and t.currency = v_money
              and t.period_kind = v_kind and t.period_start = ps.period_start
              and t.status = 'live'
    ) w;

  return jsonb_build_object('ok', true, 'kind', v_kind, 'currency', v_money,
    'from_day', v_starts[1]::text,
    'to_day', v_starts[array_length(v_starts, 1)]::text,
    'periods', jsonb_array_length(coalesce(v_rows, '[]'::jsonb)),
    'actual', v_actual, 'target', v_target,
    'gap', (v_target - v_actual)::numeric(14,2),
    'attainment', case when v_target <= 0 then null::numeric
                  else round(v_actual / v_target * 100, 1) end,
    'rows', coalesce(v_rows, '[]'::jsonb));
end $$;

-- One cut, merged across a window. The buckets come out of the readings that already carry them, so the
-- screen never re-walks the book to answer a question the register has answered — and never produces a
-- total that disagrees with the day it was drawn from. `income` is the whole window's figure even when the
-- page prints only the top buckets, so a share is a share of what the desk also claims to have earned.
create or replace function platform_auth.revenue_cut(
  p_tenant uuid, p_cut text, p_from date, p_to date, p_currency text, p_limit int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_cut text;
  v_money text;
  v_limit int;
  v_rows jsonb;
  v_income numeric;
  v_buckets int;
begin
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no cut to read in a book that is not here.');
  end if;
  v_cut := lower(trim(coalesce(p_cut, 'account')));
  if v_cut not in ('account','source','desk','route') then
    return jsonb_build_object('ok', false, 'error', 'bad_cut', 'asked', p_cut,
      'message', 'The four cuts the register keeps are account, source, desk and route.');
  end if;
  v_money := upper(trim(coalesce(p_currency, 'TZS')));
  if v_money not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'name_the_money', 'asked', p_currency,
      'message', 'Name one money before cutting it.');
  end if;
  if p_from is not null and p_to is not null and p_to < p_from then
    return jsonb_build_object('ok', false, 'error', 'bad_window',
      'message', 'The last day cannot come before the first day.');
  end if;
  v_limit := least(greatest(coalesce(p_limit, 12), 1), 60);

  with b as (
    select x.value ->> 'key' as key,
           max(x.value ->> 'label') as label,
           sum((x.value ->> 'total')::numeric) as total,
           sum(coalesce((x.value ->> 'credit')::numeric, 0)) as credit,
           sum(coalesce((x.value ->> 'debit')::numeric, 0)) as debit,
           sum(coalesce((x.value ->> 'postings')::numeric, 0))::int as postings,
           count(*)::int as readings
      from revenue_snapshots s,
           jsonb_array_elements(case v_cut
             when 'account' then s.by_account when 'source' then s.by_source
             when 'desk'    then s.by_desk    else s.by_route end) x(value)
     where s.tenant_id = p_tenant and s.currency = v_money
       and (p_from is null or s.snapshot_day >= p_from)
       and (p_to is null or s.snapshot_day <= p_to)
     group by 1
  ), t as (
    select coalesce(sum(total), 0)::numeric(14,2) as income, count(*)::int as buckets from b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', g.key, 'label', g.label, 'total', g.total::numeric(14,2),
           'credit', g.credit::numeric(14,2), 'debit', g.debit::numeric(14,2),
           'postings', g.postings, 'readings', g.readings,
           'share', case when g.income = 0 then null::numeric
                         else round(g.total / g.income * 100, 1) end)
           order by g.total desc, g.key), '[]'::jsonb),
         coalesce(max(g.income), 0)::numeric(14,2), coalesce(max(g.buckets), 0)
    into v_rows, v_income, v_buckets
    from (select bb.*, tt.income, tt.buckets,
                 row_number() over (order by bb.total desc, bb.key) as rn
            from b bb cross join t tt) g
   where g.rn <= v_limit;

  return jsonb_build_object('ok', true, 'cut', v_cut, 'currency', v_money,
    'from_day', p_from::text, 'to_day', p_to::text,
    'income', v_income, 'buckets', v_buckets,
    'rows', coalesce(v_rows, '[]'::jsonb), 'limit', v_limit,
    'omitted', greatest(v_buckets - v_limit, 0),
    'note', case v_cut
      when 'route' then 'A movement whose paper names no road is filed under "no road named". An invoice '
        || 'carries no road at all, so most of the book lands there until the trip and request registers '
        || 'start posting into it.'
      when 'desk' then 'A movement raised by a seat that stood in no department on the day counted is '
        || 'filed under "no desk named".'
      else null::text end);
end $$;

-- One ambition, with what the register has already said against it. The row shape lives here so the list
-- and the two doors that write a target print the same figures a clerk measured by.
create or replace function platform_auth.revenue_target_detail(
  p_tenant uuid, p_target uuid
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v revenue_targets;
  v_end date;
  v_actual numeric;
  v_counted int;
begin
  select * into v from revenue_targets where id = p_target and tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no target in this book with that number.');
  end if;
  v_end := platform_auth.revenue_period_end(v.period_kind, v.period_start);
  select count(*)::int, coalesce(sum(s.income), 0)::numeric(14,2)
    into v_counted, v_actual
    from revenue_snapshots s
   where s.tenant_id = v.tenant_id and s.currency = v.currency
     and s.snapshot_day >= v.period_start and s.snapshot_day < v_end;

  return jsonb_build_object(
    'ok', true, 'id', v.id, 'ref', v.ref, 'currency', v.currency,
    'kind', v.period_kind, 'period_start', v.period_start::text, 'period_end', v_end::text,
    'label', platform_auth.revenue_period_label(v.period_kind, v.period_start),
    'amount', v.amount, 'note', v.note, 'status', v.status,
    'raised_by', v.raised_by, 'raised_by_name', platform_auth.revenue_seat_said(v.raised_by),
    'raised_at', to_char(v.raised_at, 'YYYY-MM-DD HH24:MI'),
    'withdrawn_by_name', case when v.withdrawn_by is null then null
      else platform_auth.revenue_seat_said(v.withdrawn_by) end,
    'withdrawn_at', case when v.withdrawn_at is null then null
      else to_char(v.withdrawn_at, 'YYYY-MM-DD HH24:MI') end,
    'withdrawn_reason', v.withdrawn_reason,
    'counted_days', coalesce(v_counted, 0), 'actual', coalesce(v_actual, 0),
    'gap', (v.amount - coalesce(v_actual, 0))::numeric(14,2),
    'attainment', case when v.amount <= 0 then null::numeric
                  else round(coalesce(v_actual, 0) / v.amount * 100, 1) end,
    'days_left', greatest((v_end - current_date)::int, 0),
    'in_the_past', v_end <= current_date);
end $$;

-- The ambitions, and what each has been measured against. Withdrawn ones are listed only when asked for,
-- because "we promised 8M and stopped promising it in March" is a fact the office has to be able to say.
create or replace function platform_auth.revenue_target_list(
  p_tenant uuid, p_currency text, p_kind text, p_from date, p_to date, p_include_withdrawn boolean
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_money text;
  v_rows jsonb;
begin
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no ambition to read in a book that is not here.');
  end if;
  v_money := upper(trim(coalesce(p_currency, 'TZS')));
  if v_money not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'name_the_money', 'asked', p_currency,
      'message', 'A target is one figure in one money. Name the money.');
  end if;
  if p_kind is not null and lower(trim(p_kind)) not in ('day','week','month') then
    return jsonb_build_object('ok', false, 'error', 'bad_period', 'asked', p_kind,
      'message', 'Targets are kept for a day, a week or a month.');
  end if;

  select coalesce(jsonb_agg(platform_auth.revenue_target_detail(p_tenant, t.id)
           order by t.period_start desc, t.period_kind), '[]'::jsonb)
    into v_rows
    from revenue_targets t
   where t.tenant_id = p_tenant and t.currency = v_money
     and (p_kind is null or t.period_kind = lower(trim(p_kind)))
     and (p_from is null or t.period_start >= p_from)
     and (p_to is null or t.period_start <= p_to)
     and (coalesce(p_include_withdrawn, false) or t.status = 'live');

  return jsonb_build_object('ok', true, 'currency', v_money, 'rows', coalesce(v_rows, '[]'::jsonb),
    'count', jsonb_array_length(coalesce(v_rows, '[]'::jsonb)));
end $$;

-- ============================================================
-- 10. the door that counts a day
-- ============================================================

-- Take the count. The figures are never an argument: the door reads the book through the one body in
-- section 7 and stores what it says. The two answers that look like failures are the two honest ones — a
-- day already counted and unchanged is reported as `unchanged` rather than silently rewritten, and a
-- re-take keeps the reading it replaced in `previous` rather than losing it.
--
-- Naming no money counts every money the book moved income in that day, which is what the nightly sweep
-- needs and what a clerk who just wants "the 26th" means. It is refused only when the day holds nothing in
-- either money: a zero has to be a zero in a named money, or the row means nothing.
create or replace function platform_auth.take_revenue_day(
  p_tenant uuid, p_day date, p_currency text, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_note text;
  v_money text;
  v_money_list text[];
  v_read jsonb;
  v_old revenue_snapshots;
  v_same boolean;
  v_new_id uuid;
  v_ref text;
  v_state text;
  v_before jsonb;
  v_out jsonb := '[]'::jsonb;
  v_changed int;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can count the book.');
  end if;
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no book to count here.');
  end if;
  if p_day is null then
    return jsonb_build_object('ok', false, 'error', 'no_day',
      'message', 'A count needs a day. The register reads the day the movements carry, so "today" is not a '
        || 'substitute for naming it.');
  end if;
  if p_day > current_date then
    return jsonb_build_object('ok', false, 'error', 'day_is_in_the_future', 'asked', p_day::text,
      'message', p_day || ' has not happened. A count of a day that is still open would be an estimate '
        || 'filed as a reading.');
  end if;
  if p_day < current_date - 730 then
    return jsonb_build_object('ok', false, 'error', 'day_too_far_back', 'asked', p_day::text,
      'message', p_day || ' is more than two years back. The book may be older than that and the register '
        || 'does not reach it from a desk.');
  end if;
  v_note := nullif(trim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) not between 8 and 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'A note on a count is either 8 to 600 characters or nothing at all: "recount" explains '
        || 'nothing to the seat that reads it in April.');
  end if;

  if p_currency is null or trim(p_currency) = '' then
    select array_agg(distinct l.currency order by l.currency) into v_money_list
      from platform_auth.revenue_income_legs(p_tenant) l where l.posted_on = p_day;
    if v_money_list is null or array_length(v_money_list, 1) is null then
      return jsonb_build_object('ok', false, 'error', 'name_the_money', 'day', p_day::text,
        'message', 'The book moved no income on ' || p_day || ', in either money. Name TZS or USD if the '
          || 'office wants a zero recorded for that day — a zero has to be a zero in a money, or the row '
          || 'means nothing.');
    end if;
  else
    v_money := upper(trim(p_currency));
    if v_money not in ('TZS','USD') then
      return jsonb_build_object('ok', false, 'error', 'name_the_money', 'asked', p_currency,
        'message', 'The book holds two monies and the register counts one at a time: TZS or USD.');
    end if;
    v_money_list := array[v_money];
  end if;

  foreach v_money in array v_money_list loop
    v_read := platform_auth.revenue_read_day(p_tenant, p_day, v_money);

    select * into v_old from revenue_snapshots
     where tenant_id = p_tenant and snapshot_day = p_day and currency = v_money for update;
    v_same := found
      and v_old.income             = (v_read ->> 'income')::numeric
      and v_old.credit_total       = (v_read ->> 'credit_total')::numeric
      and v_old.debit_total        = (v_read ->> 'debit_total')::numeric
      and v_old.postings           = (v_read ->> 'postings')::int
      and v_old.entries            = (v_read ->> 'entries')::int
      and v_old.reversed_postings  = (v_read ->> 'reversed_postings')::int
      and v_old.by_account = v_read -> 'by_account'
      and v_old.by_source  = v_read -> 'by_source'
      and v_old.by_desk    = v_read -> 'by_desk'
      and v_old.by_route   = v_read -> 'by_route';

    if not found then
      v_new_id := gen_random_uuid();
      v_ref := 'RSV-' || to_char(now(), 'YYYY') || '-'
            || lpad(nextval('revenue_snapshot_number_seq')::text, 5, '0');
      insert into revenue_snapshots (id, tenant_id, ref, snapshot_day, currency, income,
          credit_total, debit_total, postings, entries, reversed_postings,
          by_account, by_source, by_desk, by_route, revisions, first_taken_at, taken_by, taken_at, note)
      values (v_new_id, p_tenant, v_ref, p_day, v_money,
          (v_read ->> 'income')::numeric, (v_read ->> 'credit_total')::numeric,
          (v_read ->> 'debit_total')::numeric, (v_read ->> 'postings')::int,
          (v_read ->> 'entries')::int, (v_read ->> 'reversed_postings')::int,
          v_read -> 'by_account', v_read -> 'by_source', v_read -> 'by_desk', v_read -> 'by_route',
          1, now(), p_actor, now(), v_note);
      v_state := 'taken';
    elsif v_same then
      v_new_id := v_old.id;
      v_ref := v_old.ref;
      v_state := 'unchanged';
    else
      v_new_id := v_old.id;
      v_ref := v_old.ref;
      v_before := jsonb_build_object('income', v_old.income, 'credit_total', v_old.credit_total,
        'debit_total', v_old.debit_total, 'postings', v_old.postings, 'entries', v_old.entries,
        'reversed_postings', v_old.reversed_postings, 'revisions', v_old.revisions,
        'taken_at', to_char(v_old.taken_at, 'YYYY-MM-DD HH24:MI'));
      update revenue_snapshots
         set income = (v_read ->> 'income')::numeric,
             credit_total = (v_read ->> 'credit_total')::numeric,
             debit_total = (v_read ->> 'debit_total')::numeric,
             postings = (v_read ->> 'postings')::int,
             entries = (v_read ->> 'entries')::int,
             reversed_postings = (v_read ->> 'reversed_postings')::int,
             by_account = v_read -> 'by_account',
             by_source  = v_read -> 'by_source',
             by_desk    = v_read -> 'by_desk',
             by_route   = v_read -> 'by_route',
             previous = jsonb_build_object(
               'income', v_old.income, 'credit_total', v_old.credit_total,
               'debit_total', v_old.debit_total, 'postings', v_old.postings, 'entries', v_old.entries,
               'reversed_postings', v_old.reversed_postings,
               'by_account', v_old.by_account, 'by_source', v_old.by_source,
               'by_desk', v_old.by_desk, 'by_route', v_old.by_route,
               'revisions', v_old.revisions, 'taken_by', v_old.taken_by,
               'taken_by_name', platform_auth.revenue_seat_said(v_old.taken_by),
               'taken_at', v_old.taken_at, 'note', v_old.note),
             revisions = v_old.revisions + 1,
             taken_by = p_actor, taken_at = now(),
             note = coalesce(v_note, v_old.note), updated_at = now()
       where id = v_old.id;
      v_state := 'retaken';
    end if;

    perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
      'revenue_snapshots', v_new_id,
      case v_state when 'taken' then 'revenue_snapshot_taken'
                   when 'retaken' then 'revenue_snapshot_retaken'
                   else 'revenue_snapshot_rechecked' end,
      case when v_state = 'retaken' then v_before end,
      jsonb_build_object('ref', v_ref, 'day', p_day::text, 'currency', v_money,
        'income', (v_read ->> 'income')::text, 'postings', (v_read ->> 'postings')::int,
        'entries', (v_read ->> 'entries')::int, 'reversed', (v_read ->> 'reversed_postings')::int,
        'state', v_state, 'note', v_note, 'seat', v_seat));

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'state', v_state, 'currency', v_money, 'ref', v_ref,
      'income', (v_read ->> 'income')::numeric,
      'postings', (v_read ->> 'postings')::int,
      'snapshot', platform_auth.revenue_snapshot_detail(p_tenant, v_new_id)));
  end loop;

  select count(*)::int into v_changed from jsonb_array_elements(v_out) x
   where x ->> 'state' <> 'unchanged';

  return jsonb_build_object('ok', true, 'day', p_day::text,
    'read', jsonb_array_length(v_out), 'changed', v_changed, 'snapshots', v_out,
    'message', case
      when v_changed = 0 then p_day || ' already said what the book says, in '
        || jsonb_array_length(v_out) || ' money(ies). The count was taken again, nothing moved, and the '
        || 'readings keep their date and their seat.'
      when v_changed = 1 then p_day || ' is counted: '
        || (select x -> 'snapshot' ->> 'income' from jsonb_array_elements(v_out) x
             where x ->> 'state' <> 'unchanged' limit 1) || ' '
        || (select x ->> 'currency' from jsonb_array_elements(v_out) x
             where x ->> 'state' <> 'unchanged' limit 1) || ' across '
        || (select (x ->> 'postings')::int from jsonb_array_elements(v_out) x
             where x ->> 'state' <> 'unchanged' limit 1) || ' movement(s).'
      else p_day || ' is counted in ' || jsonb_array_length(v_out) || ' money(ies) and '
        || v_changed || ' of them changed.'
    end);
end $$;

-- ============================================================
-- 11. the sweep, and the one thing that throws a count away
-- ============================================================

-- Count every day in a window the book moved income in, and re-check every day already counted in it. This
-- is the door the API's nightly loop calls for yesterday and a seat can call for a month: the "nightly" in
-- the spec is an act, not a table, and this schema holds no scheduler to keep one.
--
-- Days with nothing to read are reported as passed over rather than written as zeros. A register of two
-- hundred empty rows would look like a complete month while saying only that nobody had reason to count it,
-- and a clerk cannot tell the two apart on the screen.
create or replace function platform_auth.count_revenue_days(
  p_tenant uuid, p_from date, p_to date,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_answer jsonb;
  v_days date[];
  v_day date;
  v_row record;
  v_taken jsonb := '[]'::jsonb;
  v_passes jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_new int := 0;
  v_retook int := 0;
  v_same int := 0;
  v_days_read int := 0;
  v_passed int := 0;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can order a count.');
  end if;
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no book to count.');
  end if;
  if p_from is null or p_to is null then
    return jsonb_build_object('ok', false, 'error', 'no_window',
      'message', 'A sweep needs a first day and a last day. An open-ended sweep is how one connection gets '
        || 'held for a minute while the office waits for its page.');
  end if;
  if p_to < p_from then
    return jsonb_build_object('ok', false, 'error', 'bad_window',
      'message', 'The last day cannot come before the first day.');
  end if;
  if p_to > current_date then
    return jsonb_build_object('ok', false, 'error', 'window_reaches_tomorrow', 'asked', p_to::text,
      'message', 'A sweep stops at today: ' || p_to || ' has not happened yet.');
  end if;
  if p_from < current_date - 730 then
    return jsonb_build_object('ok', false, 'error', 'window_too_far_back', 'asked', p_from::text,
      'message', 'The sweep reaches further back than two years.');
  end if;
  if p_to - p_from + 1 > 92 then
    return jsonb_build_object('ok', false, 'error', 'window_too_wide',
      'days', (p_to - p_from + 1),
      'message', 'That window is ' || (p_to - p_from + 1) || ' days wide and one sweep reads at most 92. '
        || 'The book is counted a quarter at a time on this connection.');
  end if;

  -- Every day the book moved income in, plus every day already in the register. The second half is not
  -- redundant: a re-check is what proves the figure the office reported has not drifted under it.
  select array_agg(distinct g.d order by g.d) into v_days
    from (
      select l.posted_on as d from platform_auth.revenue_income_legs(p_tenant) l
       where l.posted_on between p_from and p_to
      union
      select s.snapshot_day as d from revenue_snapshots s
       where s.tenant_id = p_tenant and s.snapshot_day between p_from and p_to
    ) g;

  foreach v_day in array coalesce(v_days, '{}'::date[]) loop
    v_answer := platform_auth.take_revenue_day(p_tenant, v_day, null, null,
                                               p_actor, p_role, p_ip, p_ua);
    if (v_answer -> 'ok')::boolean is not true then
      -- A day that came from a leg or from a reading cannot hit the empty-day refusal; anything else the
      -- door answers is reported rather than swallowed, so a sweep never looks clean by omission.
      v_passes := v_passes || jsonb_build_array(jsonb_build_object(
        'day', v_day::text, 'refused', v_answer ->> 'error'));
      continue;
    end if;
    v_days_read := v_days_read + 1;

    for v_row in select x ->> 'currency' as currency, x ->> 'state' as state
                   from jsonb_array_elements(v_answer -> 'snapshots') x loop
      v_taken := v_taken || jsonb_build_object('day', v_day::text,
        'currency', v_row.currency, 'state', v_row.state,
        'income', (select (x -> 'snapshot' ->> 'income')::numeric
                     from jsonb_array_elements(v_answer -> 'snapshots') x
                    where x ->> 'currency' = v_row.currency));
      if v_row.state = 'taken' then v_new := v_new + 1;
      elsif v_row.state = 'retaken' then v_retook := v_retook + 1;
      else v_same := v_same + 1;
      end if;
    end loop;
  end loop;

  -- Days inside the window with neither a leg nor a reading: honestly counted, honestly passed over.
  select count(*)::int,
         coalesce(jsonb_agg(g.d order by g.d desc), '[]'::jsonb)
    into v_passed, v_missing
    from (
      select to_char(x.d::date, 'YYYY-MM-DD') as d
        from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') x(d)
       where not exists (select 1 from platform_auth.revenue_income_legs(p_tenant) l
                          where l.posted_on = x.d::date)
         and not exists (select 1 from revenue_snapshots s
                          where s.tenant_id = p_tenant and s.snapshot_day = x.d::date)
    ) g;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'revenue_snapshots', null, 'revenue_days_counted', null,
    jsonb_build_object('from_day', p_from::text, 'to_day', p_to::text,
      'days_read', v_days_read, 'new', v_new, 'retaken', v_retook, 'unchanged', v_same,
      'passed_over', v_passed, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'from_day', p_from::text, 'to_day', p_to::text,
    'days_read', v_days_read, 'new', v_new, 'retaken', v_retook, 'unchanged', v_same,
    'passed_over', v_passed, 'readings', v_taken,
    -- The first thirty of the days that were passed over, not all of them: a quarter of a book can hold
    -- ninety empty days and an answer that carries every date is a page nobody reads. The count above is
    -- the whole figure and `passed_over_days_capped` says the list is a list of thirty rather than the
    -- list of all — a capped array presented as complete is the same omission the cuts refuse.
    'passed_over_days', (select coalesce(jsonb_agg(g.v order by g.ord), '[]'::jsonb)
                          from jsonb_array_elements(v_missing) with ordinality as g(v, ord)
                         where g.ord <= 30),
    'passed_over_days_capped', v_passed > 30,
    'refused', case when jsonb_array_length(v_passes) > 0 then v_passes end,
    'message', v_days_read || ' day(s) read between ' || p_from || ' and ' || p_to || ': '
      || v_new || ' new, ' || v_retook || ' re-taken, ' || v_same
      || ' already said the same thing. ' || v_passed
      || ' day(s) in the window had nothing for the register to read and were passed over, not written as '
      || 'zeros.');
end $$;

-- Throw away a reading of a day that held nothing. This is the only erase in the register and it is narrow
-- on purpose: the guard in section 5 refuses the same delete for any day that moved money, and the door
-- says so in the same words before the trigger has to, so a clerk is never told that a press broke.
create or replace function platform_auth.discard_revenue_day(
  p_tenant uuid, p_snapshot uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v revenue_snapshots;
  v_reason text;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can throw away a count.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) not between 8 and 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters why the reading goes: the audit line keeps the sentence after '
        || 'the row does.');
  end if;
  select * into v from revenue_snapshots where id = p_snapshot and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no count of this book with that number.');
  end if;
  if v.postings > 0 then
    return jsonb_build_object('ok', false, 'error', 'counted_a_day_that_moved',
      'ref', v.ref, 'day', v.snapshot_day::text, 'currency', v.currency, 'postings', v.postings,
      'message', v.ref || ' counted ' || v.postings || ' movement(s) on ' || v.snapshot_day
        || '. A day the book moved is answered by re-taking the count, not by erasing it: the reading is '
        || 'what the office said about that day and it stands.');
  end if;

  delete from revenue_snapshots where id = v.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'revenue_snapshots', v.id, 'revenue_snapshot_discarded',
    jsonb_build_object('ref', v.ref, 'day', v.snapshot_day::text, 'currency', v.currency,
      'income', v.income, 'revisions', v.revisions),
    jsonb_build_object('reason', v_reason, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'discarded', v.ref, 'day', v.snapshot_day::text,
    'currency', v.currency,
    'message', v.ref || ' was a reading of a day the book held nothing in, so it is thrown away. '
      || v.snapshot_day || ' is uncounted again, and the sweep writes it the moment the book moves.');
end $$;

-- ============================================================
-- 12. the doors that set and stop an ambition
-- ============================================================

-- Set the figure. The period is derived, never typed: a clerk who names a Wednesday and means "that week"
-- gets the Monday the week starts on, and the answer prints the period it actually wrote, so nobody has to
-- work out whether the desk understood them.
create or replace function platform_auth.set_revenue_target(
  p_tenant uuid, p_kind text, p_day date, p_amount numeric, p_currency text, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v_kind text;
  v_money text;
  v_note text;
  v_start date;
  v_id uuid;
  v_ref text;
  v_existing revenue_targets;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can promise a figure.');
  end if;
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'An ambition set in a book that is not here is nothing to measure against.');
  end if;
  v_kind := lower(trim(coalesce(p_kind, 'month')));
  if v_kind not in ('day','week','month') then
    return jsonb_build_object('ok', false, 'error', 'bad_period', 'asked', p_kind,
      'message', 'A target is set for a day, a week or a month.');
  end if;
  if p_day is null then
    return jsonb_build_object('ok', false, 'error', 'no_day',
      'message', 'Say which period you mean by naming a day inside it. The register works out where that '
        || 'period starts.');
  end if;
  v_money := upper(trim(coalesce(p_currency, 'TZS')));
  if v_money not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'name_the_money', 'asked', p_currency,
      'message', 'A target is one figure in one money. TZS or USD.');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_amount',
      'message', 'A target of nothing is not an ambition, and a negative one is a cost wearing the wrong '
        || 'duty key.');
  end if;
  if p_amount > 10000000000 then
    return jsonb_build_object('ok', false, 'error', 'amount_out_of_range', 'asked', p_amount,
      'message', 'That is larger than the register carries. Check the number of zeros.');
  end if;
  v_note := nullif(trim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) not between 8 and 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'A note on a promise is either 8 to 600 characters or nothing at all.');
  end if;

  v_start := platform_auth.revenue_period_start(v_kind, p_day);
  if v_start < current_date - 730 or v_start > current_date + 730 then
    return jsonb_build_object('ok', false, 'error', 'period_out_of_reach', 'start', v_start::text,
      'message', v_start || ' is more than two years from today in either direction.');
  end if;

  select * into v_existing from revenue_targets
   where tenant_id = p_tenant and currency = v_money and period_kind = v_kind
     and period_start = v_start and status = 'live';
  if found then
    return jsonb_build_object('ok', false, 'error', 'target_exists',
      'ref', v_existing.ref, 'target_id', v_existing.id, 'amount', v_existing.amount,
      'period', platform_auth.revenue_period_label(v_kind, v_start), 'currency', v_money,
      'message', v_existing.ref || ' already promises ' || v_existing.amount || ' ' || v_money || ' for '
        || platform_auth.revenue_period_label(v_kind, v_start)
        || '. A promise is changed by withdrawing it and setting the new figure as its own target, so the '
        || 'office can still say what it first meant to earn.');
  end if;

  v_id := gen_random_uuid();
  v_ref := 'RTG-' || to_char(now(), 'YYYY') || '-'
        || lpad(nextval('revenue_target_number_seq')::text, 5, '0');
  insert into revenue_targets (id, tenant_id, ref, currency, period_kind, period_start, amount,
      note, status, raised_by, raised_at)
  values (v_id, p_tenant, v_ref, v_money, v_kind, v_start, p_amount, v_note, 'live', p_actor, now());

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'revenue_targets', v_id, 'revenue_target_set', null,
    jsonb_build_object('ref', v_ref, 'kind', v_kind, 'day_named', p_day::text,
      'period_start', v_start::text, 'label', platform_auth.revenue_period_label(v_kind, v_start),
      'amount', p_amount::text, 'currency', v_money, 'note', v_note, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'wrote', v_ref,
    'period', platform_auth.revenue_period_label(v_kind, v_start),
    'period_start', v_start::text, 'derived', (v_start <> p_day),
    'message', v_ref || ' promises ' || p_amount || ' ' || v_money || ' for '
      || platform_auth.revenue_period_label(v_kind, v_start)
      || case when v_start <> p_day then ' — you named ' || p_day || ', and that ' || v_kind
         || ' starts on ' || v_start else '' end || '.',
    'target', platform_auth.revenue_target_detail(p_tenant, v_id));
end $$;

-- Stop a promise. The row and its reason stay: a register that let an ambition be un-said would leave the
-- months it was counted against without the figure they were measured by.
create or replace function platform_auth.withdraw_revenue_target(
  p_tenant uuid, p_target uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v revenue_targets;
  v_reason text;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can stop a promise.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) not between 8 and 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters why the figure stops: the sentence is read beside the period it '
        || 'was promised for.');
  end if;
  select * into v from revenue_targets where id = p_target and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no target in this book with that number.');
  end if;
  if v.status = 'withdrawn' then
    return jsonb_build_object('ok', false, 'error', 'already_withdrawn', 'ref', v.ref,
      'stopped_on', v.withdrawn_at::text,
      'message', v.ref || ' was already stopped on ' || v.withdrawn_at::date
        || ' because: ' || v.withdrawn_reason || '. A stopped promise does not stop twice, and it does not '
        || 'come back — set a new target for the period if the ambition changed.');
  end if;

  update revenue_targets
     set status = 'withdrawn', withdrawn_by = p_actor, withdrawn_at = now(),
         withdrawn_reason = v_reason, updated_at = now()
   where id = v.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'revenue_targets', v.id, 'revenue_target_withdrawn',
    jsonb_build_object('status', v.status, 'amount', v.amount, 'withdrawn_reason', null),
    jsonb_build_object('ref', v.ref, 'kind', v.period_kind,
      'label', platform_auth.revenue_period_label(v.period_kind, v.period_start),
      'amount', v.amount::text, 'currency', v.currency, 'reason', v_reason, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'stopped', v.ref,
    'message', v.ref || ' stopped. '
      || platform_auth.revenue_period_label(v.period_kind, v.period_start)
      || ' keeps its promise in the register as a stopped one, so a month that fell short still says what '
      || 'it was measured against.',
    'target', platform_auth.revenue_target_detail(p_tenant, v.id));
end $$;

-- Throw away a promise nobody has ever been measured against. The guard in section 5 refuses the delete for
-- anything else, and the door names the two reasons before the trigger has to.
create or replace function platform_auth.discard_revenue_target(
  p_tenant uuid, p_target uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seat text;
  v revenue_targets;
  v_reason text;
  v_counted int;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can throw away a target.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) not between 8 and 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters why the promise goes.');
  end if;
  select * into v from revenue_targets where id = p_target and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no target in this book with that number.');
  end if;
  if v.status = 'withdrawn' then
    return jsonb_build_object('ok', false, 'error', 'stop_is_recorded', 'ref', v.ref,
      'message', v.ref || ' was stopped on ' || v.withdrawn_at::date
        || '. Its row is the record that somebody decided it, so it stays. Throw away a target that was '
        || 'never stood up and never stopped.');
  end if;
  select count(*)::int into v_counted from revenue_snapshots s
   where s.tenant_id = v.tenant_id and s.currency = v.currency
     and s.snapshot_day >= v.period_start
     and s.snapshot_day < platform_auth.revenue_period_end(v.period_kind, v.period_start);
  if coalesce(v_counted, 0) > 0 then
    return jsonb_build_object('ok', false, 'error', 'already_counted_against', 'ref', v.ref,
      'days', v_counted,
      'message', v_counted || ' day(s) of '
        || platform_auth.revenue_period_label(v.period_kind, v.period_start)
        || ' have been counted while ' || v.ref || ' was standing. Withdraw it instead: the office was '
        || 'measured against this figure, and that is a fact the register keeps.');
  end if;

  delete from revenue_targets where id = v.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'revenue_targets', v.id, 'revenue_target_discarded',
    jsonb_build_object('ref', v.ref, 'kind', v.period_kind, 'period_start', v.period_start::text,
      'amount', v.amount, 'currency', v.currency),
    jsonb_build_object('reason', v_reason, 'seat', v_seat));

  return jsonb_build_object('ok', true, 'discarded', v.ref,
    'message', v.ref || ' was thrown away. No day was ever counted against it, so nothing the office has '
      || 'reported changes.');
end $$;

-- ============================================================
-- 13. the duties, and the two hands that must not be one hand
-- ============================================================

-- Reading the count is not the same act as making it, and making it is not the same act as promising
-- against it. 135 kept `.recon` away from `.post` and 140 kept `.publish` away from `.manage` for this
-- exact reason: a seat that both sets the figure and records the achievement can produce a month that looks
-- like a plan came true. So `.count` goes to the seats that write in the book and `.target` to the seats
-- that price and bill the platform, and the census in section 15 refuses to finish if the two role sets
-- turn out to be the same set.
insert into permissions (key, description) values
  ('control.revenue.view',
   'Control - Read what the office counted of the money in, its cuts, its windows and its promises'),
  ('control.revenue.count',
   'Control - Count a day of the book, sweep a window, re-take a reading and throw away an empty one'),
  ('control.revenue.target',
   'Control - Set a day, week or month figure the office means to earn, and stop one')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.revenue.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','billing_admin','finance_officer','platform_analyst','auditor')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.revenue.count'
  from roles r
 where r.tenant_id is null and r.key in ('super_admin','finance_officer')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.revenue.target'
  from roles r
 where r.tenant_id is null and r.key in ('super_admin','billing_admin')
on conflict do nothing;

-- ============================================================
-- 14. grants on the doors
-- ============================================================

-- The bodies that are the register's own working first: the leg population, the arithmetic, the two
-- resolvers, the period maths, the seat printer, the sum behind the CHECKs and the four guards. A client
-- role that could call `revenue_income_legs` would hold a reader that bypasses row-level security on the
-- book; a role that could call `revenue_read_day` could produce a figure it was never granted; and a role
-- that could call a guard body could ask it about a row it cannot see. The doors and the reads still call
-- them — a door and the body it calls share an owner, and an owner always holds execute on its own work,
-- which is exactly what a `from ... app_runtime` revoke leaves untouched.
revoke execute on function
  platform_auth.revenue_cut_sum(jsonb),
  platform_auth.revenue_source_said(text),
  platform_auth.revenue_period_start(text, date),
  platform_auth.revenue_period_label(text, date),
  platform_auth.revenue_period_end(text, date),
  platform_auth.revenue_seat_said(uuid),
  platform_auth.revenue_income_legs(uuid),
  platform_auth.revenue_route_named(uuid, uuid),
  platform_auth.revenue_desk_named(uuid, uuid, date),
  platform_auth.revenue_read_day(uuid, date, text),
  platform_auth.revenue_snapshot_header_is_immutable(),
  platform_auth.revenue_snapshot_is_kept(),
  platform_auth.revenue_target_header_is_immutable(),
  platform_auth.revenue_target_is_kept()
from public, anon, authenticated, service_role, app_runtime;

-- The reads and the doors. Every one takes the book's uuid as its first argument and binds it in every
-- statement: this schema's role bypasses row-level security, so a read that trusted the policy would be a
-- read that shows one office another office's figures.
grant execute on function
  platform_auth.revenue_snapshot_detail(uuid, uuid),
  platform_auth.revenue_snapshot_list(uuid, text, date, date, int, int),
  platform_auth.revenue_count_state(uuid, int),
  platform_auth.revenue_window(uuid, text, date, date, text),
  platform_auth.revenue_cut(uuid, text, date, date, text, int),
  platform_auth.revenue_target_detail(uuid, uuid),
  platform_auth.revenue_target_list(uuid, text, text, date, date, boolean),
  platform_auth.take_revenue_day(uuid, date, text, text, uuid, text, text, text),
  platform_auth.count_revenue_days(uuid, date, date, uuid, text, text, text),
  platform_auth.discard_revenue_day(uuid, uuid, text, uuid, text, text, text),
  platform_auth.set_revenue_target(uuid, text, date, numeric, text, text, uuid, text, text, text),
  platform_auth.withdraw_revenue_target(uuid, uuid, text, uuid, text, text, text),
  platform_auth.discard_revenue_target(uuid, uuid, text, uuid, text, text, text)
to app_runtime;

-- Then taken back from every Supabase-side role, because `create or replace function` hands EXECUTE back to
-- PUBLIC. `authenticated` is a company's clerk, not the office.
revoke all on function
  platform_auth.revenue_snapshot_detail(uuid, uuid),
  platform_auth.revenue_snapshot_list(uuid, text, date, date, int, int),
  platform_auth.revenue_count_state(uuid, int),
  platform_auth.revenue_window(uuid, text, date, date, text),
  platform_auth.revenue_cut(uuid, text, date, date, text, int),
  platform_auth.revenue_target_detail(uuid, uuid),
  platform_auth.revenue_target_list(uuid, text, text, date, date, boolean),
  platform_auth.take_revenue_day(uuid, date, text, text, uuid, text, text, text),
  platform_auth.count_revenue_days(uuid, date, date, uuid, text, text, text),
  platform_auth.discard_revenue_day(uuid, uuid, text, uuid, text, text, text),
  platform_auth.set_revenue_target(uuid, text, date, numeric, text, text, uuid, text, text, text),
  platform_auth.withdraw_revenue_target(uuid, uuid, text, uuid, text, text, text),
  platform_auth.discard_revenue_target(uuid, uuid, text, uuid, text, text, text)
from public, anon, authenticated, service_role;

-- The numbering sequences: owner and definer doors only. A client role that could `nextval` a ref would
-- leave the office a hole in its own numbering to explain, and 134's, 135's, 141's and 142's gates all
-- count the same thing.
revoke all on revenue_snapshot_number_seq from public, anon, authenticated, service_role, app_runtime;
revoke all on revenue_target_number_seq from public, anon, authenticated, service_role, app_runtime;

-- ============================================================
-- 15. the census: the words, the bodies and the figures have to agree
-- ============================================================

-- The questions this migration can answer only once, answered by refusing to finish. The register's whole
-- claim is that a reading can be produced again and that its parts add up to its whole, so the census
-- restates both against the book as it stands rather than trusting the CHECKs that made them true: a later
-- migration that weakened a CHECK would fail here and not on the screen.
do $$
declare
  v_tables int;
  v_unprotected int;
  v_readers int;
  v_writers int;
  v_periods int;
  v_bad_period int;
  v_week_start date;
  v_bad_target int;
  v_no_word int;
  v_bad_sum int;
  v_bad_difference int;
  v_empty_lie int;
  v_orphan_revision int;
  v_misaligned_target int;
  v_unexplained_stop int;
  v_doubled_target int;
  v_leaks int;
  v_missing_grant text;
  v_wrong_revoke text;
  v_seq_holders int;
  v_duties int;
  v_holders int;
  v_count_roles text;
  v_target_roles text;
begin
  select count(*)::int into v_tables from pg_tables
   where schemaname = 'public'
     and tablename in ('revenue_periods','revenue_snapshots','revenue_targets');
  if v_tables <> 3 then
    raise exception '143: the count register is three tables and it holds %', v_tables;
  end if;

  select count(*)::int into v_unprotected from pg_tables t
   where t.schemaname = 'public' and t.tablename in ('revenue_snapshots','revenue_targets')
     and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where c.relname = t.tablename and n.nspname = 'public' and c.relrowsecurity);
  if v_unprotected <> 0 then
    raise exception '143: % of the count registers can be read without a book being named', v_unprotected;
  end if;

  select count(distinct c.relname)::int into v_readers
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join aclexplode(c.relacl) a
   where n.nspname = 'public' and c.relname in ('revenue_snapshots','revenue_targets')
     and a.grantee = (select oid from pg_roles where rolname = 'app_runtime')
     and a.privilege_type = 'SELECT';
  if v_readers <> 2 then
    raise exception '143: the app role reads both registers through a door and reads %', v_readers;
  end if;

  -- Not one direct write, in either direction. A count is written by a door that walks the book and an
  -- ambition by one that derives a period; a role with INSERT on the table can do neither, and would be the
  -- way a figure reaches the register with no seat and no minute against it.
  select count(*)::int into v_writers
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relname in ('revenue_periods','revenue_snapshots','revenue_targets')
     and a.grantee = (select oid from pg_roles where rolname = 'app_runtime')
     and a.privilege_type in ('INSERT','UPDATE','DELETE');
  if v_writers <> 0 then
    raise exception '143: the app role writes counts through a door and holds % direct write grant(s)',
      v_writers;
  end if;

  -- The three words, each matched to the fold it names. A fourth word here without a fold rule would be a
  -- segmented control on the desk answering with a period the window body does not perform.
  select count(*)::int into v_periods from revenue_periods;
  if v_periods <> 3 then
    raise exception '143: a count folds by day, week or month and the register lists %', v_periods;
  end if;
  select count(*)::int into v_bad_period from revenue_periods p
   where (p.key, p.trunc, p.sort) not in (('day','none',1), ('week','week',2), ('month','month',3));
  if v_bad_period <> 0 then
    raise exception '143: % period row(s) carry a fold or an order the window body was not written '
      'against', v_bad_period;
  end if;

  -- The helper against the sentence the register prints. The desk's copy says the week starts on Monday
  -- because that is the day the office opens; if the arithmetic started it somewhere else, every weekly
  -- target and every weekly fold would be a week the clerk did not mean.
  v_week_start := platform_auth.revenue_period_start('week', date '2026-10-21');
  if v_week_start <> date '2026-10-19' then
    raise exception '143: the week helper gave % for the week holding 21 Oct, and the register tells the '
      'office its weeks start on Monday', v_week_start;
  end if;
  -- The end day is the first day of the next period, in every fold. Test it by the round trip rather than
  -- by three printed dates: the day before an end must still answer to the period it was derived from, and
  -- an inclusive end would make the first day of the next period belong to two counts at once.
  if platform_auth.revenue_period_end('week', v_week_start) <> date '2026-10-26'
     or platform_auth.revenue_period_end('month', date '2026-01-01') <> date '2026-02-01'
     or platform_auth.revenue_period_end('day', date '2026-10-26') <> date '2026-10-27'
     or platform_auth.revenue_period_start('week',
          platform_auth.revenue_period_end('week', v_week_start) - 1) <> v_week_start
     or platform_auth.revenue_period_start('month',
          platform_auth.revenue_period_end('month', date '2026-01-01') - 1) <> date '2026-01-01' then
    raise exception '143: a period does not end where the fold says it ends, so the register would count '
      'the first day of the next one twice';
  end if;

  -- The words beside the figures, checked by the day they have to name. A format string that takes `D` for
  -- the day of the month prints the day of the WEEK: the count stayed right while the desk said "tuesday 3
  -- Oct" about the 27th, and no sum in this register can notice a sentence that is a date short.
  if platform_auth.revenue_period_label('day', date '2026-10-27') not like '%27%October%2026%'
     or platform_auth.revenue_period_label('week', date '2026-10-26')
          not like '%26%October%1%November%2026'
     or platform_auth.revenue_period_label('month', date '2026-10-01') not like '%October%2026%' then
    raise exception '143: the period label reads «%» / «%» / «%» and one of them does not name the day the '
      'fold starts and ends on',
      platform_auth.revenue_period_label('day', date '2026-10-27'),
      platform_auth.revenue_period_label('week', date '2026-10-26'),
      platform_auth.revenue_period_label('month', date '2026-10-01');
  end if;

  select count(*)::int into v_bad_target from revenue_targets t
   where t.period_start <> platform_auth.revenue_period_start(t.period_kind, t.period_start);
  if v_bad_target <> 0 then
    raise exception '143: % target row(s) are filed on a day their own period does not start on',
      v_bad_target;
  end if;

  -- Every movement kind the book carries has a word to be printed in. A new `source_kind` added to 133's
  -- list without a branch here would reach the desk as the fallback sentence: honest, but a label nobody
  -- chose, and the register's own list would have moved ahead of its words.
  select count(*)::int into v_no_word from (
    select distinct l.source_kind
      from platform_auth.revenue_income_legs(
             (select t.id from tenants t where t.deleted_at is null limit 1)) l
  ) k where position('a word the register does not know' in
                     platform_auth.revenue_source_said(k.source_kind)) > 0;
  if v_no_word <> 0 then
    raise exception '143: % movement kind(s) are in the book and have no word in revenue_source_said',
      v_no_word;
  end if;

  -- The invariants, restated against whatever the register already holds.
  select count(*)::int into v_bad_sum from revenue_snapshots s
   where platform_auth.revenue_cut_sum(s.by_account) <> s.income
      or platform_auth.revenue_cut_sum(s.by_source)  <> s.income
      or platform_auth.revenue_cut_sum(s.by_desk)    <> s.income
      or platform_auth.revenue_cut_sum(s.by_route)   <> s.income;
  if v_bad_sum <> 0 then
    raise exception '143: % reading(s) have a cut that does not add up to the income they report',
      v_bad_sum;
  end if;
  select count(*)::int into v_bad_difference from revenue_snapshots s
   where s.income <> s.credit_total - s.debit_total;
  if v_bad_difference <> 0 then
    raise exception '143: % reading(s) report a figure that is not the difference of their own two piles',
      v_bad_difference;
  end if;
  select count(*)::int into v_empty_lie from revenue_snapshots s
   where s.postings = 0 and (s.income <> 0 or s.entries <> 0
        or jsonb_array_length(s.by_account) <> 0 or jsonb_array_length(s.by_source) <> 0
        or jsonb_array_length(s.by_desk) <> 0 or jsonb_array_length(s.by_route) <> 0);
  if v_empty_lie <> 0 then
    raise exception '143: % reading(s) claim an empty day over figures that are not empty', v_empty_lie;
  end if;
  select count(*)::int into v_orphan_revision from revenue_snapshots s
   where s.revisions > 1 and s.previous is null;
  if v_orphan_revision <> 0 then
    raise exception '143: % reading(s) were counted more than once and do not say what the first count '
      'said', v_orphan_revision;
  end if;
  select count(*)::int into v_misaligned_target from revenue_targets t
   where (t.period_kind = 'week'  and extract(isodow from t.period_start) <> 1)
      or (t.period_kind = 'month' and t.period_start <> date_trunc('month', t.period_start)::date);
  if v_misaligned_target <> 0 then
    raise exception '143: % target(s) are filed on a day that is not the start of the period they name',
      v_misaligned_target;
  end if;
  select count(*)::int into v_unexplained_stop from revenue_targets t
   where t.status = 'withdrawn'
     and (t.withdrawn_by is null or t.withdrawn_at is null
          or char_length(trim(coalesce(t.withdrawn_reason, ''))) < 8);
  if v_unexplained_stop <> 0 then
    raise exception '143: % target(s) were stopped without a seat, a minute and a sentence',
      v_unexplained_stop;
  end if;
  select count(*)::int into v_doubled_target from (
    select t.tenant_id, t.currency, t.period_kind, t.period_start
      from revenue_targets t where t.status = 'live'
     group by 1,2,3,4 having count(*) > 1) d;
  if v_doubled_target <> 0 then
    raise exception '143: % period(s) are promised twice in the same money, so attainment has one answer '
      'and the register has two', v_doubled_target;
  end if;

  -- Nothing of this register is reachable through the Supabase-side roles. `create or replace function`
  -- grants EXECUTE to PUBLIC, so a door granted to the app role and not taken back from the rest is a door
  -- every authenticated company clerk can kick.
  select count(*)::int into v_leaks from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth'
     and p.proname in ('revenue_snapshot_detail','revenue_snapshot_list','revenue_count_state',
                       'revenue_window','revenue_cut','revenue_target_detail','revenue_target_list',
                       'take_revenue_day','count_revenue_days','discard_revenue_day','set_revenue_target',
                       'withdraw_revenue_target','discard_revenue_target',
                       'revenue_income_legs','revenue_read_day','revenue_cut_sum','revenue_period_start',
                       'revenue_period_label','revenue_period_end','revenue_seat_said',
                       'revenue_source_said','revenue_route_named','revenue_desk_named',
                       'revenue_snapshot_header_is_immutable','revenue_snapshot_is_kept',
                       'revenue_target_header_is_immutable','revenue_target_is_kept')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE')
       or has_function_privilege('public', p.oid, 'EXECUTE'));
  if v_leaks <> 0 then
    raise exception '143: % of this register''s bodies are still reachable from the Supabase-side roles',
      v_leaks;
  end if;

  -- The thirteen doors are the only path a client has, and every one has to actually be open. A grant list
  -- whose signature drifted from the definition would fail quietly at the first press.
  select string_agg(d.name, ', ' order by d.name) into v_missing_grant
    from (values
      ('revenue_snapshot_detail'), ('revenue_snapshot_list'), ('revenue_count_state'),
      ('revenue_window'), ('revenue_cut'), ('revenue_target_detail'), ('revenue_target_list'),
      ('take_revenue_day'), ('count_revenue_days'), ('discard_revenue_day'), ('set_revenue_target'),
      ('withdraw_revenue_target'), ('discard_revenue_target')) as d(name)
   where not exists (select 1 from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'platform_auth' and p.proname = d.name
                       and has_function_privilege('app_runtime', p.oid, 'EXECUTE'));
  if v_missing_grant is not null then
    raise exception '143: the app role cannot reach %: a desk door was written and never opened',
      v_missing_grant;
  end if;

  -- And the internals are really shut against it, including the leg reader that bypasses the policy.
  select string_agg(d.name, ', ' order by d.name) into v_wrong_revoke
    from (values
      ('revenue_income_legs'), ('revenue_read_day'), ('revenue_cut_sum'), ('revenue_period_start'),
      ('revenue_period_label'), ('revenue_period_end'), ('revenue_seat_said'), ('revenue_source_said'),
      ('revenue_route_named'), ('revenue_desk_named'),
      ('revenue_snapshot_header_is_immutable'), ('revenue_snapshot_is_kept'),
      ('revenue_target_header_is_immutable'), ('revenue_target_is_kept')) as d(name)
   where exists (select 1 from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'platform_auth' and p.proname = d.name
                   and has_function_privilege('app_runtime', p.oid, 'EXECUTE'));
  if v_wrong_revoke is not null then
    raise exception '143: the app role still holds execute on %, which are the register''s own working',
      v_wrong_revoke;
  end if;

  select count(*)::int into v_seq_holders from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relname in ('revenue_snapshot_number_seq','revenue_target_number_seq')
     and a.grantee <> 0
     and a.grantee <> (select oid from pg_roles where rolname = 'postgres');
  if v_seq_holders <> 0 then
    raise exception '143: % grant entry(ies) let a client role take a number from the count''s own '
      'sequence', v_seq_holders;
  end if;

  -- The three duties, held by somebody, and held by different people. A key with no seat is a nav entry
  -- that answers a clerk with an empty panel; two keys with the same role set are one hand setting the
  -- figure and recording the achievement, which is 135's refusal wearing a different name.
  select count(*)::int into v_duties from permissions
   where key in ('control.revenue.view','control.revenue.count','control.revenue.target');
  if v_duties <> 3 then
    raise exception '143: the count desk gates itself on three duties and the register holds %', v_duties;
  end if;
  if exists (select 1 from permissions where key like 'control.revenue.%'
               and key not in ('control.revenue.view','control.revenue.count',
                               'control.revenue.target')) then
    raise exception '143: a fourth revenue duty has appeared and no door in this file opens for it';
  end if;
  select count(*)::int into v_holders from role_permissions rp
    join roles r on r.id = rp.role_id
   where r.tenant_id is null and rp.permission_key = 'control.revenue.view';
  if v_holders < 2 then
    raise exception '143: only % platform role(s) may read the count, so the desk is a door with two keys '
      'and a vacancy beside it', v_holders;
  end if;

  select string_agg(r.key, ',' order by r.key) into v_count_roles
    from role_permissions rp join roles r on r.id = rp.role_id
   where r.tenant_id is null and rp.permission_key = 'control.revenue.count';
  select string_agg(r.key, ',' order by r.key) into v_target_roles
    from role_permissions rp join roles r on r.id = rp.role_id
   where r.tenant_id is null and rp.permission_key = 'control.revenue.target';
  if v_count_roles is null or v_target_roles is null then
    raise exception '143: the register can count (% role(s)) or promise (% role(s)) but not both under a '
      'seat', coalesce(v_count_roles, 'none'), coalesce(v_target_roles, 'none');
  end if;
  if v_count_roles = v_target_roles then
    raise exception '143: control.revenue.count and control.revenue.target are held by exactly the same '
      'roles (%). The hand that sets the ambition must not be the hand that records the achievement',
      v_count_roles;
  end if;
  if exists (select 1 from role_permissions rp
               join roles r on r.id = rp.role_id
              where r.tenant_id is null
                and rp.permission_key in ('control.revenue.count','control.revenue.target')
                and not exists (select 1 from role_permissions x
                                 where x.role_id = rp.role_id
                                   and x.permission_key = 'control.revenue.view')) then
    raise exception '143: a platform role may count or promise against the book without being able to read '
      'it: the door would open on a panel the seat cannot see';
  end if;
end $$;

commit;
