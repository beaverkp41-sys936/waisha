-- 135: The office counts itself, and the gateway's answers are kept.
--
-- 133 built a book that balances itself and gave the desk one word of comfort: `money_book_is_square`
-- answers whether every movement has two legs and whether the debits still equal the credits. 134
-- built the papers that settle into it — wallets, holds, payouts — and the guard triggers that keep
-- each paper honest against its own movement. Both are true, and neither of them is a reconciliation,
-- because the question an office actually asks is not "is the book internally sound" but "does the
-- book still agree with the papers, the rails and the refund queue about the money".
--
-- Six registers carry a money figure in this schema — 005's payments, 029's freight invoices, 039's
-- costs, 072's payroll, 126's refund papers and 134's payouts and holds — and one book carries the
-- legs. They have never been asked in the same sentence whether they agree. `api/src/billing/
-- reconcile.ts` is the file named for that question and it reads one table and expires licences: it
-- reconciles nothing. A drift therefore has no home today: a hold whose movement went missing, a
-- refund paper signed and never accrued, a payable line that has stopped matching the papers standing
-- on it — every one of those is a fact the office can only discover by accident.
--
-- The gateway has the same shape of hole on its side. A rail's answer arrives at `POST
-- /payments/webhook`, is verified over the raw bytes and written into `payment_webhooks` — a register
-- 005 grants the app role INSERT and SELECT *only*, deliberately, because it is what a stranger can
-- reach. When the completion behind a delivery throws, the row keeps `processing_error` and
-- `processed_at IS NULL` and nothing ever goes back for it. That is a customer whose licence stayed
-- locked after their phone said yes, and an office that cannot see the pile.
--
-- So this file ships three things:
--
--   * `money_reconciliation_runs` — one act of counting: a scope, one money, a window of days, the
--     populations examined, and the exceptions found. A run is a statement the office makes about
--     itself on a day, which is why a second seat signs it: `sign_money_reconciliation_run` refuses
--     the seat that raised it, the same rule 121 put on every money movement.
--   * `money_reconciliation_findings` — the exceptions. **Only exceptions are written.** A check that
--     agrees records its population in the run's `examined` and no row of its own, so the register
--     holds exactly the list of things the office has to answer for, in the words a clerk can read.
--     Every finding carries both figures, the difference between them, and a `why` of at least eight
--     characters — a finding nobody can act on is a colour on a dashboard.
--   * `gateway_webhook_attempts` — the retry ledger. `payment_webhooks` cannot be updated by anybody,
--     and that is not a bug to route around: a second attempt is a new fact, so it is written as a
--     new append-only row beside the delivery it answers for. A delivery is retried by re-driving
--     `platform_auth.complete_payment`, which is idempotent (009) and answers `already_final` for a
--     charge it has already closed, so a retry can never bill or activate anything twice.
--
-- And the third thing a book owes its readers, `platform_auth.money_statement()`: one account, one
-- window, the opening figure, every movement in day order with a running balance, and the closing
-- figure. 133's `money_register` is the whole book in day order; an accountant asks for one line.
--
-- **What 135 is not.** It writes no money. Not one leg, not one header, not one cached total — the
-- book is read and never touched here, because a tool that finds drift must not be the thing that
-- edits it. It fixes nothing: the answer to a finding is the door that made the paper, or a mirror
-- posting written by 133's `reverse_money_posting`, or the office's own `adjustment`. It does not
-- schedule: a run is raised by a seat, and an office that wants one weekly will get it from a cron
-- outside this schema, with a seat's own actor, so that every count has somebody's name on it.
--
-- **The window, stated once.** `from_day`/`to_day` bound the *book's* days (`money_postings.posted_on`)
-- and the *gateway's* arrivals (`payment_webhooks.created_at`, `payments.requested_at`). The register
-- checks are not windowed: a hold that lost its movement is not last month's problem, and a payable
-- line that has stopped matching the papers on it cannot be compared half over the window on one side
-- and wholly on the other. Every equation 135 evaluates compares a whole fact to a whole fact, which
-- is the only way two sides can be provably about the same money.
begin;

-- 135's own witness: the book's figures as they stood before this file ran, so the self-check at the
-- bottom can prove what the header claims — that a file which reconciles the book did not edit it. A
-- temp table lives in this transaction and in no register afterwards, and only this file's owner can
-- see it, which is the whole point: the assertion cannot be satisfied by a row somebody left behind.
create temporary table tmp_135_book_before on commit preserve rows as
  select (select count(*)::bigint from money_postings) as postings,
         (select count(*)::bigint from money_entries)  as legs,
         (select coalesce(sum(e.amount), 0) from money_entries e
           where e.direction = 'debit')                 as debited,
         (select coalesce(sum(e.amount), 0) from money_entries e
           where e.direction = 'credit')                as credited,
         (select coalesce(sum(a.debit_total), 0) from money_accounts a)  as cached_debit,
         (select coalesce(sum(a.credit_total), 0) from money_accounts a) as cached_credit,
         (select coalesce(sum(a.entry_count), 0)::bigint from money_accounts a) as cached_count,
         (select count(*)::bigint from money_accounts)  as lines;

-- ============================================================
-- 1. the run: one act of counting, signed by a second seat
-- ============================================================

create sequence if not exists recon_run_number_seq;

create table if not exists money_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  -- Whose book was counted. The office's, always — 133's rule that the tenant column names the
  -- book's owner, and a company has no register of the office's legs to reconcile.
  tenant_id uuid not null references tenants(id),
  ref text not null unique check (ref ~ '^REC-[0-9]{4}-[0-9]{5,}$'),
  -- Which half of the office is being asked. `all` is the whole set; the six named scopes are the
  -- doors a clerk walks one at a time. A scope is not a filter on the money: it is the list of
  -- questions the run is allowed to answer, so a run can be re-run narrowly after one fix.
  scope text not null check (scope in (
    'book','wallet','escrow','payout','refund','gateway','all')),
  -- One money per run. 133 refuses a movement that changes currency, and a run that added a TZS
  -- difference to a USD one would be the same crime in the report.
  currency text not null default 'TZS' check (currency in ('TZS','USD')),
  from_day date not null,
  to_day date not null,
  -- The populations the run read, and the sentences naming anything it had to leave alone. Held as
  -- jsonb because the set of questions changes with the scope, and a column per question would make
  -- every new check a migration.
  examined jsonb not null default '{}'::jsonb,
  checks int not null default 0 check (checks >= 0),
  findings int not null default 0 check (findings >= 0),
  -- Σ(book − paper) over the findings written. Signed on purpose: a positive figure means the book
  -- claims more than the papers do, which is the direction a clerk has to know before they can say
  -- whether the office is short or the register is.
  net_difference numeric(14,2) not null default 0,
  -- open: raised, unsigned, deletable. reviewed: a second seat has read it and said so; it is then
  -- kept forever, like every other signed paper in this office.
  status text not null default 'open' check (status in ('open','reviewed')),
  raised_by uuid not null references users(id),
  raised_at timestamptz not null default now(),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  review_note text check (review_note is null
                           or char_length(trim(review_note)) between 8 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (from_day <= to_day),
  check (jsonb_typeof(examined) = 'object'),
  check (status <> 'reviewed' or (reviewed_by is not null and reviewed_at is not null
                                  and char_length(trim(coalesce(review_note, ''))) >= 8)),
  check ((reviewed_by is null) = (reviewed_at is null)),
  -- A run with no findings has nothing to net off, and a run that found something cannot claim zero
  -- by accident: the pair is a fact about the same set of rows, so the table makes them agree.
  check (findings > 0 or net_difference = 0)
);

create index money_recon_runs_board_idx
  on money_reconciliation_runs (tenant_id, status, raised_at desc);
create index money_recon_runs_scope_idx
  on money_reconciliation_runs (tenant_id, scope, raised_at desc);
create trigger trg_money_recon_runs_updated before update on money_reconciliation_runs
  for each row execute function public.set_updated_at();

alter table money_reconciliation_runs enable row level security;
create policy money_recon_runs_tenant on money_reconciliation_runs
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on money_reconciliation_runs to app_runtime;
revoke all on money_reconciliation_runs from public, anon, authenticated, service_role;

comment on column money_reconciliation_runs.examined is
  'The populations the run read and the sentences naming anything it left alone. A check that agrees writes no finding, so this is where its evidence lives.';
comment on column money_reconciliation_runs.net_difference is
  'Sum of (book − paper) over the findings written. Positive is the book claiming more than the papers say.';

-- ============================================================
-- 2. the findings: the exceptions only, with both figures
-- ============================================================

create table if not exists money_reconciliation_findings (
  id uuid primary key default gen_random_uuid(),
  -- Deferred, so a run can be written in the order it is thought: the door mints the run's id,
  -- counts the exceptions into this table, and only then inserts the run row carrying the figures
  -- its own findings add up to. That is what lets the guard below freeze those figures absolutely —
  -- there is no second statement that has to be allowed to edit them. The cascade still fires.
  run_id uuid not null references money_reconciliation_runs(id)
    on delete cascade deferrable initially deferred,
  -- Copied from the run by the door so the RLS predicate is one column, exactly as 134 copies a
  -- holder's name onto the paper that holds it.
  tenant_id uuid not null references tenants(id),
  line int not null check (line > 0),
  -- The question that failed, in the run's own vocabulary: `posting_square`, `payable_line_total`,
  -- `webhook_not_landed`. The shape is checked rather than an allowlist of nineteen names, because
  -- the doors are the only author and a new question must not need a migration of this table.
  check_name text not null check (check_name ~ '^[a-z][a-z0-9_]{2,39}$'),
  subject_kind text not null check (subject_kind in (
    'book','posting','account','wallet','escrow','payout','payout_batch','refund_paper',
    'payment','webhook','gateway_line','many')),
  -- A pointer at the paper, not a foreign key, for 133's reason: an erasure or a company removal
  -- must not be able to reach a report through a row it names. The ref is copied so the report still
  -- says what it was about after the paper is renamed.
  subject_id uuid,
  subject_ref text check (subject_ref is null
                           or char_length(trim(subject_ref)) between 1 and 60),
  -- The two sides of the equation, in the run's currency (or the run's own units where the check is
  -- a count, which the `why` sentence says out loud).
  book_figure numeric(14,2) not null default 0,
  paper_figure numeric(14,2) not null default 0,
  -- Derived by the table, never typed by the door: a finding whose difference does not follow from
  -- its own two figures is a finding that cannot be trusted, and there is no way to write one.
  difference numeric(14,2) generated always as (book_figure - paper_figure) stored,
  -- differs: both sides exist and disagree. missing_book: the paper says money, the book has never
  -- heard of it. missing_paper: the book carries a figure no paper stands behind. refused: the
  -- office turned a thing away and the report keeps the fact. stale: the office is holding something
  -- open past its own promise.
  verdict text not null check (verdict in (
    'differs','missing_book','missing_paper','refused','stale')),
  -- `why` is the sentence the desk reads and acts on, and the table refuses a finding without one.
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint money_recon_finding_line_per_run unique (run_id, line),
  check (jsonb_typeof(detail) = 'object'),
  check (char_length(trim(coalesce(detail ->> 'why', ''))) between 8 and 600)
);

create index money_recon_findings_run_idx on money_reconciliation_findings (run_id, line);
create index money_recon_findings_subject_idx
  on money_reconciliation_findings (subject_kind, subject_id) where subject_id is not null;

alter table money_reconciliation_findings enable row level security;
create policy money_recon_findings_tenant on money_reconciliation_findings
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on money_reconciliation_findings to app_runtime;
revoke all on money_reconciliation_findings from public, anon, authenticated, service_role;

comment on column money_reconciliation_findings.difference is
  'Generated: book_figure − paper_figure. The table will not hold a finding whose difference disagrees with its own figures.';

-- ============================================================
-- 3. the guards on both
-- ============================================================

-- A run's account of what it counted is frozen the moment it is written. What may change is the
-- review — that is the whole state machine — and nothing else: a run whose figures could be edited
-- after the second seat read it would make the signature a signature of different words.
create or replace function platform_auth.recon_run_keeps_its_account()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.ref <> old.ref or new.scope <> old.scope or new.currency <> old.currency
     or new.from_day <> old.from_day or new.to_day <> old.to_day
     or new.checks <> old.checks or new.findings <> old.findings
     or new.examined <> old.examined or new.net_difference <> old.net_difference
     or new.raised_by <> old.raised_by or new.raised_at <> old.raised_at then
    raise exception '135: % counted % from % to % and says so in the words it was written in. '
      'Raise a new run to count it differently',
      old.ref, old.scope, old.from_day, old.to_day using errcode = '23514';
  end if;
  if old.status = 'reviewed' then
    raise exception '135: % is signed off by % and does not move again. A later count is a later run',
      old.ref, coalesce((select u.full_name from users u where u.id = old.reviewed_by), 'a second seat')
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger money_recon_runs_keep_their_account
  before update on money_reconciliation_runs for each row
  execute function platform_auth.recon_run_keeps_its_account();

-- An open run is a rehearsal: the office may throw away its own draft count. A reviewed one is the
-- record of a check a seat signed for, and it is kept — with its findings, which is why the findings
-- are only deletable while their run is open (the guard below). Deleting an open run is the door's
-- act, and the audit row it writes survives the delete, so the office still knows the count happened.
create or replace function platform_auth.recon_run_is_kept_once_signed()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.status <> 'open' then
    raise exception '135: % was signed off on % by %. A count a seat has signed for is never erased; '
      'raise a newer run and say what changed',
      old.ref, old.reviewed_at, coalesce((select u.full_name from users u where u.id = old.reviewed_by),
                                        'a second seat')
      using errcode = '23514';
  end if;
  return old;
end $$;

create trigger money_recon_runs_are_kept
  before delete on money_reconciliation_runs for each row
  execute function platform_auth.recon_run_is_kept_once_signed();

-- A finding is what the run saw, so it is never rewritten. It goes when its run goes, and only while
-- the run is still a draft: the cascade is the sanctioned removal, and a signed run's findings cannot
-- be reached by it, because the run itself cannot be deleted.
create or replace function platform_auth.recon_findings_are_kept()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  if TG_OP = 'UPDATE' then
    raise exception '135: a finding of run % is what the count saw. Answer it with a new run, '
      'not by editing the report',
      (select r.ref from money_reconciliation_runs r where r.id = OLD.run_id)
      using errcode = '23514';
  end if;
  select status into v_status from money_reconciliation_runs where id = OLD.run_id;
  if v_status = 'reviewed' then
    raise exception '135: run % is signed off, and its findings go with it nowhere',
      (select r.ref from money_reconciliation_runs r where r.id = OLD.run_id)
      using errcode = '23514';
  end if;
  return old;
end $$;

create trigger money_recon_findings_are_kept
  before update or delete on money_reconciliation_findings for each row
  execute function platform_auth.recon_findings_are_kept();

-- ============================================================
-- 4. the retry ledger: a second attempt is a new fact
-- ============================================================

-- `payment_webhooks` is the rail's own register: 005 gives the app role INSERT and SELECT and nothing
-- else, because the rows are what a stranger can push at an open door. 135 does not weaken that. A
-- retry cannot mark a delivery "done" — it appends a row beside it saying that a seat re-drove the
-- completion, what the definer answered, and who sat there. A delivery with five attempts is the same
-- picture: the attempts are the pile, and none of them rewrites the thing the rail sent.
create table if not exists gateway_webhook_attempts (
  id uuid primary key default gen_random_uuid(),
  -- Whose desk attempted it. The office's, and the only tenant 135's gateway doors answer to.
  tenant_id uuid not null references tenants(id),
  webhook_id uuid not null references payment_webhooks(id) on delete cascade,
  -- 1 to 5, numbered by the door from the attempts already on the delivery. A ceiling is a rule, not
  -- a hint: a fifth failure means a human and a rail, not another tap at the same button.
  attempt int not null check (attempt between 1 and 5),
  -- succeeded: the completion landed now. already_final: the charge was already closed, so nothing
  -- moved — which is the honest answer of an idempotent door, not a failure. refused: the delivery
  -- was never an instruction (an unreadable payload, an unverified signature). failed: it was, and
  -- the definer could not close it.
  outcome text not null check (outcome in ('succeeded','already_final','refused','failed')),
  -- The reference and the payment's own state, copied at the moment of the attempt: the ledger has to
  -- be readable after the delivery's payload has been forgotten by everything else.
  intent_reference text,
  payment_status text,
  message text not null check (char_length(trim(message)) between 8 and 600),
  answer jsonb not null default '{}'::jsonb,
  acted_by uuid not null references users(id),
  acted_role text,
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),

  constraint gateway_webhook_attempt_numbered_per_delivery unique (webhook_id, attempt),
  check (jsonb_typeof(answer) = 'object'),
  -- A failure without a sentence is a retry that teaches the next seat nothing.
  check (outcome not in ('failed','refused')
         or char_length(trim(coalesce(message, ''))) >= 8),
  check ((payment_status is null) or payment_status in (
    'pending','approved','failed','timed_out','cancelled','refunded'))
);

create index gateway_webhook_attempts_delivery_idx
  on gateway_webhook_attempts (webhook_id, attempt);
create index gateway_webhook_attempts_recent_idx
  on gateway_webhook_attempts (tenant_id, created_at desc);

-- An attempt is a timestamped claim about a call that left the building. It is never edited. It has
-- no delete guard on purpose: the one sanctioned way an attempt disappears is the cascade from the
-- delivery it answers for, and a trigger that refused that would be a trigger that breaks the
-- foreign key's own promise. No client role holds DELETE on this table either.
create or replace function platform_auth.webhook_attempt_is_kept()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception '135: attempt % on delivery % said % and stays saying it. A later try is a new row',
    OLD.attempt, OLD.webhook_id, OLD.outcome using errcode = '23514';
end $$;

create trigger gateway_webhook_attempts_are_kept
  before update on gateway_webhook_attempts for each row
  execute function platform_auth.webhook_attempt_is_kept();

alter table gateway_webhook_attempts enable row level security;
create policy gateway_webhook_attempts_tenant on gateway_webhook_attempts
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on gateway_webhook_attempts to app_runtime;
revoke all on gateway_webhook_attempts from public, anon, authenticated, service_role;

comment on column gateway_webhook_attempts.outcome is
  'What the definer answered when the delivery was re-driven. `already_final` is 009''s idempotent answer, not a failure.';
comment on column gateway_webhook_attempts.webhook_id is
  'The delivery this attempt answers for. Removed only by the cascade from the delivery itself.';

-- ============================================================
-- 5. the count: twenty questions, asked of the book and the papers
-- ============================================================

/**
 * One act of counting.
 *
 * The shape is deliberate: every question is written as a SELECT of its *exceptions* and the twenty
 * are UNION ALLed into one INSERT, so a check that agrees writes nothing and the register ends up
 * holding exactly the list of things the office has to answer for. `examined` then carries what each
 * run looked at — the populations, the list of questions it was allowed to ask, and the sentences
 * naming anything it had to leave alone — which is the evidence a signing seat reads when the
 * findings list is empty. An empty report that does not say what it looked at is a claim, not a check.
 *
 * The questions, and what each one is really asking:
 *
 *   book    `book_sums_to_zero`     every leg ever written in this money nets debits against credits.
 *           `posting_square`        each movement in the window has two legs, both sides, and a
 *                                   header figure equal to its own debits (133's commit rule, re-asked
 *                                   from the outside — a trigger that got it wrong once is not undone
 *                                   by the fact that it fires).
 *           `account_totals`        the cached figures on a line still follow its legs.
 *   wallet  `wallet_overdrawn`      a holder's line cannot be paid out below nothing.
 *           `wallet_line_orphan`    a `WLT-…` line in the book with no wallet pointing at it.
 *           `wallet_heading`        money is held on each holder's own line, never on `WALLET-…`.
 *   escrow  `escrow_line_total`     what waits in `ESCROW-…` is what the live papers say waits.
 *           `escrow_paper_postings` a parked or paid-out hold has the movements it claims.
 *   payout  `payable_line_total`    `PAYOUT-DUE`/`REFUND-DUE` equals the signed-but-unpaid papers.
 *           `payout_paper_postings` each paper's accrual, payment or mirror is there, is the figure
 *                                   on the paper, and stands on the three accounts the paper names.
 *           `batch_totals`          the total a second seat signed is still its own lines' total.
 *   refund  `refund_paper_unpaid`   a signed 126 paper the office still owes and has never accrued.
 *           `refund_payout_paper`   a refund payout whose paper is gone, ungranted, or says another
 *                                   figure.
 *   gateway `webhook_unverified`    deliveries the platform could not verify, in the days asked about.
 *           `webhook_not_landed`    a verified delivery against a charge that still stands open,
 *                                   which the office never acted on — the pile 005's insert-only
 *                                   register could not otherwise show.
 *           `webhook_orphan`        a delivery whose reference belongs to no payment. The two are
 *                                   disjoint by the reference, so one delivery is never named twice
 *                                   for the same reason.
 *           `webhook_retries_spent` a delivery already re-driven five times and still open.
 *           `payment_stale`         a charge still `pending` past its own countdown (134's ten
 *                                   minutes, 009's door).
 *           `gateway_line_total`    what the rails confirmed against what the book's gateway line
 *                                   holds — the one place 135 states out loud that 005's licence
 *                                   money has never settled into the office's book.
 *
 * Nothing here writes money: no leg, no header, no cached total. A tool that finds drift must not be
 * the thing that edits it.
 */
create or replace function platform_auth.run_money_reconciliation(
  p_tenant uuid, p_scope text, p_currency text, p_from date, p_to date,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_scope  text := lower(trim(coalesce(p_scope, 'all')));
  v_cur    text := upper(trim(coalesce(p_currency, 'TZS')));
  v_from   date := p_from;
  v_to     date := p_to;
  v_run    uuid := gen_random_uuid();
  v_sfx    text;
  v_book   boolean;
  v_wallet boolean;
  v_escrow boolean;
  v_pay    boolean;
  v_ref    boolean;
  v_gate   boolean;
  v_rails  boolean;
  v_names  text[] := '{}'::text[];
  v_skip   jsonb := '[]'::jsonb;
  v_exam   jsonb;
  v_find   int := 0;
  v_net    numeric(14,2) := 0;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('ok', false, 'error', 'not_the_office',
      'message', 'A count is made of the office''s own book, and this session is not that book.');
  end if;
  if v_scope not in ('book','wallet','escrow','payout','refund','gateway','all') then
    return jsonb_build_object('ok', false, 'error', 'bad_scope', 'scope', v_scope,
      'message', 'Say what is being counted: the book, a wallet, escrow, a payout, a refund, the '
        || 'gateway, or all of it at once.');
  end if;
  if v_cur not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'bad_currency', 'currency', v_cur,
      'message', 'One money per count. The book holds two, and adding a difference in one to a '
        || 'difference in the other is how a report becomes unreadable.');
  end if;
  if v_from is null or v_to is null then
    return jsonb_build_object('ok', false, 'error', 'bad_days',
      'message', 'A count is asked of a window of days: the book is kept by day, and so is the pile '
        || 'of deliveries.');
  end if;
  if v_from > v_to then
    return jsonb_build_object('ok', false, 'error', 'bad_days', 'from_day', v_from, 'to_day', v_to,
      'message', 'The window runs backwards. The first day has to be the earlier one.');
  end if;
  if v_to > current_date then
    return jsonb_build_object('ok', false, 'error', 'bad_days', 'to_day', v_to,
      'message', 'There is no day ' || v_to || ' to count up to yet. A run is an account of days '
        || 'that have happened.');
  end if;

  v_sfx := case when v_cur = 'USD' then '-USD' else '' end;
  v_book   := v_scope in ('book','all');
  v_wallet := v_scope in ('wallet','all');
  v_escrow := v_scope in ('escrow','all');
  v_pay    := v_scope in ('payout','all');
  v_ref    := v_scope in ('refund','all');
  v_gate   := v_scope in ('gateway','all');

  -- The rails' money questions need a rail. With nothing switched on at the desk, a payment left
  -- `pending` is the mock door's answer rather than the office's, and `GATE-WAIT` has no inbound
  -- money to be compared against — so both are refused out loud instead of reported as drift.
  v_rails := v_gate and v_cur = 'TZS';
  if v_gate and v_cur = 'USD' then
    v_skip := v_skip || jsonb_build_array(
      'the rails were not asked about money: 005 takes TZS only, and this book has no USD gateway '
      || 'line to compare a rail against');
  end if;
  if v_rails and not exists (select 1 from platform_auth.active_payment_gateway()) then
    v_skip := v_skip || jsonb_build_array(
      'no rail is switched on at the desk, so a charge left pending is the sandbox door''s answer '
      || 'and not the office''s: the pending charges and the gateway line were not asked about');
    v_rails := false;
  end if;

  if v_book   then v_names := v_names || array['book_sums_to_zero','posting_square','account_totals']; end if;
  if v_wallet then v_names := v_names || array['wallet_overdrawn','wallet_line_orphan','wallet_heading']; end if;
  if v_escrow then v_names := v_names || array['escrow_line_total','escrow_paper_postings']; end if;
  if v_pay    then v_names := v_names || array['payable_line_total','payout_paper_postings','batch_totals']; end if;
  if v_ref    then v_names := v_names || array['refund_paper_unpaid','refund_payout_paper']; end if;
  if v_gate   then v_names := v_names || array['webhook_unverified','webhook_not_landed',
                                               'webhook_orphan','webhook_retries_spent']; end if;
  if v_rails  then v_names := v_names || array['payment_stale','gateway_line_total']; end if;

  -- ------------------------------------------------------------
  -- the exceptions, in one set
  -- ------------------------------------------------------------
  insert into money_reconciliation_findings
    (id, run_id, tenant_id, line, check_name, subject_kind, subject_id, subject_ref,
     book_figure, paper_figure, verdict, detail)
  select gen_random_uuid(), v_run, p_tenant,
         row_number() over (order by x.check_name, x.subject_kind, x.subject_ref nulls first),
         x.check_name, x.subject_kind, x.subject_id, x.subject_ref,
         x.book_figure, x.paper_figure, x.verdict, x.detail
    from (
      -- 1. the whole book nets to nothing, or it does not.
      select 'book_sums_to_zero'::text             as check_name,
             'book'::text                          as subject_kind,
             null::uuid                            as subject_id,
             null::text                            as subject_ref,
             coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)::numeric(14,2)
                                                   as book_figure,
             coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2)
                                                   as paper_figure,
             'differs'::text                       as verdict,
             jsonb_build_object(
               'why', 'The ' || v_cur || ' book carries '
                   || platform_auth.money_figure(coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0))
                   || ' debited against '
                   || platform_auth.money_figure(coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0))
                   || ' credited over ' || count(*)::text || ' leg(s). Every movement is two sides, '
                   || 'so ' || platform_auth.money_figure(abs(
                        coalesce(sum(e.amount) filter (where e.direction = 'debit'), 0)
                      - coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)))
                   || ' is unaccounted for.',
               'currency', v_cur, 'legs', count(*)::int)      as detail
        from money_entries e
        join money_postings p on p.id = e.posting_id
       where v_book and p.tenant_id = p_tenant and p.currency = v_cur
       having coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)
           <> coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)

      union all

      -- 2. each movement in the window still says what its own legs say.
      select 'posting_square', 'posting', p.id, p.ref, p.total, coalesce(x.debits, 0),
             'differs',
             jsonb_build_object(
               'why', p.ref || ' of ' || to_char(p.posted_on, 'YYYY-MM-DD') || ' says it moved '
                   || platform_auth.money_figure(p.total) || ' and carries ' || coalesce(x.legs, 0)::text
                   || ' leg(s): ' || platform_auth.money_figure(coalesce(x.debits, 0)) || ' out, '
                   || platform_auth.money_figure(coalesce(x.credits, 0)) || ' in. '
                   || case
                        when coalesce(x.legs, 0) < 2
                          then 'A movement needs both sides, so this one is half-written.'
                        when coalesce(x.debits, 0) = 0 or coalesce(x.credits, 0) = 0
                          then 'Every leg is on one side.'
                        when x.debits <> x.credits
                          then 'The two sides are not equal.'
                        else 'The header''s figure is not its own debits.'
                      end,
               'memo', p.memo, 'currency', p.currency, 'status', p.status,
               'credits', coalesce(x.credits, 0), 'legs', coalesce(x.legs, 0),
               'source_kind', p.source_kind, 'source_ref', p.source_ref)
        from money_postings p
        left join (
          select e.posting_id,
                 count(*)::int                                                          as legs,
                 coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)::numeric(14,2) as debits,
                 coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2) as credits
            from money_entries e
           group by e.posting_id
        ) x on x.posting_id = p.id
       where v_book and p.tenant_id = p_tenant and p.currency = v_cur
         and p.posted_on between v_from and v_to
         and (coalesce(x.legs, 0) < 2 or coalesce(x.debits, 0) = 0 or coalesce(x.credits, 0) = 0
              or x.debits <> x.credits or p.total <> coalesce(x.debits, 0))

      union all

      -- 3. a line's cached figures still follow its legs. The pair printed here is the debits; the
      -- credits and the count ride in the sentence, because all three are kept by the same trigger.
      select 'account_totals', 'account', a.id, a.code, a.debit_total, coalesce(r.debits, 0),
             'differs',
             jsonb_build_object(
               'why', a.code || ' (' || a.label || ') says ' || platform_auth.money_figure(a.debit_total)
                   || ' debited and ' || platform_auth.money_figure(a.credit_total) || ' credited over '
                   || a.entry_count::text || ' leg(s); its own legs add up to '
                   || platform_auth.money_figure(coalesce(r.debits, 0)) || ' and '
                   || platform_auth.money_figure(coalesce(r.credits, 0)) || ' over '
                   || coalesce(r.n, 0)::text || '. The figures the register prints are kept by a '
                   || 'trigger, and this line has stopped agreeing with them.',
               'label', a.label, 'kind', a.kind, 'status', a.status,
               'credit_cached', a.credit_total, 'credit_legs', coalesce(r.credits, 0),
               'count_cached', a.entry_count, 'count_legs', coalesce(r.n, 0))
        from money_accounts a
        left join (
          select e.account_id,
                 coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)::numeric(14,2) as debits,
                 coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2) as credits,
                 count(*)::int as n
            from money_entries e
           group by e.account_id
        ) r on r.account_id = a.id
       where v_book and a.tenant_id = p_tenant and a.currency = v_cur
         and (a.debit_total <> coalesce(r.debits, 0) or a.credit_total <> coalesce(r.credits, 0)
              or a.entry_count <> coalesce(r.n, 0))

      union all

      -- 4. a holder's line cannot be paid below nothing. The office owes this money; it cannot owe
      -- less than zero of it.
      select 'wallet_overdrawn', 'wallet', w.id, a.code, n.net, 0,
             'differs',
             jsonb_build_object(
               'why', 'The ' || w.currency || ' line held for ' || w.holder_name || ' (' || a.code
                   || ') is ' || platform_auth.money_figure(abs(n.net))
                   || ' overdrawn: more has left it than the book has ever been told came in. '
                   || 'A payment out of a wallet is a claim this office cannot make.',
               'holder', w.holder_name, 'account', a.code, 'wallet_status', w.status)
        from money_wallets w
        join money_accounts a on a.id = w.account_id
        cross join lateral (
          select coalesce(sum(case when e.direction = 'credit' then e.amount else -e.amount end),
                         0)::numeric(14,2) as net
            from money_entries e where e.account_id = w.account_id
        ) n
       where v_wallet and w.tenant_id = p_tenant and w.currency = v_cur and n.net < 0

      union all

      -- 5. a wallet line in the book that no wallet in the register points at.
      select 'wallet_line_orphan', 'account', a.id, a.code, n.net, 0,
             'missing_paper',
             jsonb_build_object(
               'why', a.code || ' is a wallet line in the book — '
                   || platform_auth.money_figure(n.net) || ' held — and no row in the wallet register '
                   || 'names it. Money is standing in the office for somebody the office cannot name.',
               'label', a.label, 'opened_at', a.opened_at)
        from money_accounts a
        left join money_wallets w on w.account_id = a.id
        cross join lateral (
          select coalesce(sum(case when e.direction = 'credit' then e.amount else -e.amount end),
                         0)::numeric(14,2) as net
            from money_entries e where e.account_id = a.id
        ) n
       where v_wallet and a.tenant_id = p_tenant and a.currency = v_cur
         and a.code like 'WLT-%' and w.id is null

      union all

      -- 6. the heading is a heading. `WALLET-…` groups the holders' lines on the chart and carries no
      -- money of its own; a leg that landed on it means something moved twice, or moved nowhere.
      select 'wallet_heading', 'account', a.id, a.code, n.debits, n.credits,
             'differs',
             jsonb_build_object(
               'why', a.code || ' is the heading the ' || v_cur || ' wallet lines sit under, and it '
                   || 'carries ' || n.n::text || ' leg(s) of its own: '
                   || platform_auth.money_figure(n.debits) || ' debited, '
                   || platform_auth.money_figure(n.credits) || ' credited. A holder''s money lives on '
                   || 'its own WLT- line, so this is money booked twice or booked nowhere.',
               'label', a.label)
        from money_accounts a
        cross join lateral (
          select count(*)::int                                                                  as n,
                 coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)::numeric(14,2) as debits,
                 coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2) as credits
            from money_entries e where e.account_id = a.id
        ) n
       where v_wallet and a.tenant_id = p_tenant and a.currency = v_cur
         and a.code = 'WALLET-' || v_cur and n.n > 0

      union all

      -- 7. what waits in escrow is what the live papers say waits.
      select 'escrow_line_total', 'account', a.id, a.code, n.net, coalesce(h.held, 0),
             'differs',
             jsonb_build_object(
               'why', a.code || ' holds ' || platform_auth.money_figure(n.net) || ' and the '
                   || coalesce(h.papers, 0)::text || ' hold paper(s) in `held` or `pending_discharge` '
                   || 'add up to ' || platform_auth.money_figure(coalesce(h.held, 0))
                   || '. Money leaves escrow only on a signed plan whose figures are the whole hold, '
                   || 'so the two cannot legitimately differ.',
               'papers', coalesce(h.papers, 0), 'label', a.label)
        from money_accounts a
        cross join lateral (
          select coalesce(sum(case when e.direction = 'credit' then e.amount else -e.amount end),
                         0)::numeric(14,2) as net
            from money_entries e where e.account_id = a.id
        ) n
        cross join (
          select coalesce(sum(x.amount), 0)::numeric(14,2) as held, count(*)::int as papers
            from money_escrow_holds x
           where x.tenant_id = p_tenant and x.currency = v_cur
             and x.status in ('held','pending_discharge')
        ) h
       where v_escrow and a.tenant_id = p_tenant and a.currency = v_cur
         and a.code = 'ESCROW-' || v_cur
         and n.net <> coalesce(h.held, 0)

      union all

      -- 8. a hold's own paper and its movements agree.
      select 'escrow_paper_postings', 'escrow', h.id, h.ref,
             coalesce(op.total, 0), h.amount,
             case when h.status in ('held','pending_discharge','discharged')
                   and h.hold_posting_id is null
                  then 'missing_book'::text else 'differs'::text end,
             jsonb_build_object(
               'why', h.ref || ' (' || h.status || ', ' || platform_auth.money_figure(h.amount)
                   || ' against ' || coalesce(h.subject_ref, h.subject_kind) || ') — '
                   || concat_ws(' · ',
                        case when h.status <> 'raised' and h.hold_posting_id is null
                             then 'the paper says the money is parked and the book has no movement behind it' end,
                        case when h.status = 'raised' and h.hold_posting_id is not null
                             then 'a paper nobody has held yet already books ' || op.ref end,
                        case when h.status = 'discharged' and h.discharge_posting_id is null
                             then 'the plan was signed and no discharge movement exists' end,
                        case when op.total is not null and op.total <> h.amount
                             then 'the hold movement says ' || platform_auth.money_figure(op.total)
                                  || ' and the paper says ' || platform_auth.money_figure(h.amount) end,
                        case when dp.total is not null and dp.total <> h.amount
                             then 'the discharge movement says ' || platform_auth.money_figure(dp.total)
                                  || ' and the paper holds ' || platform_auth.money_figure(h.amount) end),
               'status', h.status, 'subject_kind', h.subject_kind, 'subject_ref', h.subject_ref,
               'hold_posting', op.ref, 'hold_posting_status', op.status,
               'discharge_posting', dp.ref, 'discharge_kind', h.discharge_kind)
        from money_escrow_holds h
        left join money_postings op on op.id = h.hold_posting_id
        left join money_postings dp on dp.id = h.discharge_posting_id
       where v_escrow and h.tenant_id = p_tenant and h.currency = v_cur
         and (   (h.status <> 'raised' and h.hold_posting_id is null)
              or (h.status =  'raised' and h.hold_posting_id is not null)
              or (h.status =  'discharged' and h.discharge_posting_id is null)
              or (op.total is not null and op.total <> h.amount)
              or (dp.total is not null and dp.total <> h.amount))

      union all

      -- 9. what the office has agreed to pay and has not paid, line by line.
      select 'payable_line_total', 'account', a.id, a.code, n.net, coalesce(s.due, 0),
             'differs',
             jsonb_build_object(
               'why', a.code || ' owes ' || platform_auth.money_figure(n.net) || ' and the '
                   || coalesce(s.papers, 0)::text || ' payout paper(s) standing on it in `released` '
                   || 'come to ' || platform_auth.money_figure(coalesce(s.due, 0))
                   || ' including their charges. A signed paper accrues once and is answered once, '
                   || 'either by the cash leaving or by its mirror.',
               'label', a.label, 'papers', coalesce(s.papers, 0), 'account_status', a.status)
        from money_accounts a
        cross join lateral (
          select coalesce(sum(case when e.direction = 'credit' then e.amount else -e.amount end),
                         0)::numeric(14,2) as net
            from money_entries e where e.account_id = a.id
        ) n
        cross join lateral (
          select coalesce(sum(p.amount + p.fee_amount), 0)::numeric(14,2) as due,
                 count(*)::int as papers
            from money_payouts p
           where p.tenant_id = p_tenant and p.payable_account_id = a.id and p.status = 'released'
        ) s
       where v_pay and a.tenant_id = p_tenant and a.currency = v_cur
         and a.code in ('PAYOUT-DUE' || v_sfx, 'REFUND-DUE' || v_sfx)
         and n.net <> coalesce(s.due, 0)

      union all

      -- 10. each payout paper and the movements it claims. This is where 134's two moments are
      -- re-counted from the outside: the accrual a signature released, the payment the rail answered
      -- with, the mirror a failure answered with, and the three accounts the paper names.
      select 'payout_paper_postings', 'payout', p.id, p.ref,
             coalesce(ac.total, 0), p.amount + p.fee_amount,
             case when p.status in ('released','paid','failed') and p.accrual_posting_id is null
                  then 'missing_book'::text else 'differs'::text end,
             jsonb_build_object(
               'why', p.ref || ' (' || p.status || ', pays ' || left(p.payee_name, 40) || ' on '
                   || p.rail_code || ') — '
                   || concat_ws(' · ',
                        case when p.status <> 'raised' and p.accrual_posting_id is null
                             then 'no accrual movement stands on the paper' end,
                        case when ac.total is not null and ac.total <> p.amount + p.fee_amount
                             then 'the accrual says ' || platform_auth.money_figure(ac.total)
                                  || ' and the paper owes '
                                  || platform_auth.money_figure(p.amount + p.fee_amount) end,
                        case when ac.total is not null and al.fund_dr = 0
                             then 'no leg of the accrual is on the funding line the paper names' end,
                        case when ac.total is not null and al.pay_cr = 0
                             then 'no leg of the accrual is on the payable line the paper names' end,
                        case when p.status = 'paid' and p.payment_posting_id is null
                             then 'the desk says the cash left and no payment movement exists' end,
                        case when py.total is not null and py.total <> p.amount + p.fee_amount
                             then 'the payment movement says ' || platform_auth.money_figure(py.total)
                                  || ' and the paper owes '
                                  || platform_auth.money_figure(p.amount + p.fee_amount) end,
                        case when p.status = 'failed' and ac.status <> 'reversed'
                             then 'the rail refused and the accrual was never answered by its mirror' end,
                        case when p.status = 'failed' and ac.status = 'reversed' and mir.id is null
                             then 'the accrual is marked reversed with no mirror movement behind it' end,
                        case when p.status in ('raised','pending_signature','declined')
                                  and p.accrual_posting_id is not null
                             then 'a paper that never spent a signature has booked ' || ac.ref end),
               'status', p.status, 'amount', p.amount, 'fee', p.fee_amount,
               'accrual', ac.ref, 'accrual_status', ac.status, 'payment', py.ref,
               'source_kind', p.source_kind, 'source_ref', p.source_ref,
               'batch', (select b.ref from money_payout_batches b where b.id = p.batch_id))
        from money_payouts p
        left join money_postings ac on ac.id = p.accrual_posting_id
        left join money_postings py on py.id = p.payment_posting_id
        left join money_postings mir on mir.source_kind = 'reversal'
                                     and mir.source_id = p.accrual_posting_id
        left join lateral (
          select count(*) filter (where e.direction = 'debit'
                                       and e.account_id = p.fund_account_id)::int    as fund_dr,
                 count(*) filter (where e.direction = 'credit'
                                       and e.account_id = p.payable_account_id)::int as pay_cr
            from money_entries e where e.posting_id = p.accrual_posting_id
        ) al on true
       where v_pay and p.tenant_id = p_tenant and p.currency = v_cur
         and (   (p.status <> 'raised' and p.accrual_posting_id is null)
              or (p.status in ('raised','pending_signature','declined')
                  and p.accrual_posting_id is not null)
              or (ac.total is not null and ac.total <> p.amount + p.fee_amount)
              or (ac.total is not null and (al.fund_dr = 0 or al.pay_cr = 0))
              or (p.status = 'paid' and p.payment_posting_id is null)
              or (py.total is not null and py.total <> p.amount + p.fee_amount)
              or (p.status = 'failed' and ac.id is not null and ac.status <> 'reversed')
              or (p.status = 'failed' and ac.status = 'reversed' and mir.id is null))

      union all

      -- 11. the total a second seat signed is still its own lines' total.
      select 'batch_totals', 'payout_batch', b.id, b.ref, b.total_amount, coalesce(s.total, 0),
             'differs',
             jsonb_build_object(
               'why', b.ref || ' was signed at ' || platform_auth.money_figure(b.total_amount)
                   || ' over ' || b.lines::text || ' line(s) and its lines come to '
                   || platform_auth.money_figure(coalesce(s.total, 0)) || ' over '
                   || coalesce(s.n, 0)::text || '. A batch''s total is the figure the second seat '
                   || 'read, so a line that has moved under it makes the signature a signature of '
                   || 'other words.',
               'status', b.status, 'label', b.label, 'lines_now', coalesce(s.n, 0))
        from money_payout_batches b
        left join lateral (
          select coalesce(sum(p.amount + p.fee_amount), 0)::numeric(14,2) as total,
                 count(*)::int as n
            from money_payouts p where p.batch_id = b.id
        ) s on true
       where v_pay and b.tenant_id = p_tenant and b.currency = v_cur
         and b.status in ('pending_signature','released','closed')
         and (b.total_amount <> coalesce(s.total, 0) or b.lines <> coalesce(s.n, 0))

      union all

      -- 12. the refunds the office signed and has never accrued. 126 says a caller is owed; this is
      -- the queue that owes it, read against 134's papers rather than against a colour on a screen.
      select 'refund_paper_unpaid', 'refund_paper', f.id, f.ref, 0, f.amount,
             'missing_book',
             jsonb_build_object(
               'why', f.ref || ' was released for ' || platform_auth.money_figure(f.amount) || ' '
                   || f.currency || ' to ' || left(f.company_name, 40) || ' and no payout in the '
                   || 'office''s book stands on it. The office has signed a promise the book has '
                   || 'never been told about.',
               'company', f.company_name, 'pay_back', f.pay_back, 'released_at', f.released_at,
               'ticket', f.ticket_ref, 'currency', f.currency)
        from service_refund_requests f
       where v_ref and f.currency = v_cur and f.status = 'released'
         and not exists (select 1 from money_payouts p
                          where p.source_kind = 'refund' and p.source_id = f.id
                            and p.status in ('released','paid'))

      union all

      -- 13. a refund payout whose paper is gone, ungranted, or says another figure. The trigger that
      -- refuses this at write time cannot help a paper that was voided afterwards.
      select 'refund_payout_paper', 'payout', p.id, p.ref,
             p.amount + p.fee_amount, coalesce(f.amount, 0),
             case when f.id is null then 'missing_paper'::text else 'differs'::text end,
             jsonb_build_object(
               'why', p.ref || ' is raised as a refund and '
                   || concat_ws(' ',
                        case when f.id is null then 'the paper it names is gone.'
                             when f.status <> 'released'
                             then 'the paper is ' || f.status || ', which owes nobody anything.'
                             when p.amount <> f.amount
                             then 'the paper was signed for ' || platform_auth.money_figure(f.amount)
                                  || ' and this payout is ' || platform_auth.money_figure(p.amount) || '.'
                             when p.currency <> f.currency
                             then 'the paper is in ' || f.currency || ' and this payout in '
                                  || p.currency || '.'
                             else 'the two disagree somewhere the desk has to read.' end),
               'paper', f.ref, 'paper_status', f.status, 'paper_amount', f.amount,
               'company', f.company_name, 'payout_status', p.status)
        from money_payouts p
        left join service_refund_requests f on f.id = p.source_id
       where v_ref and p.tenant_id = p_tenant and p.currency = v_cur and p.source_kind = 'refund'
         and (f.id is null or f.status <> 'released' or p.amount <> f.amount
              or p.currency <> f.currency)

      union all

      -- 14. deliveries the platform could not verify. Each is a fact the security desk wants, in the
      -- days asked about; the newest twenty-five per provider are listed and the rest are counted.
      select 'webhook_unverified', 'webhook', w.id,
             nullif(left(trim(coalesce(w.payload ->> 'reference', '')), 60), ''), 0, 0,
             'refused',
             jsonb_build_object(
               'why', 'A delivery from ' || w.provider || ' on '
                   || to_char(w.created_at, 'YYYY-MM-DD HH24:MI') || ' was signed with a key that is '
                   || 'not this rail''s, so nothing was completed from it. It is ' || w.event_type
                   || ' and it is kept here because a pile of them is somebody knocking.',
               'provider', w.provider, 'event', w.event_type, 'nonce', w.replay_nonce,
               'at', w.created_at)
        from (
          select x.id, x.provider, x.event_type, x.payload, x.replay_nonce, x.created_at,
                 row_number() over (partition by x.provider order by x.created_at desc) as rn
            from payment_webhooks x
           where not x.signature_valid
             and x.created_at::date between v_from and v_to
        ) w
       where v_gate and w.rn <= 25

      union all

      -- 14b. the same question when it has more answers than a page.
      select 'webhook_unverified', 'many', null, left(t.provider, 60), 0, 0,
             'refused',
             jsonb_build_object(
               'why', t.total::text || ' unverified deliveries from ' || t.provider || ' in these '
                   || 'days. The newest 25 are listed and these ' || (t.total - 25)::text
                   || ' more are not. Nobody paid them any attention: check the key on the rail.',
               'provider', t.provider, 'exceptions', t.total)
        from (
          select x.provider, count(*)::int as total
            from payment_webhooks x
           where not x.signature_valid
             and x.created_at::date between v_from and v_to
           group by x.provider
          having count(*) > 25
        ) t
       where v_gate

      union all

      -- 15. a delivery the platform verified and then did not act on. `payment_webhooks` cannot be
      -- updated by anybody, so this is the only way the stuck pile becomes visible.
      -- The join is inner on purpose. A delivery that names no charge is 16's finding, and raising the
      -- same orphan twice would make this run's exception count a number the desk cannot act on — and
      -- the sentence below could only say "no charge carries that reference", which 16 already says
      -- better. This check is about a charge that exists and is still open.
      select 'webhook_not_landed', 'webhook', w.id,
             left(trim(w.payload ->> 'reference'), 60),
             0, pay.amount, 'missing_book',
             jsonb_build_object(
               'why', 'A verified delivery reached the platform on '
                   || to_char(w.created_at, 'YYYY-MM-DD HH24:MI') || ' and the office never acted on '
                   || 'it' || case when coalesce(w.processing_error, '') <> ''
                                   then ': ' || left(w.processing_error, 240)
                                   else ' and no reason was recorded — the write of the outcome '
                                     || 'itself failed' end
                   || '. ' || pay.intent_reference || ' is still ' || pay.status || ' for '
                   || platform_auth.money_figure(pay.amount) || ' ' || pay.currency || '.',
               'provider', w.provider, 'event', w.event_type,
               'outcome_wanted', w.payload ->> 'outcome', 'error', w.processing_error,
               'payment_status', pay.status, 'attempts',
                 (select count(*)::int from gateway_webhook_attempts a where a.webhook_id = w.id))
        from payment_webhooks w
        join payments pay
          on pay.intent_reference = nullif(trim(coalesce(w.payload ->> 'reference', '')), '')
       where v_gate and w.signature_valid and w.processed_at is null
         and w.created_at::date between v_from and v_to

      union all

      -- 16. a delivery whose reference belongs to no charge, or that carries no reference at all.
      select 'webhook_orphan', 'webhook', w.id,
             coalesce(nullif(left(trim(coalesce(w.payload ->> 'reference', '')), 60), ''),
                      left(w.provider || ' no reference', 60)),
             0, 0, 'missing_paper',
             jsonb_build_object(
               'why', 'A verified delivery on ' || to_char(w.created_at, 'YYYY-MM-DD HH24:MI')
                   || ' ' || case when coalesce(w.payload ->> 'reference', '') = ''
                                  then 'carries no reference at all, so there is nothing here for a '
                                       || 'seat to re-drive.'
                                  else 'names ' || left(w.payload ->> 'reference', 40)
                                       || ', which is not a charge this platform has ever raised. '
                                       || 'A rail does not invent a reference it never pushed.' end,
               'provider', w.provider, 'event', w.event_type, 'payload_ref',
                 left(coalesce(w.payload ->> 'reference', ''), 60))
        from payment_webhooks w
       where v_gate and w.signature_valid
         and w.created_at::date between v_from and v_to
         and (coalesce(w.payload ->> 'reference', '') = ''
              or not exists (select 1 from payments p
                              where p.intent_reference = w.payload ->> 'reference'))

      union all

      -- 17. a delivery re-driven five times and still open: the retry door will not touch it, and a
      -- person has to talk to the rail.
      select 'webhook_retries_spent', 'webhook', w.id,
             nullif(left(trim(coalesce(w.payload ->> 'reference', '')), 60), ''), 0,
             coalesce(pay.amount, 0), 'stale',
             jsonb_build_object(
               'why', 'This delivery has been re-driven ' || t.n::text || ' times, last on '
                   || to_char(t.last_at, 'YYYY-MM-DD HH24:MI') || ', and the charge is still '
                   || coalesce(pay.status, 'unknown to the office') || '. Five attempts is the '
                   || 'ceiling, so the next answer has to come from the rail, not from the desk.',
               'attempts', t.n, 'last_attempt_at', t.last_at, 'payment_status', pay.status,
               'provider', w.provider)
        from payment_webhooks w
        join (select a.webhook_id, count(*)::int as n, max(a.created_at) as last_at
                from gateway_webhook_attempts a
               group by a.webhook_id) t on t.webhook_id = w.id
        left join payments pay
          on pay.intent_reference = nullif(trim(coalesce(w.payload ->> 'reference', '')), '')
       where v_gate and t.n >= 5 and w.processed_at is null
         and w.created_at::date between v_from and v_to

      union all

      -- 18. a charge the office is still holding open past its own countdown. 005's ten-minute window
      -- is expired lazily by whoever asks, so a charge nobody polls stays `pending` forever.
      select 'payment_stale', 'payment', p.id, p.intent_reference, 0, p.amount, 'stale',
             jsonb_build_object(
               'why', p.intent_reference || ' has stood pending on ' || p.provider || ' for '
                   || floor(extract(epoch from (now() - p.requested_at)) / 60)::int::text
                   || ' minutes for ' || platform_auth.money_figure(p.amount) || ' ' || p.currency
                   || ', past the ten minutes the customer was promised. Nothing in the book has '
                   || 'ever been told about this money.',
               'provider', p.provider, 'requested_at', p.requested_at, 'invoice',
                 (select i.number from invoices i where i.id = p.invoice_id),
               'tenant', (select t.name from tenants t where t.id = p.tenant_id))
        from payments p
       where v_rails and p.currency = v_cur and p.status = 'pending'
         and p.requested_at < now() - interval '10 minutes'
         and p.requested_at::date between v_from and v_to

      union all

      -- 19. the gateway line against the money the rails confirmed. This is the one question 135 asks
      -- that the office cannot answer by fixing a row: 005's licence money has never settled into the
      -- book, so the line can only ever go down. It is reported as the gap it is.
      select 'gateway_line_total', 'gateway_line', a.id, a.code, n.net, coalesce(t.confirmed, 0),
             'differs',
             jsonb_build_object(
               'why', a.code || ' carries ' || platform_auth.money_figure(n.net) || ' taken out of '
                   || 'the rails'' money and the rails confirmed '
                   || platform_auth.money_figure(coalesce(t.confirmed, 0)) || ' in these days. '
                   || 'The book has never been told about a licence payment: 005''s charges settle '
                   || 'into the office''s ledger in a later stage, so this line has receipts with '
                   || 'nothing behind them.',
               'confirmed_papers', coalesce(t.papers, 0), 'label', a.label,
               'live_rail', (select g.provider_key from payment_gateways g where g.enabled limit 1))
        from money_accounts a
        cross join lateral (
          select coalesce(sum(case when e.direction = 'debit' then e.amount else -e.amount end),
                         0)::numeric(14,2) as net
            from money_entries e where e.account_id = a.id
        ) n
        cross join (
          select coalesce(sum(p.amount), 0)::numeric(14,2) as confirmed, count(*)::int as papers
            from payments p
           where p.status in ('approved','refunded') and p.currency = 'TZS'
             and p.requested_at::date between v_from and v_to
        ) t
       where v_rails and a.tenant_id = p_tenant and a.currency = v_cur and a.code = 'GATE-WAIT'
         and n.net <> coalesce(t.confirmed, 0)
    ) x;

  get diagnostics v_find = row_count;

  select coalesce(sum(f.difference), 0)::numeric(14,2) into v_net
    from money_reconciliation_findings f where f.run_id = v_run;

  ------------------------------------------------------------
  -- what the count looked at, so that a clean report is evidence and not a claim
  ------------------------------------------------------------
  select jsonb_strip_nulls(jsonb_build_object(
    'questions', (select jsonb_agg(n.name order by n.name) from unnest(v_names) as n(name)),
    'basis', 'the window bounds the book''s days and the rails'' arrivals; a register check is '
      || 'made over the whole register, because both sides of every equation here are whole facts',
    'postings', case when v_book then (select count(*)::int from money_postings q
                       where q.tenant_id = p_tenant and q.currency = v_cur
                         and q.posted_on between v_from and v_to) end,
    'legs', case when v_book then (select count(*)::int from money_entries e
                       join money_postings q on q.id = e.posting_id
                      where q.tenant_id = p_tenant and q.currency = v_cur
                        and q.posted_on between v_from and v_to) end,
    'accounts', case when v_book then (select count(*)::int from money_accounts q
                       where q.tenant_id = p_tenant and q.currency = v_cur) end,
    'wallets', case when v_wallet then (select count(*)::int from money_wallets q
                       where q.tenant_id = p_tenant and q.currency = v_cur) end,
    'wallet_lines', case when v_wallet then (select count(*)::int from money_accounts q
                       where q.tenant_id = p_tenant and q.currency = v_cur
                         and q.code like 'WLT-%') end,
    'holds', case when v_escrow then (select count(*)::int from money_escrow_holds q
                       where q.tenant_id = p_tenant and q.currency = v_cur) end,
    'payouts', case when v_pay then (select count(*)::int from money_payouts q
                       where q.tenant_id = p_tenant and q.currency = v_cur) end,
    'batches', case when v_pay then (select count(*)::int from money_payout_batches q
                       where q.tenant_id = p_tenant and q.currency = v_cur) end,
    'refund_papers', case when v_ref then (select count(*)::int from service_refund_requests q
                       where q.currency = v_cur) end,
    'deliveries', case when v_gate then (select count(*)::int from payment_webhooks q
                       where q.created_at::date between v_from and v_to) end,
    'attempts', case when v_gate then (select count(*)::int from gateway_webhook_attempts q
                       where q.created_at::date between v_from and v_to) end,
    'payments', case when v_rails then (select count(*)::int from payments q
                       where q.currency = v_cur
                         and q.requested_at::date between v_from and v_to) end,
    'skipped', case when jsonb_array_length(v_skip) > 0 then v_skip end
  )) into v_exam;

  insert into money_reconciliation_runs
    (id, tenant_id, ref, scope, currency, from_day, to_day, examined, checks, findings,
     net_difference, raised_by)
  values (v_run, p_tenant,
          'REC-' || to_char(now(), 'YYYY') || '-'
              || lpad(nextval('recon_run_number_seq')::text, 5, '0'),
          v_scope, v_cur, v_from, v_to, v_exam,
          coalesce(array_length(v_names, 1), 0), v_find, v_net, p_actor);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_reconciliation_runs', v_run, 'recon.raised', null,
    jsonb_build_object('scope', v_scope, 'currency', v_cur, 'from_day', v_from, 'to_day', v_to,
      'questions', coalesce(array_length(v_names, 1), 0), 'findings', v_find,
      'net_difference', v_net,
      'worst', coalesce((select jsonb_agg(f.check_name order by abs(f.difference) desc nulls last)
                          from (select f2.check_name, f2.difference
                                  from money_reconciliation_findings f2
                                 where f2.run_id = v_run
                                 order by abs(f2.difference) desc nulls last limit 5) f), '[]'::jsonb)));

  return jsonb_build_object('ok', true,
    'run', platform_auth.money_recon_detail(p_tenant, v_run));
end $$;

-- ============================================================
-- 6. the second seat: a count is worth what it says once somebody has signed for it
-- ============================================================

/**
 * Read the run, then sign for it.
 *
 * The two-seat rule is stated here rather than routed through 121's `platform_approvals`, and the
 * difference is real: a run proposes nothing, spends no money and has no payload whose figure could
 * later be quietly changed under a signature that was given for another one. What is being signed is
 * a reading, so the door carries the reading's own facts — the raiser's name, the findings' count and
 * the net — into the audit row beside the note, and refuses the seat that raised the count.
 *
 * Once it is signed, 135's first guard owns the row: the figures cannot move and the run cannot be
 * deleted, because both of those are ways of un-signing a sentence a second seat already answered for.
 */
create or replace function platform_auth.sign_money_reconciliation_run(
  p_tenant uuid, p_run uuid, p_note text, p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_run   money_reconciliation_runs%rowtype;
  v_note  text := left(trim(coalesce(p_note, '')), 600);
  v_seat  text;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('ok', false, 'error', 'not_the_office',
      'message', 'A count is signed on the office''s own report, and this session is not that book.');
  end if;

  select * into v_run from money_reconciliation_runs
   where id = p_run and tenant_id = p_tenant
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no count with that number in this book. A run is raised by a seat and '
        || 'named REC-YYYY-NNNNN; quote the number on the paper.');
  end if;
  if v_run.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'already_signed', 'ref', v_run.ref,
      'message', v_run.ref || ' was signed off on ' || to_char(v_run.reviewed_at, 'YYYY-MM-DD HH24:MI')
        || ' by ' || coalesce((select u.full_name from users u where u.id = v_run.reviewed_by),
                              'a second seat')
        || '. A count that has been answered for does not get a second signature.');
  end if;
  if char_length(coalesce(v_note, '')) < 8 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say what you read. The note is 8-600 characters and it is the sentence a clerk '
        || 'finds beside these figures months from now — "checked" is not a finding and "looks fine" '
        || 'is not an answer to the ' || v_run.findings::text || ' exception(s) this run wrote.');
  end if;
  if p_actor = v_run.raised_by then
    return jsonb_build_object('ok', false, 'error', 'same_seat', 'ref', v_run.ref,
      'message', 'You raised ' || v_run.ref || '. A count is signed by a seat that did not write it — '
        || 'the whole value of the second name on this paper is that a different pair of eyes read the '
        || 'same findings.');
  end if;

  v_seat := coalesce((select u.full_name from users u where u.id = p_actor), 'a second seat');

  update money_reconciliation_runs
     set status = 'reviewed', reviewed_by = p_actor, reviewed_at = now(), review_note = v_note
   where id = v_run.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_reconciliation_runs', v_run.id, 'recon.signed',
    jsonb_build_object('ref', v_run.ref, 'status', v_run.status, 'reviewed_by', null,
      'reviewed_at', null),
    jsonb_build_object('ref', v_run.ref, 'status', 'reviewed', 'reviewed_by', v_seat,
      'raised_by', (select u.full_name from users u where u.id = v_run.raised_by),
      'scope', v_run.scope, 'currency', v_run.currency, 'findings', v_run.findings,
      'net_difference', v_run.net_difference, 'review_note', v_note));

  return jsonb_build_object('ok', true, 'run',
    platform_auth.money_recon_detail(p_tenant, v_run.id));
end $$;

/**
 * Throw away a draft count.
 *
 * Only an open run can go, and the guard on the table is what makes that true for every role including
 * this door's owner; the check here exists so the desk gets a sentence instead of a constraint name.
 * The findings cascade — that is the one sanctioned way a finding disappears, and it is why their own
 * guard only permits a delete while the parent is still a draft.
 *
 * The audit row is written before the delete and survives it, with the run's whole account inside it:
 * the register loses the count, the office keeps the fact that a count was made and discarded, by
 * whom, and what they said about it. A tool that erases its own findings without a trace would be a
 * way to make drift disappear, which is the opposite of what 135 is for.
 */
create or replace function platform_auth.delete_money_reconciliation_run(
  p_tenant uuid, p_run uuid, p_reason text, p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_run   money_reconciliation_runs%rowtype;
  v_what  jsonb;
  v_reason text := left(trim(coalesce(p_reason, '')), 600);
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('ok', false, 'error', 'not_the_office',
      'message', 'A draft count is discarded from the office''s own book, and this is not that book.');
  end if;

  select * into v_run from money_reconciliation_runs
   where id = p_run and tenant_id = p_tenant
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no count with that number in this book — or it was already thrown away.');
  end if;
  if v_run.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'signed_and_kept', 'ref', v_run.ref,
      'message', v_run.ref || ' is signed off, so it is kept: a count somebody answered for is the '
        || 'record of a check, not a draft. Raise a newer run and say what changed between the two.');
  end if;
  if char_length(coalesce(v_reason, '')) < 8 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say why the count is being thrown away — 8-600 characters. The findings go with the '
        || 'run, so this sentence is the only thing that will explain the gap in the numbering.');
  end if;

  v_what := jsonb_build_object('ref', v_run.ref, 'scope', v_run.scope, 'currency', v_run.currency,
    'from_day', to_char(v_run.from_day, 'YYYY-MM-DD'), 'to_day', to_char(v_run.to_day, 'YYYY-MM-DD'),
    'checks', v_run.checks, 'findings', v_run.findings, 'net_difference', v_run.net_difference,
    'raised_by', (select u.full_name from users u where u.id = v_run.raised_by),
    'raised_at', v_run.raised_at);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_reconciliation_runs', v_run.id, 'recon.discarded', v_what,
    jsonb_build_object('reason', v_reason, 'findings_removed', v_run.findings));

  delete from money_reconciliation_runs where id = v_run.id;

  return jsonb_build_object('ok', true, 'discarded', v_what);
end $$;

-- ============================================================
-- 7. the reads: the pile of counts, one count, and a statement of one line
-- ============================================================

/**
 * The run board: counts newest first, with the three worst exceptions folded onto each row.
 *
 * A board that only says "12 findings, net 4 000.00" cannot be triaged from, and a desk that wants the
 * figures has to open twelve papers to learn what they are about; so the top three by absolute
 * difference ride on the row. The full list is one read away, in the detail.
 */
create or replace function platform_auth.money_recon_board(
  p_tenant uuid, p_scope text, p_status text, p_currency text, p_search text,
  p_limit int, p_offset int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows    jsonb;
  v_count   int;
  v_heading jsonb;
  v_scope   text := nullif(lower(trim(coalesce(p_scope, ''))), '');
  v_status  text := nullif(lower(trim(coalesce(p_status, ''))), '');
  v_cur     text := nullif(upper(trim(coalesce(p_currency, ''))), '');
  v_search  text := nullif(trim(coalesce(p_search, '')), '');
  v_limit   int := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset  int := greatest(coalesce(p_offset, 0), 0);
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('rows', '[]'::jsonb, 'count', 0, 'returned', 0,
      'limit', v_limit, 'offset', v_offset, 'heading', '[]'::jsonb,
      'error', 'A count is made of the office''s own book, and this is not that book.');
  end if;

  select count(*)::int into v_count
    from money_reconciliation_runs r
   where r.tenant_id = p_tenant
     and (v_scope is null or r.scope = v_scope)
     and (v_status is null or r.status = v_status)
     and (v_cur is null or r.currency = v_cur)
     and (v_search is null or r.ref ilike '%' || v_search || '%'
                       or coalesce((select u.full_name from users u where u.id = r.raised_by), '')
                          ilike '%' || v_search || '%'
                       or exists (select 1 from money_reconciliation_findings f
                                   where f.run_id = r.id
                                     and (f.check_name ilike '%' || v_search || '%'
                                       or coalesce(f.subject_ref, '') ilike '%' || v_search || '%'
                                       or coalesce(f.detail ->> 'why', '') ilike '%' || v_search || '%')));

  select coalesce(jsonb_agg(row_json order by raised_at desc, ref desc), '[]'::jsonb) into v_rows
    from (
      select r.raised_at, r.ref, jsonb_build_object(
        'id', r.id, 'ref', r.ref, 'scope', r.scope, 'currency', r.currency,
        'from_day', to_char(r.from_day, 'YYYY-MM-DD'), 'to_day', to_char(r.to_day, 'YYYY-MM-DD'),
        'checks', r.checks, 'findings', r.findings, 'net_difference', r.net_difference,
        'status', r.status, 'examined', r.examined,
        'raised_by', (select u.full_name from users u where u.id = r.raised_by),
        'raised_at', r.raised_at,
        'reviewed_by', (select u.full_name from users u where u.id = r.reviewed_by),
        'reviewed_at', r.reviewed_at, 'review_note', r.review_note,
        'worst', coalesce((select jsonb_agg(w.row_json order by w.line) from (
                    select f.line, jsonb_build_object('line', f.line, 'check', f.check_name,
                            'subject', f.subject_ref, 'kind', f.subject_kind,
                            'verdict', f.verdict, 'difference', f.difference,
                            'why', left(coalesce(f.detail ->> 'why', ''), 200)) as row_json
                      from money_reconciliation_findings f
                     where f.run_id = r.id
                     order by abs(f.difference) desc nulls last, f.line limit 3) w), '[]'::jsonb)
      ) as row_json
      from (
        select r2.id, r2.raised_at, r2.ref
          from money_reconciliation_runs r2
         where r2.tenant_id = p_tenant
           and (v_scope is null or r2.scope = v_scope)
           and (v_status is null or r2.status = v_status)
           and (v_cur is null or r2.currency = v_cur)
           and (v_search is null or r2.ref ilike '%' || v_search || '%'
                             or coalesce((select u.full_name from users u where u.id = r2.raised_by), '')
                                ilike '%' || v_search || '%'
                             or exists (select 1 from money_reconciliation_findings f2
                                         where f2.run_id = r2.id
                                           and (f2.check_name ilike '%' || v_search || '%'
                                             or coalesce(f2.subject_ref, '') ilike '%' || v_search || '%'
                                             or coalesce(f2.detail ->> 'why', '')
                                                ilike '%' || v_search || '%')))
         order by r2.raised_at desc
         limit v_limit offset v_offset
      ) page
      join money_reconciliation_runs r on r.id = page.id
    ) x;

  -- The heading the rows are a page of: every run the filters still name, not the twenty on the screen.
  -- A desk that totals the page reports a fraction of the office's counts as all of them, and the one
  -- figure an office argues about — how much the book is out by — is exactly the one that must be
  -- summed over the whole set. Per money, because 133 refuses a movement that changes currency and a
  -- run that added a TZS difference to a USD one is the same crime in the report.
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', g.currency, 'runs', g.runs, 'open', g.open, 'reviewed', g.reviewed,
           'findings', g.findings, 'exceptions_open', g.exceptions_open, 'net_difference', g.net
         ) order by g.currency), '[]'::jsonb) into v_heading
    from (
      select r.currency, count(*)::int as runs,
             coalesce(sum((r.status = 'open')::int), 0)::int as open,
             coalesce(sum((r.status = 'reviewed')::int), 0)::int as reviewed,
             coalesce(sum(r.findings), 0)::int as findings,
             coalesce(sum((select count(*)::int from money_reconciliation_findings f
                            join money_reconciliation_runs r3 on r3.id = f.run_id
                           where f.run_id = r.id and r3.status = 'open')), 0)::int as exceptions_open,
             coalesce(sum(r.net_difference), 0)::numeric(14,2) as net
        from money_reconciliation_runs r
       where r.tenant_id = p_tenant
         and (v_scope is null or r.scope = v_scope)
         and (v_status is null or r.status = v_status)
         and (v_cur is null or r.currency = v_cur)
         and (v_search is null or r.ref ilike '%' || v_search || '%'
                           or coalesce((select u.full_name from users u where u.id = r.raised_by), '')
                              ilike '%' || v_search || '%'
                           or exists (select 1 from money_reconciliation_findings f3
                                       where f3.run_id = r.id
                                         and (f3.check_name ilike '%' || v_search || '%'
                                           or coalesce(f3.subject_ref, '') ilike '%' || v_search || '%'
                                           or coalesce(f3.detail ->> 'why', '')
                                              ilike '%' || v_search || '%')))
       group by r.currency
    ) g;

  return jsonb_build_object('rows', v_rows, 'count', v_count,
                            'returned', coalesce(jsonb_array_length(v_rows), 0),
                            'limit', v_limit, 'offset', v_offset, 'heading', v_heading);
end $$;

/**
 * One count, whole: the run's own account of what it looked at, then every exception in the line
 * order it was written in.
 *
 * The findings are not paged. A run is a sentence the office makes about itself, and a desk that can
 * read twenty of its exceptions but not the twenty-first cannot sign for it — which is the one thing
 * 135 asks a seat to do. `by_check` is the summary the signing seat reads first: the questions that
 * came back clean are in `examined`, the ones that did not are counted here with their net.
 */
create or replace function platform_auth.money_recon_detail(p_tenant uuid, p_run uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object(
              'id', r.id, 'ref', r.ref, 'scope', r.scope, 'currency', r.currency,
              'from_day', to_char(r.from_day, 'YYYY-MM-DD'), 'to_day', to_char(r.to_day, 'YYYY-MM-DD'),
              'checks', r.checks, 'findings', r.findings, 'net_difference', r.net_difference,
              'status', r.status, 'examined', r.examined, 'review_note', r.review_note,
              'raised_by', (select u.full_name from users u where u.id = r.raised_by),
              'raised_at', r.raised_at,
              'reviewed_by', (select u.full_name from users u where u.id = r.reviewed_by),
              'reviewed_at', r.reviewed_at,
              'can_sign', (r.status = 'open'),
              'exceptions', coalesce((select jsonb_agg(f.row_json order by f.line) from (
                            select f1.line, jsonb_build_object(
                              'id', f1.id, 'line', f1.line, 'check', f1.check_name,
                              'subject_kind', f1.subject_kind, 'subject_id', f1.subject_id,
                              'subject_ref', f1.subject_ref, 'book_figure', f1.book_figure,
                              'paper_figure', f1.paper_figure, 'difference', f1.difference,
                              'verdict', f1.verdict, 'detail', f1.detail) as row_json
                              from money_reconciliation_findings f1
                             where f1.run_id = r.id) f), '[]'::jsonb),
              'by_check', coalesce((select jsonb_agg(b.row_json order by b.abs_net desc, b.check_name) from (
                            select f2.check_name,
                                   max(abs(f2.difference))::numeric(14,2) as abs_net,
                                   jsonb_build_object('check', f2.check_name,
                                     'exceptions', count(*)::int,
                                     'net', sum(f2.difference)::numeric(14,2),
                                     'worst_subject', (select f3.subject_ref
                                                         from money_reconciliation_findings f3
                                                        where f3.run_id = f2.run_id
                                                          and f3.check_name = f2.check_name
                                                        order by abs(f3.difference) desc nulls last,
                                                                 f3.line limit 1)) as row_json
                              from money_reconciliation_findings f2
                             where f2.run_id = r.id
                             group by f2.run_id, f2.check_name) b), '[]'::jsonb))
       from money_reconciliation_runs r
      where r.id = p_run and r.tenant_id = p_tenant),
    jsonb_build_object('error', 'There is no count in this book with that number.'));
$$;

/**
 * One line of the book, one window of days: what it opened on, every movement on it in day order with
 * the running figure beside each, and what it closed on.
 *
 * 133's `money_register` is the whole book newest-first, which is what a desk watching money move
 * wants and what nobody asks for when they need a statement. An accountant asks for one account — the
 * bank line, the escrow line, one holder's wallet — over a period, with an opening figure, and the
 * running balance is the point of the paper: it is how a reader finds the day the office stopped
 * agreeing with the bank without recomputing anything.
 *
 * So the running figure is computed over the *whole* window and the page is cut afterwards, because a
 * balance that restarts at the top of page two is not a balance. The opening is every leg written
 * before `p_from`, whoever typed it and whenever, and the closing is the opening plus the window's own
 * movements — which is why `closing` equals the account's live balance for any window ending today:
 * the statement is the book read from the outside, and 133's cached totals are the same book read from
 * inside. `drift` prints the two beside each other for exactly that reason.
 *
 * The side a movement is printed on follows the account's kind, never a choice made here: assets and
 * expenses grow by debits, the other three grow by credits, and a statement that added a credit to a
 * bank line would be a statement whose totals the office cannot sign.
 */
create or replace function platform_auth.money_statement(
  p_tenant uuid, p_account uuid, p_from date, p_to date, p_limit int, p_offset int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_line     money_accounts%rowtype;
  v_rows     jsonb;
  v_opening  numeric(14,2) := 0;
  v_debit    numeric(14,2) := 0;
  v_credit   numeric(14,2) := 0;
  v_moved    numeric(14,2) := 0;
  v_closing  numeric(14,2) := 0;
  v_legs     int := 0;
  v_drift    jsonb;
  v_limit    int := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_offset   int := greatest(coalesce(p_offset, 0), 0);
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('rows', '[]'::jsonb, 'legs', 0,
      'error', 'A statement is drawn of the office''s own book, and this session is not that book.');
  end if;
  if p_from is null or p_to is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'legs', 0, 'error',
      'A statement is asked of a window of days. Say which days it covers.');
  end if;
  if p_from > p_to then
    return jsonb_build_object('rows', '[]'::jsonb, 'legs', 0, 'error',
      'The window runs backwards: the first day has to be the earlier one.');
  end if;
  if p_to > current_date then
    return jsonb_build_object('rows', '[]'::jsonb, 'legs', 0, 'error',
      'There is no day ' || p_to || ' to close a statement on yet.');
  end if;

  select * into v_line from money_accounts
   where id = p_account and tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('rows', '[]'::jsonb, 'legs', 0, 'error',
      'This book has no line with that id. The chart is on the ledger desk, and a company''s own '
        || 'book is not the office''s.');
  end if;

  -- Every leg before the window, in the account's own direction: the figure the statement opens on.
  select coalesce(sum(case when (e.direction = 'debit') = (v_line.kind in ('asset','expense'))
                            then e.amount else -e.amount end), 0)::numeric(14,2)
    into v_opening
    from money_entries e
    join money_postings p on p.id = e.posting_id
   where e.account_id = v_line.id and p.posted_on < p_from;

  -- The window as a whole, whether or not the page can see all of it.
  select coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)::numeric(14,2),
         coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2),
         coalesce(sum(case when (e.direction = 'debit') = (v_line.kind in ('asset','expense'))
                           then e.amount else -e.amount end), 0)::numeric(14,2),
         count(*)::int
    into v_debit, v_credit, v_moved, v_legs
    from money_entries e
    join money_postings p on p.id = e.posting_id
   where e.account_id = v_line.id and p.posted_on between p_from and p_to;

  v_closing := v_opening + v_moved;

  -- The cached totals are the book's lifetime figures, so they can only be compared with a statement
  -- that closes on today: a window ending last Friday nets a different balance by design. `agrees` is
  -- null when the window does not end today rather than false, because a statement of March is not
  -- evidence that April's register has drifted.
  select jsonb_build_object(
    'cached_balance', (case when v_line.kind in ('asset','expense')
                            then v_line.debit_total - v_line.credit_total
                            else v_line.credit_total - v_line.debit_total end)::numeric(14,2),
    'statement_balance', v_closing,
    'window_ends_today', (p_to = current_date),
    'legs_cached', v_line.entry_count,
    'legs_all_time', (select count(*)::int from money_entries e where e.account_id = v_line.id),
    'agrees', case when p_to = current_date then (
      (case when v_line.kind in ('asset','expense')
            then v_line.debit_total - v_line.credit_total
            else v_line.credit_total - v_line.debit_total end)::numeric(14,2) = v_closing)
      end)
    into v_drift;

  select coalesce(jsonb_agg(row_json order by line_no), '[]'::jsonb) into v_rows
    from (
      select l.line_no, jsonb_build_object(
        'line', l.line_no,
        'day', to_char(l.posted_on, 'YYYY-MM-DD'),
        'ref', l.ref, 'memo', l.memo,
        'direction', l.direction, 'amount', l.amount, 'detail', l.detail,
        'source_kind', l.source_kind, 'source_ref', l.source_ref,
        'posting_status', l.posting_status,
        'moved', l.signed, 'running', l.running, 'other_side', l.other_side,
        'posted_by', l.raised_by, 'raised_at', l.raised_at
      ) as row_json
      from (
        select p.posted_on, p.raised_at, p.ref, p.memo, p.status as posting_status,
               p.source_kind, p.source_ref, e.direction, e.amount, e.detail,
               (select u.full_name from users u where u.id = p.raised_by) as raised_by,
               case when (e.direction = 'debit') = (v_line.kind in ('asset','expense'))
                    then e.amount else -e.amount end                              as signed,
               (v_opening + sum(case when (e.direction = 'debit')
                                            = (v_line.kind in ('asset','expense'))
                                      then e.amount else -e.amount end)
                 over (order by p.posted_on, p.raised_at, p.ref, e.id
                       rows between unbounded preceding and current row)
               )::numeric(14,2)                                                  as running,
               coalesce((select string_agg(a2.code, ' + ' order by a2.code)
                           from money_entries e2
                           join money_accounts a2 on a2.id = e2.account_id
                          where e2.posting_id = e.posting_id
                            and a2.id <> e.account_id), '(no other side)')          as other_side,
               row_number() over (order by p.posted_on, p.raised_at, p.ref, e.id)::int as line_no
          from money_entries e
          join money_postings p on p.id = e.posting_id
         where e.account_id = v_line.id
           and p.posted_on between p_from and p_to
      ) l
      order by l.line_no
      limit v_limit offset v_offset
    ) x;

  return jsonb_build_object(
    'account', platform_auth.money_account_row(p_tenant, v_line.id),
    'code', v_line.code, 'label', v_line.label, 'kind', v_line.kind,
    'currency', v_line.currency, 'natural_side',
      case when v_line.kind in ('asset','expense') then 'debit' else 'credit' end,
    'from_day', to_char(p_from, 'YYYY-MM-DD'), 'to_day', to_char(p_to, 'YYYY-MM-DD'),
    'opening', v_opening, 'debited', v_debit, 'credited', v_credit, 'moved', v_moved,
    'closing', v_closing, 'legs', v_legs,
    'returned', coalesce(jsonb_array_length(v_rows), 0),
    'limit', v_limit, 'offset', v_offset,
    'drift', v_drift,
    'rows', coalesce(v_rows, '[]'::jsonb),
    'basis', 'the opening is every leg before ' || to_char(p_from, 'YYYY-MM-DD') || ', the totals and '
      || 'the running figure cover the whole window and not just this page, and the closing is the '
      || 'opening plus what the window moved on ' || v_line.code);
end $$;

-- ============================================================
-- 8. the gateway: what arrived, what landed, and what a seat did about it
-- ============================================================

/**
 * Strip the keys a rail must never be asked to repeat, at any depth.
 *
 * The list is by *key name*, never by value shape. A scrub that removed anything looking like a
 * phone number would also remove `WSH-075...`, the reference the desk needs in order to say which
 * charge is stuck — and a payload read that destroyed the fact it was opened to show is worse than
 * not opening it. So the deny-list is the words a rail actually uses for a person's account or a
 * secret, compared lowercased, and everything else in the body survives.
 *
 * Today the intake route stores four shaped keys (`reference`, `outcome`, `nonce`, `event`) and two
 * refusal bodies, so nothing sensitive is in this column. The scrub ships anyway: it is the reason a
 * later rail that posts a raw body cannot turn a gateway read into a PII read, and the desk that
 * shows a payload is exactly where that would first be visible.
 */
create or replace function platform_auth.scrub_gateway_payload(p_payload jsonb)
returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_hidden text[] := array[
    'phone','phonenumber','phone_number','msisdn','mobile','mobile_number','tel','telephone',
    'account','accountno','account_number','acc_no','pan','card','cardno','card_number',
    'cvv','cvc','expiry','pin','otp','email','mail','nida','id_number','national_id',
    'secret','password','token','authorization','signature','credentials_encrypted',
    'webhook_secret','payer_phone'];
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_val jsonb;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return coalesce(p_payload, '{}'::jsonb);
  end if;
  for v_key, v_val in select key, value from jsonb_each(p_payload)
  loop
    if lower(replace(v_key, '-', '_')) = any (v_hidden)
       or lower(replace(v_key, '-', '')) = any (v_hidden) then
      continue;
    end if;
    if jsonb_typeof(v_val) = 'object' then
      v_out := v_out || jsonb_build_object(v_key, platform_auth.scrub_gateway_payload(v_val));
    elsif jsonb_typeof(v_val) = 'array' then
      v_out := v_out || jsonb_build_object(v_key, coalesce((select jsonb_agg(
                       case when jsonb_typeof(e) = 'object'
                            then platform_auth.scrub_gateway_payload(e) else e end)
                     from jsonb_array_elements(v_val) e), '[]'::jsonb));
    else
      v_out := v_out || jsonb_build_object(v_key, v_val);
    end if;
  end loop;
  return v_out;
end $$;

/**
 * The delivery board: what the rails sent, whether the office acted on it, and what it cost to find
 * out.
 *
 * `payment_webhooks` has no tenant column — the rail posts to one open door and the body names a
 * charge, so the company a delivery belongs to is read from the charge it names. That is the same
 * join the intake route makes, and it is why the board answers with a `charge` block (or says there
 * is none) instead of pretending the delivery is one office's row.
 *
 * The five states are the five questions a desk actually asks, and they are exclusive filters rather
 * than flags so a seat can count a pile by asking one word: `stuck` is the pile that has to be worked
 * — verified, never processed, the thing 135 exists to make visible.
 */
create or replace function platform_auth.gateway_webhook_board(
  p_tenant uuid, p_provider text, p_state text, p_search text, p_limit int, p_offset int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows    jsonb;
  v_count   int;
  v_heading jsonb;
  v_prov    text := nullif(lower(trim(coalesce(p_provider, ''))), '');
  v_state   text := nullif(lower(trim(coalesce(p_state, ''))), '');
  v_search  text := nullif(trim(coalesce(p_search, '')), '');
  v_limit   int := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset  int := greatest(coalesce(p_offset, 0), 0);
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('rows', '[]'::jsonb, 'count', 0, 'returned', 0, 'heading', '[]'::jsonb,
      'limit', v_limit, 'offset', v_offset,
      'error', 'The rails answer to the platform office, and this session is not that desk.');
  end if;
  if v_state is not null and v_state not in ('all','stuck','unverified','landed','retried','orphan') then
    return jsonb_build_object('rows', '[]'::jsonb, 'count', 0, 'returned', 0, 'heading', '[]'::jsonb,
      'limit', v_limit, 'offset', v_offset, 'error',
      'Choose the pile: stuck, unverified, landed, retried, orphan, or all of it at once.');
  end if;

  -- The predicate is written once per shape because a board and its heading must be about the same
  -- deliveries. `state` needs the attempt count and the charge, so it is a lateral rather than a case.
  select count(*)::int into v_count
    from payment_webhooks w
    left join lateral (
      select count(*)::int as attempts from gateway_webhook_attempts a
       where a.webhook_id = w.id and a.tenant_id = p_tenant
    ) t on true
    left join payments pay on pay.intent_reference
      = nullif(trim(coalesce(w.payload ->> 'reference', '')), '')
   where (v_prov is null or w.provider = v_prov)
     and (v_state is null or v_state = 'all'
          or (v_state = 'stuck'     and w.signature_valid and w.processed_at is null)
          or (v_state = 'unverified' and not w.signature_valid)
          or (v_state = 'landed'     and w.processed_at is not null)
          or (v_state = 'retried'    and t.attempts > 0)
          or (v_state = 'orphan'     and w.signature_valid and pay.id is null))
     and (v_search is null or w.provider ilike '%' || v_search || '%'
                       or coalesce(w.event_type, '') ilike '%' || v_search || '%'
                       or coalesce(w.payload ->> 'reference', '') ilike '%' || v_search || '%'
                       or coalesce(w.processing_error, '') ilike '%' || v_search || '%'
                       or coalesce(pay.intent_reference, '') ilike '%' || v_search || '%'
                       or coalesce((select t2.name from tenants t2 where t2.id = pay.tenant_id), '')
                          ilike '%' || v_search || '%');

  select coalesce(jsonb_agg(row_json order by created_at desc, ref_id), '[]'::jsonb) into v_rows
    from (
      select w.created_at, w.id as ref_id, jsonb_build_object(
        'id', w.id, 'provider', w.provider, 'event', w.event_type,
        'verified', w.signature_valid, 'nonce', w.replay_nonce,
        'reference', nullif(trim(coalesce(w.payload ->> 'reference', '')), ''),
        'outcome_wanted', nullif(trim(coalesce(w.payload ->> 'outcome', '')), ''),
        'readable', (w.event_type <> 'unparsed' and coalesce(w.payload ? 'reference', false)),
        'arrived_at', w.created_at, 'processed_at', w.processed_at,
        'processing_error', w.processing_error,
        'attempts', t.attempts,
        'last_attempt', t.last_json,
        'charge', case when pay.id is null then null
          else jsonb_build_object('id', pay.id, 'reference', pay.intent_reference,
            'status', pay.status, 'amount', pay.amount, 'currency', pay.currency,
            'rail', pay.provider, 'requested_at', pay.requested_at, 'completed_at', pay.completed_at,
            'invoice', (select i.number from invoices i where i.id = pay.invoice_id),
            'tenant', (select t2.name from tenants t2 where t2.id = pay.tenant_id)) end,
        'can_retry', (w.signature_valid and w.processed_at is null and t.attempts < 5
                      and coalesce(w.payload ->> 'reference', '') <> '')
      ) as row_json
      from (
        select w2.id, w2.created_at
          from payment_webhooks w2
          left join lateral (
            select count(*)::int as attempts from gateway_webhook_attempts a2
             where a2.webhook_id = w2.id and a2.tenant_id = p_tenant
          ) t2 on true
          left join payments pay2 on pay2.intent_reference
            = nullif(trim(coalesce(w2.payload ->> 'reference', '')), '')
         where (v_prov is null or w2.provider = v_prov)
           and (v_state is null or v_state = 'all'
                or (v_state = 'stuck'      and w2.signature_valid and w2.processed_at is null)
                or (v_state = 'unverified' and not w2.signature_valid)
                or (v_state = 'landed'     and w2.processed_at is not null)
                or (v_state = 'retried'    and t2.attempts > 0)
                or (v_state = 'orphan'     and w2.signature_valid and pay2.id is null))
           and (v_search is null or w2.provider ilike '%' || v_search || '%'
                             or coalesce(w2.event_type, '') ilike '%' || v_search || '%'
                             or coalesce(w2.payload ->> 'reference', '') ilike '%' || v_search || '%'
                             or coalesce(w2.processing_error, '') ilike '%' || v_search || '%'
                             or coalesce(pay2.intent_reference, '') ilike '%' || v_search || '%'
                             or coalesce((select t3.name from tenants t3
                                           where t3.id = pay2.tenant_id), '')
                                ilike '%' || v_search || '%')
         order by w2.created_at desc
         limit v_limit offset v_offset
      ) page
      join payment_webhooks w on w.id = page.id
      left join lateral (
        select count(*)::int as attempts,
               (select jsonb_build_object('attempt', a3.attempt, 'outcome', a3.outcome,
                                          'at', a3.created_at, 'message', a3.message,
                                          'acted_by', (select u3.full_name from users u3
                                                        where u3.id = a3.acted_by))
                  from gateway_webhook_attempts a3
                 where a3.webhook_id = w.id and a3.tenant_id = p_tenant
                 order by a3.attempt desc limit 1) as last_json
          from gateway_webhook_attempts a4
         where a4.webhook_id = w.id and a4.tenant_id = p_tenant
      ) t on true
      left join payments pay on pay.intent_reference
        = nullif(trim(coalesce(w.payload ->> 'reference', '')), '')
    ) x;

  -- Every delivery the filters still name, not the page: the office asks "how many are stuck" as one
  -- number, and 135's whole purpose is that this question has an answer at all. The joins and the
  -- predicates are the count's own, search included — a heading that ignored the box a seat typed
  -- would report a total that contradicts the rows it sits above. The piles counted are the piles the
  -- `state` filter offers, so the chips on the desk and the numbers beside them cannot disagree.
  select coalesce(jsonb_agg(jsonb_build_object(
           'provider', g.provider, 'deliveries', g.n, 'stuck', g.stuck, 'unverified', g.unverified,
           'landed', g.landed, 'retried', g.retried, 'orphan', g.orphan, 'attempts', g.attempts,
           'spent', g.spent
         ) order by g.provider), '[]'::jsonb) into v_heading
    from (
      select w.provider, count(*)::int as n,
             coalesce(sum((w.signature_valid and w.processed_at is null)::int), 0)::int as stuck,
             coalesce(sum((not w.signature_valid)::int), 0)::int as unverified,
             coalesce(sum((w.processed_at is not null)::int), 0)::int as landed,
             coalesce(sum((t.attempts > 0)::int), 0)::int as retried,
             coalesce(sum(t.attempts), 0)::int as attempts,
             coalesce(sum((t.attempts >= 5 and w.processed_at is null)::int), 0)::int as spent,
             -- The join above makes this the same test as the `orphan` pile, empty reference included.
             coalesce(sum((w.signature_valid and pay.id is null)::int), 0)::int as orphan
        from payment_webhooks w
        left join lateral (
          select count(*)::int as attempts from gateway_webhook_attempts a5
           where a5.webhook_id = w.id and a5.tenant_id = p_tenant
        ) t on true
        left join payments pay on pay.intent_reference
          = nullif(trim(coalesce(w.payload ->> 'reference', '')), '')
       where (v_prov is null or w.provider = v_prov)
         and (v_state is null or v_state = 'all'
              or (v_state = 'stuck'      and w.signature_valid and w.processed_at is null)
              or (v_state = 'unverified' and not w.signature_valid)
              or (v_state = 'landed'     and w.processed_at is not null)
              or (v_state = 'retried'    and t.attempts > 0)
              or (v_state = 'orphan'     and w.signature_valid and pay.id is null))
         and (v_search is null or w.provider ilike '%' || v_search || '%'
                           or coalesce(w.event_type, '') ilike '%' || v_search || '%'
                           or coalesce(w.payload ->> 'reference', '') ilike '%' || v_search || '%'
                           or coalesce(w.processing_error, '') ilike '%' || v_search || '%'
                           or coalesce(pay.intent_reference, '') ilike '%' || v_search || '%'
                           or coalesce((select t4.name from tenants t4
                                         where t4.id = pay.tenant_id), '')
                              ilike '%' || v_search || '%')
       group by w.provider
    ) g;

  return jsonb_build_object('rows', v_rows, 'count', v_count,
                            'returned', coalesce(jsonb_array_length(v_rows), 0),
                            'limit', v_limit, 'offset', v_offset, 'heading', v_heading);
end $$;

/**
 * One delivery, whole: what the rail sent, what the charge says now, every attempt the office has
 * made against it, and the rail's own row from 114's register beside it.
 *
 * The payload is the scrubbed copy and the charge is read without its PII columns — `payer_phone_
 * encrypted` is never named by this select, which is the difference between a gateway desk a support
 * seat can use and a phone-number dump that happens to have a nice header.
 */
create or replace function platform_auth.gateway_webhook_detail(p_tenant uuid, p_webhook uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_w     payment_webhooks%rowtype;
  v_att   jsonb;
  v_pay   jsonb;
  v_rail  jsonb;
  v_can   boolean;
  v_why   text;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('error', 'The rails answer to the platform office, and this is not that desk.');
  end if;
  select * into v_w from payment_webhooks where id = p_webhook;
  if not found then
    return jsonb_build_object('error', 'No delivery reached the platform with that id.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'attempt', a.attempt, 'outcome', a.outcome, 'message', a.message,
           'intent_reference', a.intent_reference, 'payment_status', a.payment_status,
           'answer', a.answer, 'acted_by', (select u.full_name from users u where u.id = a.acted_by),
           'acted_role', a.acted_role, 'at', a.created_at
         ) order by a.attempt), '[]'::jsonb) into v_att
    from gateway_webhook_attempts a
   where a.webhook_id = v_w.id and a.tenant_id = p_tenant;

  select json_build_object(
           'id', p.id, 'reference', p.intent_reference, 'status', p.status,
           'amount', p.amount, 'currency', p.currency, 'rail', p.provider,
           'provider_txn_id', p.provider_txn_id, 'requested_at', p.requested_at,
           'completed_at', p.completed_at, 'invoice', i.number,
           'tenant_id', p.tenant_id, 'tenant', t.name, 'tenant_type', t.type
         ) into v_pay
    from payments p
    left join invoices i on i.id = p.invoice_id
    left join tenants t on t.id = p.tenant_id
   where p.intent_reference = nullif(trim(coalesce(v_w.payload ->> 'reference', '')), '');

  select jsonb_build_object('provider_key', g.provider_key, 'label', g.label, 'adapter', g.adapter,
           'environment', g.environment, 'live', g.enabled, 'credential_hint', g.credential_hint,
           'last_check', g.last_check, 'updated_at', g.updated_at,
           'updated_by', (select u.full_name from users u where u.id = g.updated_by))
    into v_rail
    from payment_gateways g where g.provider_key = v_w.provider;

  -- The answer to "can a seat press this button", stated once so the desk and the door cannot drift
  -- apart about it: the retry door re-checks each of these and refuses with the same sentence.
  v_can := v_w.signature_valid and v_w.processed_at is null
           and coalesce(v_w.payload ? 'reference', false)
           and (select count(*)::int from gateway_webhook_attempts a where a.webhook_id = v_w.id) < 5;
  if not v_w.signature_valid then
    v_why := 'The platform could not verify this delivery, so it is not an instruction. Nothing is '
          || 're-driven against a signature that did not match.';
  elsif v_w.processed_at is not null then
    v_why := 'The office already acted on this delivery — the ledger beside it is the whole story.';
  elsif not coalesce(v_w.payload ? 'reference', false) then
    v_why := 'This payload names no charge, so there is nothing here to re-drive. The reference a '
          || 'rail pushes is what the completion is asked for.';
  elsif (select count(*)::int from gateway_webhook_attempts a where a.webhook_id = v_w.id) >= 5 then
    v_why := 'Five attempts is the ceiling and this delivery has spent it. The next answer has to '
          || 'come from the rail, not from this desk.';
  else
    v_why := null;
  end if;

  return jsonb_build_object(
    'id', v_w.id, 'provider', v_w.provider, 'event', v_w.event_type,
    'verified', v_w.signature_valid, 'nonce', v_w.replay_nonce,
    'arrived_at', v_w.created_at, 'processed_at', v_w.processed_at,
    'processing_error', v_w.processing_error,
    'payload', platform_auth.scrub_gateway_payload(v_w.payload),
    'payload_keys', coalesce((select jsonb_agg(k order by k)
                                from jsonb_object_keys(v_w.payload) k), '[]'::jsonb),
    'charge', v_pay, 'rail', v_rail, 'attempts', coalesce(v_att, '[]'::jsonb),
    'can_retry', v_can, 'why_not', v_why);
end $$;

/**
 * Re-drive the completion behind a delivery the office never acted on.
 *
 * The order of the refusals is the order a seat needs to hear them, and two of them write a row
 * before they answer `ok:false`: an unverified delivery and a payload that names nothing are exactly
 * the button-presses the ledger exists to count. A delivery that has spent its five attempts writes
 * nothing — the ceiling is a CHECK on the table, and a sixth row would be the door breaking its own
 * rule to report it.
 *
 * The work itself is one call to 009's `complete_payment`, which is idempotent and answers
 * `already_final` for a charge it has already closed. That is the whole safety of this door: a retry
 * cannot bill, activate or extend anything twice, so the ceiling of five is about a person's time and
 * a rail's support ticket, not about money. A caught exception is recorded as `failed` with the
 * database's own sentence, because the failure 135 exists to catch is the one that left
 * `processing_error` in the first place.
 */
create or replace function platform_auth.retry_gateway_webhook(
  p_tenant uuid, p_webhook uuid, p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_w        payment_webhooks%rowtype;
  v_attempt  int;
  v_outcome  text;
  v_answer   jsonb;
  v_message  text;
  v_ref      text;
  v_pay      payments%rowtype;
  v_status   text;
  v_wanted   text;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('ok', false, 'error', 'not_the_office',
      'message', 'Only the platform office can re-drive a rail''s answer, and this is not that desk.');
  end if;

  select * into v_w from payment_webhooks where id = p_webhook for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'No delivery reached the platform with that id. The board lists what arrived, newest '
        || 'first, and a retry is asked of one of those rows.');
  end if;

  select count(*)::int + 1 into v_attempt from gateway_webhook_attempts
   where webhook_id = v_w.id and tenant_id = p_tenant;
  if v_attempt > 5 then
    return jsonb_build_object('ok', false, 'error', 'attempts_spent', 'attempts', v_attempt - 1,
      'message', 'This delivery has already been re-driven ' || (v_attempt - 1)::text
        || ' times. Five is the ceiling, so the next answer has to come from the rail: talk to '
        || v_w.provider || ' and ask what its own register says about the charge it pushed.');
  end if;

  if not v_w.signature_valid then
    insert into gateway_webhook_attempts (tenant_id, webhook_id, attempt, outcome, message, answer,
                                          acted_by, acted_role, ip, user_agent)
    values (p_tenant, v_w.id, v_attempt, 'refused',
      left('A seat of role ' || coalesce(nullif(trim(p_role), ''), 'unknown')
           || ' asked for this delivery to be re-driven. The platform never verified its signature, '
           || 'so it is not an instruction and nothing was sent anywhere.', 600),
      jsonb_build_object('reason', 'unverified_signature', 'event', v_w.event_type,
                         'arrived_at', v_w.created_at),
      p_actor, p_role, p_ip, p_ua);
    perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
      'payment_webhooks', v_w.id, 'gateway.webhook.refused', null,
      jsonb_build_object('attempt', v_attempt, 'provider', v_w.provider, 'event', v_w.event_type,
        'outcome', 'refused', 'why', 'signature was never valid'));
    return jsonb_build_object('ok', false, 'error', 'not_verified', 'attempt', v_attempt,
      'message', 'This delivery''s signature did not match the rail''s key, so the platform never '
        || 'accepted it as an instruction and nothing is being re-driven. A delivery nobody signed is '
        || 'not a payment: check the webhook secret on ' || v_w.provider || ' rather than the charge.');
  end if;

  if coalesce(v_w.payload ->> 'reference', '') = '' then
    insert into gateway_webhook_attempts (tenant_id, webhook_id, attempt, outcome, message, answer,
                                          acted_by, acted_role, ip, user_agent)
    values (p_tenant, v_w.id, v_attempt, 'refused',
      left('A seat of role ' || coalesce(nullif(trim(p_role), ''), 'unknown')
           || ' asked for this delivery to be re-driven. Its body names no charge, so there is '
           || 'nothing a completion could be asked for.', 600),
      jsonb_build_object('reason', 'no_reference', 'event', v_w.event_type,
                         'payload', platform_auth.scrub_gateway_payload(v_w.payload)),
      p_actor, p_role, p_ip, p_ua);
    perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
      'payment_webhooks', v_w.id, 'gateway.webhook.refused', null,
      jsonb_build_object('attempt', v_attempt, 'provider', v_w.provider, 'event', v_w.event_type,
        'outcome', 'refused', 'why', 'the payload names no charge'));
    return jsonb_build_object('ok', false, 'error', 'no_reference', 'attempt', v_attempt,
      'message', 'This delivery carries no reference'
        || case when v_w.event_type = 'unparsed'
                  then ' — the rail posted a body the platform could not read at all, so there was '
                       || 'never an instruction here. The event the rail sent is all this row knows.'
                  else ', so there is nothing to re-drive.' end);
  end if;

  v_ref := trim(v_w.payload ->> 'reference');
  -- What the rail asked for: its own event word when it has one, else the shaped outcome the intake
  -- route parsed. `complete_payment` takes only the four final words and answers invalid_status for
  -- anything else, so an odd event name is reported rather than guessed at.
  v_wanted := coalesce(nullif(v_w.event_type, ''), v_w.payload ->> 'outcome');
  if v_wanted not in ('approved','failed','timed_out','cancelled') then
    v_wanted := coalesce(v_w.payload ->> 'outcome', v_wanted);
  end if;

  begin
    select platform_auth.complete_payment(v_ref, v_wanted, null) into v_answer;
  exception when others then
    v_answer := jsonb_build_object('status', 'raised', 'sqlstate', sqlstate,
                                   'detail', left(sqlerrm, 300));
  end;

  select * into v_pay from payments where intent_reference = v_ref;
  v_status := v_pay.status;

  v_outcome := case v_answer ->> 'status'
    when 'ok'             then 'succeeded'
    when 'already_final'  then 'already_final'
    when 'not_found'      then 'failed'
    when 'invalid_status'    then 'refused'
    when 'invalid_transition' then 'refused'
    when 'raised'         then 'failed'
    else 'failed'
  end;

  v_message := left(case v_answer ->> 'status'
    when 'ok' then 'The charge was still open and the completion landed: ' || v_ref || ' is now '
      || coalesce(v_status, 'closed') || case when v_pay.status = 'approved'
        then ' — ' || coalesce((select t.name from tenants t where t.id = v_pay.tenant_id), 'the company')
             || '''s licence runs to '
             || coalesce((select to_char(t.licence_expires_at, 'YYYY-MM-DD')
                            from tenants t where t.id = v_pay.tenant_id), 'a day not yet written')
        else '' end || '.'
    when 'already_final' then v_ref || ' was already ' || coalesce(v_status, 'final')
      || ' before this attempt, so nothing moved. The rail''s answer was right, and the office had '
      || 'already acted on it by another route.'
    when 'not_found' then 'No charge carries the reference ' || v_ref || ' this delivery names, so the '
      || 'completion had nothing to close. The delivery is real; the reference is not ours.'
    when 'invalid_status' then 'The rail''s body asked for ' || coalesce(v_wanted, 'nothing readable')
      || ', which is not one of the four outcomes a charge can be closed with.'
    when 'invalid_transition' then v_ref || ' is ' || coalesce(v_status, 'unknown')
      || ' and cannot be moved to ' || coalesce(v_wanted, 'nothing') || ' — the state machine refused it.'
    when 'raised' then 'Re-driving the completion failed the same way it failed the first time: '
      || coalesce(v_answer ->> 'detail', 'no detail came back')
    else 'The completion answered ' || coalesce(v_answer ->> 'status', 'nothing at all')
      || ', which this door does not have a word for.'
  end, 600);

  insert into gateway_webhook_attempts (tenant_id, webhook_id, attempt, outcome, intent_reference,
                                        payment_status, message, answer, acted_by, acted_role,
                                        ip, user_agent)
  values (p_tenant, v_w.id, v_attempt, v_outcome, left(v_ref, 60), v_status, v_message,
          coalesce(v_answer, '{}'::jsonb), p_actor, p_role, p_ip, p_ua);

  -- The landing of a licence is a fact about a company, not about the office's ledger, so it is
  -- audited on the company's own rows exactly as the webhook route does it: the seat that re-drove it
  -- is named, and `via` says the desk rather than the rail.
  if v_answer ->> 'status' = 'ok' and v_pay.status = 'approved' then
    perform platform_auth.money_audit(coalesce(v_pay.tenant_id, p_tenant), p_actor, p_role, p_ip, p_ua,
      'payments', v_pay.id, 'payment.approved.retry', null,
      jsonb_build_object('via', 'desk retry', 'provider', v_w.provider, 'reference', v_ref,
        'webhook', v_w.id, 'attempt', v_attempt));
  end if;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'payment_webhooks', v_w.id, 'gateway.webhook.retried', null,
    jsonb_build_object('attempt', v_attempt, 'outcome', v_outcome, 'provider', v_w.provider,
      'event', v_w.event_type, 'reference', left(v_ref, 60), 'payment_status', v_status,
      'message', v_message));

  return jsonb_build_object('ok', true, 'attempt', v_attempt, 'outcome', v_outcome,
    'answer', coalesce(v_answer, '{}'::jsonb), 'message', v_message,
    'delivery', platform_auth.gateway_webhook_detail(p_tenant, v_w.id));
end $$;

-- ============================================================
-- 9. the duties
-- ============================================================

-- Counting the office is a different job from writing in it: 133's `control.money.post` lets a seat
-- move money, and a reconciliation must not be a thing a seat can raise because they can also post —
-- the report is meant to catch exactly the movements that seat made. So a count has its own key, held
-- by the seats that settle and adjudicate, and 133's three keys are not extended to reach it.
--
-- A statement is a read of the book and asks 133's `control.money.view`, which the analyst and the
-- auditor already hold: an office that cannot hand its accountant a line of the ledger has not got a
-- book, it has got a dashboard.
insert into permissions (key, description) values
  ('control.money.recon',
   'Control - Count the book against the papers, sign for another seat''s count and read its findings'),
  -- Retrying a delivery spends no money and changes no rail: it re-asks 009's idempotent completion to
  -- close a charge the rail already answered for. That is the act a support seat does while waiting on
  -- a rail, and it deliberately does not need 114's `control.gateway.manage`, which is the key that
  -- can switch a gateway off for every company on the platform.
  ('control.gateway.retry',
   'Control - Re-drive a verified delivery the office never acted on, and read the retry ledger')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.money.recon'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','finance_officer','compliance_officer')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.gateway.retry'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','support_engineer')
on conflict do nothing;

-- ============================================================
-- 10. grants on the doors
-- ============================================================

-- The scrub is called by the two gateway reads and by nothing else, and the four guard bodies are
-- fired, never called. A desk that could reach `scrub_gateway_payload` on its own could ask it about
-- any jsonb column in the schema and learn which key names this office hides — which is a map of where
-- the PII is not, and not worth the risk of a body nobody meant to expose.
revoke all on function
  platform_auth.recon_run_keeps_its_account(),
  platform_auth.recon_run_is_kept_once_signed(),
  platform_auth.recon_findings_are_kept(),
  platform_auth.webhook_attempt_is_kept(),
  platform_auth.scrub_gateway_payload(jsonb)
from public, anon, authenticated, app_runtime, service_role;

-- Four writes and five reads. A seat never INSERTs into a run, a finding or an attempt: it asks one of
-- these doors, and the door is where the audit row goes in as well as the paper.
grant execute on function
  platform_auth.run_money_reconciliation(uuid, text, text, date, date, uuid, text, text, text),
  platform_auth.sign_money_reconciliation_run(uuid, uuid, text, uuid, text, text, text),
  platform_auth.delete_money_reconciliation_run(uuid, uuid, text, uuid, text, text, text),
  platform_auth.retry_gateway_webhook(uuid, uuid, uuid, text, text, text),
  platform_auth.money_recon_board(uuid, text, text, text, text, int, int),
  platform_auth.money_recon_detail(uuid, uuid),
  platform_auth.money_statement(uuid, uuid, date, date, int, int),
  platform_auth.gateway_webhook_board(uuid, text, text, text, int, int),
  platform_auth.gateway_webhook_detail(uuid, uuid)
to app_runtime;

-- `create or replace function` hands EXECUTE back to PUBLIC, so every door is revoked after it is
-- granted — 114, 121, 126, 129, 131, 133 and 134 all list this and none of them trust the order.
revoke all on function
  platform_auth.run_money_reconciliation(uuid, text, text, date, date, uuid, text, text, text),
  platform_auth.sign_money_reconciliation_run(uuid, uuid, text, uuid, text, text, text),
  platform_auth.delete_money_reconciliation_run(uuid, uuid, text, uuid, text, text, text),
  platform_auth.retry_gateway_webhook(uuid, uuid, uuid, text, text, text),
  platform_auth.money_recon_board(uuid, text, text, text, text, int, int),
  platform_auth.money_recon_detail(uuid, uuid),
  platform_auth.money_statement(uuid, uuid, date, date, int, int),
  platform_auth.gateway_webhook_board(uuid, text, text, text, int, int),
  platform_auth.gateway_webhook_detail(uuid, uuid)
from public, anon, authenticated, service_role;

-- The number a run is minted from. A sequence left granted to a client role is a way for anybody to
-- burn a REC ref they will never use, and a register whose numbering skips is a register the office
-- has to explain.
revoke all on sequence recon_run_number_seq from public, anon, authenticated, app_runtime, service_role;

-- ============================================================
-- 11. say what this leaves the office in
-- ============================================================

do $$ declare
  v_tables   int;
  v_triggers int;
  v_defers   int;
  v_generated text;
  v_papers   bigint;
  v_writers  int;
  v_public   int;
  v_readers  int;
  v_missing  int;
  v_private  int;
  v_leaks    int;
  v_unswept  int;
  v_burners  int;
  v_duties   int;
  v_seats    int;
  v_now      record;
  v_then     record;
  v_doors    text[] := array[
    'run_money_reconciliation', 'sign_money_reconciliation_run',
    'delete_money_reconciliation_run', 'retry_gateway_webhook', 'money_recon_board',
    'money_recon_detail', 'money_statement', 'gateway_webhook_board', 'gateway_webhook_detail'];
  v_internal text[] := array[
    'recon_run_keeps_its_account', 'recon_run_is_kept_once_signed', 'recon_findings_are_kept',
    'webhook_attempt_is_kept', 'scrub_gateway_payload'];
  v_walls    text[] := array['money_reconciliation_runs', 'money_reconciliation_findings',
                              'gateway_webhook_attempts'];
begin
  -- The book this file was handed is the book it leaves. 135's header says a tool that finds drift
  -- must not be the thing that edits it, and the sentence is worth nothing unless something checks:
  -- every count, signature, discard, retry and statement read below it, run against the figures the
  -- witness row taken at the top of this file.
  select * into v_then from tmp_135_book_before;
  select * into v_now from (
    select (select count(*)::bigint from money_postings) as postings,
           (select count(*)::bigint from money_entries)  as legs,
           (select coalesce(sum(e.amount), 0) from money_entries e
             where e.direction = 'debit')                 as debited,
           (select coalesce(sum(e.amount), 0) from money_entries e
             where e.direction = 'credit')                as credited,
           (select coalesce(sum(a.debit_total), 0) from money_accounts a)  as cached_debit,
           (select coalesce(sum(a.credit_total), 0) from money_accounts a) as cached_credit,
           (select coalesce(sum(a.entry_count), 0)::bigint from money_accounts a) as cached_count,
           (select count(*)::bigint from money_accounts)  as lines
  ) s;
  if v_now.postings    <> v_then.postings    or v_now.legs         <> v_then.legs
     or v_now.debited  <> v_then.debited     or v_now.credited     <> v_then.credited
     or v_now.cached_debit   <> v_then.cached_debit
     or v_now.cached_credit  <> v_then.cached_credit
     or v_now.cached_count   <> v_then.cached_count
     or v_now.lines    <> v_then.lines then
    raise exception '135 wrote to the book: it was handed % posting(s) and % leg(s) netting %/% and '
      'leaves %/% netting %/%. A reconciliation reads money and never touches it',
      v_then.postings, v_then.legs, v_then.debited, v_then.credited,
      v_now.postings, v_now.legs, v_now.debited, v_now.credited;
  end if;

  -- Three registers, and this file opens the desks rather than filling them: a run, a finding or an
  -- attempt that exists before a seat has signed in is a row somebody wrote by hand.
  select count(*)::int into v_tables from pg_class
   where relkind = 'r' and relname = any (v_walls);
  if v_tables <> 3 then
    raise exception '135: % of its three tables exist', v_tables;
  end if;
  select (select count(*)::int from money_reconciliation_runs)
       + (select count(*)::int from money_reconciliation_findings)
       + (select count(*)::int from gateway_webhook_attempts) into v_papers;
  if v_papers <> 0 then
    raise exception '135: its registers already hold % row(s), and only 135''s doors may write them',
      v_papers;
  end if;

  -- Four guards, each firing on the operations its own body refuses. The attempt guard is asserted NOT
  -- to fire on DELETE because that is the choice this file made and the one an auditor could otherwise
  -- "fix": the cascade from a delivery is the sanctioned removal, and a trigger that refused it would
  -- be a trigger that breaks the foreign key's own promise.
  --
  -- The bits read here are the ones pg_trigger actually stores — 4 insert, 8 delete, 16 update,
  -- alongside 1 row and 2 before. They are easy to guess wrong: a "delete" test written as `& 2` passes
  -- on every before-trigger and fails on nothing else, which reads like a broken guard rather than a
  -- broken test. 134's `money_payouts_two_seats` (before insert or update) is 23 and its
  -- `money_payouts_are_kept` (before delete) is 11, so a live row on either shape settles the question.
  select count(*)::int into v_triggers from pg_trigger
   where tgname in ('money_recon_runs_keep_their_account', 'money_recon_runs_are_kept',
                    'money_recon_findings_are_kept', 'gateway_webhook_attempts_are_kept')
     and not tgisinternal and tgenabled = 'O';
  if v_triggers <> 4 then
    raise exception '135: % of the 4 guards are live and enabled', v_triggers;
  end if;
  if exists (select 1 from pg_trigger where tgname = 'gateway_webhook_attempts_are_kept'
              and (tgtype & 8) <> 0) then
    raise exception '135: the attempt guard fires on DELETE. It must not — a delivery taken away is '
      'supposed to take its attempts with it';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'money_recon_findings_are_kept'
                  and (tgtype & 8) <> 0 and (tgtype & 16) <> 0) then
    raise exception '135: the finding guard must refuse both a rewrite and a delete, or a signed run''s '
      'exceptions could be cut out of its report';
  end if;

  -- The door's whole ordering — findings first, then the run carrying their figures — stands on one
  -- deferrable cascade. If it ever comes up immediate, the insert below fails on a foreign key and the
  -- reconciliation cannot be raised at all, so the shape is pinned here rather than discovered then.
  select count(*)::int into v_defers from pg_constraint
   where contype = 'f' and conrelid = 'money_reconciliation_findings'::regclass
     and confrelid = 'money_reconciliation_runs'::regclass
     and condeferrable and condeferred;
  if v_defers <> 1 then
    raise exception '135: the findings->runs key is not a deferrable initially-deferred cascade, and '
      'the count door depends on writing its findings before its run';
  end if;

  -- The difference is the table's own arithmetic, not a figure a door typed. A finding whose difference
  -- disagreed with its own two sides would be a report that cannot be checked by the person reading it.
  select attgenerated into v_generated from pg_attribute
   where attrelid = 'money_reconciliation_findings'::regclass and attname = 'difference';
  if v_generated <> 's' then
    raise exception '135: findings.difference came up as % instead of a stored generated column',
      coalesce(v_generated, '(nothing)');
  end if;

  -- Read-only for every client role, and PUBLIC holds nothing anywhere: 005's own lesson about a
  -- register a stranger can push rows at, applied to the office's reports about it.
  select coalesce(count(*)::int, 0) into v_writers
    from pg_class c cross join aclexplode(c.relacl) a
   where c.relkind = 'r' and c.relname = any (v_walls)
     and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
     and a.grantee <> 0 and a.grantee <> c.relowner;
  if v_writers <> 0 then
    raise exception '135: % non-owner role(s) hold a write grant on its registers', v_writers;
  end if;
  select coalesce(count(*)::int, 0) into v_public
    from pg_class c cross join aclexplode(c.relacl) a
   where c.relname = any (v_walls) and a.grantee = 0;
  if v_public <> 0 then
    raise exception '135: PUBLIC still holds % privilege line(s) on its tables', v_public;
  end if;
  select coalesce(count(*)::int, 0) into v_readers
    from pg_class c cross join aclexplode(c.relacl) a
   where c.relname = any (v_walls) and a.privilege_type = 'SELECT'
     and a.grantee = (select oid from pg_roles where rolname = 'app_runtime');
  if v_readers <> 3 then
    raise exception '135: the app role reads % of the three registers — the boards are RLS-bound and '
      'must read all of them', v_readers;
  end if;
  if (select count(*)::int from pg_class where relkind = 'r' and relname = any (v_walls)
        and relrowsecurity) <> 3 then
    raise exception '135: one of the three registers came up without row-level security on';
  end if;

  -- Every door answers the app role and no client role, and every internal body answers nobody.
  select count(*)::int into v_missing
    from unnest(v_doors) d(fn)
   where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'platform_auth' and p.proname = d.fn
                        and has_function_privilege('app_runtime', p.oid, 'EXECUTE'));
  if v_missing <> 0 then
    raise exception '135: % of the 9 doors are not executable by the app role', v_missing;
  end if;
  select count(*)::int into v_unswept
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth' and p.proname = any (v_doors || v_internal)
     and p.proacl is null;
  select count(*)::int into v_private
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth' and p.proname = any (v_internal)
     and has_function_privilege('app_runtime', p.oid, 'EXECUTE');
  if v_private <> 0 then
    raise exception '135: % of its 4 guards and its payload scrubber still answer a caller — a body '
      'that erases a report or says which key names this office hides must not be a door', v_private;
  end if;
  select count(*)::int into v_leaks
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth'
     and p.proname = any (v_doors || v_internal)
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE')
          or has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if v_leaks <> 0 or v_unswept <> 0 then
    raise exception '135: % door(s) answer a client role and % still carry the default grantable ACL',
      v_leaks, v_unswept;
  end if;

  -- Nobody outside the doors may mint a run number.
  select count(*)::int into v_burners
    from unnest(array['recon_run_number_seq']) s(sq)
   where has_sequence_privilege('app_runtime', s.sq, 'USAGE')
      or has_sequence_privilege('authenticated', s.sq, 'USAGE');
  if v_burners <> 0 then
    raise exception '135: % sequence(s) can still be advanced by a client role', v_burners;
  end if;

  -- Two duties and five platform seats. `control.money.recon` is deliberately not handed to the seats
  -- that read the book all day: an analyst or an auditor who can both raise and sign a count can make
  -- a clean report appear without ever touching the money it describes.
  select count(*)::int into v_duties from permissions
   where key in ('control.money.recon', 'control.gateway.retry');
  if v_duties <> 2 then
    raise exception '135: % of its two duties are registered', v_duties;
  end if;
  select count(*)::int into v_seats
    from role_permissions rp join roles r on r.id = rp.role_id
   where r.tenant_id is null
     and ((r.key in ('super_admin','finance_officer','compliance_officer')
           and rp.permission_key = 'control.money.recon')
       or (r.key in ('super_admin','support_engineer')
           and rp.permission_key = 'control.gateway.retry'));
  if v_seats <> 5 then
    raise exception '135: its duties are held by % platform role line(s) instead of the 5 this file '
      'hands them out as', v_seats;
  end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id
              where r.tenant_id is null and rp.permission_key = 'control.money.recon'
                and r.key in ('platform_analyst','auditor','support_engineer')) then
    raise exception '135: a reader or a support seat was handed the pen on the counts; they raise '
      'findings to be signed, they do not sign them';
  end if;

  raise notice '135: the office can now count itself and answer for the rails — the book left exactly '
    'as it was found (% posting(s), % leg(s)), the three registers empty, 4 guards live, 9 doors '
    'swept and 2 duties out', v_now.postings, v_now.legs;
end $$;

commit;

