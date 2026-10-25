-- 134: the money that waits, and the money that leaves (task #344).
--
-- 133 built the book and said, in its own header, what it was holding back: "wallets, escrow holds
-- and payouts. Each of those is a state machine that must be signed by a second seat through 121's
-- register, and bolting an unsigned one-seat money move onto the book would put the weakest door on
-- the strongest table." This is those three state machines, and the rule they exist to keep is the
-- one 133 could not keep by itself: **money does not leave the office because one person decided it
-- should.**
--
-- What already existed, and why these registers are not a second copy of it:
--
--   * 005's `payments` is money arriving. Its status enum already carries `refunded`, and nothing has
--     ever written that value — a refund was a word on a payment row, not a movement. 126's
--     `service_refund_requests` is a *paper*: it is signed, and its own header says releasing the
--     paper does not release the money. The gap between the two is exactly this file's payout.
--   * 133 seeded ten accounts and named four of them for money this file moves: `WALLET-TZS` ("the
--     wallet book sits on this account"), `ESCROW-TZS`, `PAYOUT-DUE`, `REFUND-DUE`, plus `FEE-INCOME`
--     and `GATE-WAIT`. Every one of those accounts gets used here, and every leg still goes through
--     `platform_auth.record_money_posting`. **Nothing in 134 writes `money_entries`.** A register that
--     could post its own legs would be a register that can be out of balance, and the balance rule is
--     the reason 133 exists.
--   * There is no `balance` column anywhere in the schema and no wallet table. The nearest thing was
--     060/061's seeker search credit, which counts *searches*, not money, and has no refund path. So a
--     wallet here is not a cached number: it is a **liability line in the office's own book**, and its
--     balance is the sum of its legs, computed from `money_entries` at the moment a move is checked —
--     never from the cached figure 133 keeps for reading. A drift in a cached total must not be able
--     to let somebody spend money that is not there.
--
-- The three registers:
--
--   * `money_wallets` — one holder, one currency, one `WLT-…` liability account in the office's
--     chart, opened by the door and never typed. Money in (`fund`) and money across (`move`) are
--     postings the wallet's own account pays for, and a spend that exceeds the balance is refused
--     with both figures in the sentence. A frozen wallet stops its account as well as its row, so a
--     leg cannot land on money the office has stopped.
--   * `money_escrow_holds` — money parked against one real job (a booking, a cargo file, a call, a
--     dispute). One live hold per job: the same money cannot be parked twice against the same work.
--     The hold books it into `ESCROW-…`; nothing leaves escrow — to a payee, back to the payer, or in
--     a split — until a second seat has signed **the plan itself**, hashed as three figures and two
--     wallet ids, not a sentence typed beside a fresh id.
--   * `money_payout_batches` + `money_payouts` — money out. A payout names a payee (read out of the
--     company, driver or staff register by trigger, never typed), a rail from `money_payout_rails`,
--     the figure and the fee. Releasing the signature **accrues** it (the funding line is drained
--     against `PAYOUT-DUE`, or `REFUND-DUE` when the payout stands on a 126 refund paper); confirming
--     the cash left **pays** it (the payable is drained, the bank line credited, the fee booked to
--     `FEE-INCOME`). Two moments, two postings, and the office can answer "agreed and not yet paid"
--     from its own book instead of from a spreadsheet.
--
-- Two decisions worth stating out loud, because both cost the desk a button:
--
--   1. **Every payout needs a second seat, not only the large ones.** The panel's spec asked for
--      two-person approval "above a limit". A limit is a figure the raising seat can see, so a seat
--      that means to move money alone has only to post just under it, and a batch is one signature
--      either way. The rule that cannot be walked around is the one with no number in it.
--   2. **The payee's phone or account number is stored encrypted** — `payee_ref_encrypted` plus a
--      four-character tail and a keyed `payee_ref_hash` — because the house rule since 001 is that a
--      phone number is PII, and a payout instruction is a phone number attached to a name. No board,
--      detail or CSV in this file returns the whole line; the reveal is a route of its own, and the
--      hash is what goes into the signed payload, so a payout walked to a different number breaks its
--      own signature without the signature carrying the number.
--
-- Deliberately NOT here: reconciliation runs, the gateway webhook retry and a statement export (they
-- read this book and 133's, so they come after it); chargebacks and failed-money recovery beyond the
-- one `failed` path that reverses an accrual; wallet interest, multi-currency conversion inside one
-- posting (133's rule stands: one currency per movement, so a USD payout pays out of a USD line), and
-- any door that lets a seat choose which liability account a payout accrues against.
begin;

-- ============================================================
-- 1. the rails a payout can travel by
-- ============================================================

-- A third list of money-movement words in the same schema is how two boards stop counting against
-- each other, so the rails are data with one author, the way 130 made the modes of transport data
-- and 132 made the customs regimes data. The codes are 005's inbound provider words — a rail the
-- office *receives* through is also a rail it can *pay out* on — with `cash` added, because the
-- office pays cash and 005 has no word for money leaving. `azampesa` is not repeated here on
-- purpose: that is 114's gateway, a route in, not a line a clerk writes on a payout paper.
create table if not exists money_payout_rails (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,29}$'),
  -- The word a clerk reads. Uppercase words are for codes; this one is for a person.
  label text not null check (char_length(trim(label)) between 3 and 60),
  family text not null check (family in ('mobile_money','bank','cash')),
  -- What the payee line has to be. `phone` and `account` are the two shapes a payout can fail on,
  -- and the shape is a property of the rail, not of the desk that typed it.
  needs text not null check (needs in ('phone','account','none')),
  note text check (note is null or char_length(trim(note)) between 8 and 600),
  -- A rail stops being offered; it is never deleted. A payout paid on a rail last year has to be
  -- able to say what the rail was.
  retired boolean not null default false,
  sort int not null default 0
);

alter table money_payout_rails enable row level security;
create policy money_payout_rails_read on money_payout_rails for select to app_runtime using (true);
grant select on money_payout_rails to app_runtime;
revoke all on money_payout_rails from public, anon, authenticated, service_role;

insert into money_payout_rails (code, label, family, needs, note, sort) values
  ('mpesa',    'M-Pesa (Vodacom)',      'mobile_money', 'phone',
   'Paid to a registered +255 number. The number is the account.',            10),
  ('tigopesa', 'Tigo Pesa',             'mobile_money', 'phone',
   'Paid to a registered +255 number. The number is the account.',            20),
  ('airtel',   'Airtel Money',          'mobile_money', 'phone',
   'Paid to a registered +255 number. The number is the account.',            30),
  ('halopesa', 'Halopesa (ASL/Airtel)', 'mobile_money', 'phone',
   'The money-money rail 005 can also receive on. Same shape: a phone.',      40),
  ('bank',     'Bank transfer',         'bank',         'account',
   'Paid to an account number at a named bank. Needs a reference.',           50),
  ('cash',     'Cash at the desk',      'cash',         'none',
   'Handed over at the office. The paper is signed, the receipt is the audit.', 60)
on conflict (code) do nothing;

comment on column money_payout_rails.needs is
  'The shape the payee line must be. A rail that needs nothing must not carry an encrypted line at all.';

-- ============================================================
-- 2. the wallet: a holder's balance inside the office's book
-- ============================================================

create table if not exists money_wallets (
  id uuid primary key default gen_random_uuid(),
  -- Whose book the wallet's account lives in. The office's, always: a company's money is a liability
  -- line on the office's chart, which is why 133's tenant column is not the holder's.
  tenant_id uuid not null references tenants(id),
  -- Whose money this is. Never the office's own tenant — that pair is refused by CHECK below and by
  -- the trigger that reads the tenant.
  owner_tenant_id uuid not null references tenants(id),
  -- The liability line the wallet moves through. Minted by `open_money_wallet`, never typed: a code a
  -- desk could invent is a code that points at somebody else's balance.
  account_id uuid not null references money_accounts(id),
  currency text not null check (currency in ('TZS','USD')),
  -- Read off the tenant by trigger. The register must be able to say who it holds money for after the
  -- company has been renamed, which is why it is copied and not joined at read time — 126 and 131
  -- keep their paper's copy for the same reason.
  holder_name text not null check (char_length(trim(holder_name)) between 2 and 140),
  note text check (note is null or char_length(trim(note)) between 8 and 600),
  -- The wallet's own stop, kept beside the account's. 133's freeze stops legs; this says who stopped
  -- this holder and why, in the words the holder is given.
  status text not null default 'open' check (status in ('open','frozen')),
  frozen_reason text check (frozen_reason is null
                             or char_length(trim(frozen_reason)) between 8 and 600),
  frozen_by uuid references users(id),
  frozen_at timestamptz,
  opened_by uuid not null references users(id),
  opened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One balance per holder per money. A second TZS wallet for one company is not two accounts, it is
  -- one account the office has to add up by hand.
  constraint money_wallet_one_per_holder unique (owner_tenant_id, currency),
  constraint money_wallet_account_is_its_own unique (account_id),
  constraint money_wallet_freeze_is_explained
    check ((status = 'frozen') = (frozen_reason is not null)),
  check (tenant_id <> owner_tenant_id),
  check ((frozen_by is null) = (frozen_at is null))
);

create index money_wallets_board_idx on money_wallets (tenant_id, status, opened_at desc);
create index money_wallets_owner_idx on money_wallets (owner_tenant_id);
create trigger trg_money_wallets_updated before update on money_wallets
  for each row execute function public.set_updated_at();

alter table money_wallets enable row level security;
create policy money_wallets_tenant on money_wallets
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on money_wallets to app_runtime;
revoke all on money_wallets from public, anon, authenticated, service_role;

comment on column money_wallets.account_id is
  'The WLT-… liability line this balance lives on. Its figure is the sum of that account''s legs, never this row''s column.';
comment on column money_wallets.status is
  'A frozen wallet freezes its account too, so a leg cannot land on money the office has stopped.';

-- ============================================================
-- 3. the escrow hold: money parked against one job
-- ============================================================

create sequence if not exists escrow_hold_number_seq;

create table if not exists money_escrow_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ref text not null unique check (ref ~ '^ESC-[0-9]{4}-[0-9]{5,}$'),
  currency text not null check (currency in ('TZS','USD')),
  amount numeric(14,2) not null check (amount > 0 and amount <= 10000000000),

  -- The job the money is waiting for. A polymorphic subject has one table to point at, so the kind
  -- and the id are checked against each other by a trigger that reads the named table, finds the row
  -- and copies its number and its own account — the shape 131 proved for a held card.
  subject_kind text not null check (subject_kind in ('booking','cargo_file','call','dispute')),
  subject_id uuid not null,
  subject_ref text,
  subject_note text,
  subject_tenant_id uuid references tenants(id),

  -- Where the money came from and where it waits. `into` is derived from the currency by the door,
  -- so a desk cannot park money in an account that is not the book's escrow line.
  from_account_id uuid not null references money_accounts(id),
  payer_wallet_id uuid references money_wallets(id),
  into_account_id uuid not null references money_accounts(id),

  reason_code text not null check (reason_code in (
    'terms_violation','long_idle','payment_default','abuse','complaint','security','other')),
  reason text not null check (char_length(trim(reason)) between 8 and 600),

  -- raised: the paper exists. held: the money is in escrow (the posting is on the row).
  -- pending_discharge: a plan is on paper and a second seat is being asked to sign it.
  -- discharged: the signature was spent and the money moved.
  status text not null default 'raised' check (status in (
    'raised','held','pending_discharge','discharged')),
  hold_posting_id uuid references money_postings(id),
  discharge_posting_id uuid references money_postings(id),

  -- The plan. Three figures and one wallet: what the payee takes, what goes back to the payer, and
  -- what the office keeps. They add up to the held figure or the paper does not exist — the CHECK
  -- below is the only arithmetic this desk is allowed to do, and it is the arithmetic the second
  -- seat signs.
  discharge_kind text check (discharge_kind in ('released','refunded','split')),
  payee_wallet_id uuid references money_wallets(id),
  to_payee numeric(14,2) check (to_payee is null or (to_payee >= 0 and to_payee <= 10000000000)),
  back_to_payer numeric(14,2) check (back_to_payer is null
                                     or (back_to_payer >= 0 and back_to_payer <= 10000000000)),
  fee_amount numeric(14,2) check (fee_amount is null or (fee_amount >= 0 and fee_amount <= 10000000000)),

  approval_id uuid references platform_approvals(id),
  raised_by uuid not null references users(id),
  raised_at timestamptz not null default now(),
  held_at timestamptz,
  discharged_by uuid references users(id),
  discharged_at timestamptz,
  -- A refused plan is not a dead hold: the money stays parked and the paper can be planned again.
  -- The refusal is a fact on the row, because it is the first thing the next plan has to answer for.
  refusals int not null default 0 check (refusals >= 0),
  refused_by uuid references users(id),
  refused_at timestamptz,
  refused_note text check (refused_note is null
                            or char_length(trim(refused_note)) between 8 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The plan is three figures or it is nothing. Either all of them are set, or none.
  check ((discharge_kind is null) = (to_payee is null)),
  check (discharge_kind is null or (back_to_payer is not null and fee_amount is not null)),
  -- The rule that makes an escrow an escrow: the money out cannot exceed the money in, and the two
  -- sides plus the office's cut are the whole figure.
  check (discharge_kind is null
         or coalesce(to_payee, 0) + coalesce(back_to_payer, 0) + coalesce(fee_amount, 0) = amount),
  check (discharge_kind is null or discharge_kind <> 'refunded'
         or (to_payee = 0 and fee_amount = 0 and back_to_payer = amount)),
  check (discharge_kind is null or discharge_kind = 'refunded' or payee_wallet_id is not null),
  check (discharge_kind is null or discharge_kind <> 'split'
         or (to_payee > 0 and back_to_payer > 0)),
  check (discharge_kind is null or discharge_kind <> 'released'
         or (to_payee > 0 and back_to_payer = 0)),
  -- A hold paid out of a wallet, or released to one, must be in that wallet's money. A CHECK cannot
  -- read another table, so `escrow_wallets_hold_the_same_money` below asks both questions in the
  -- words a clerk gets back.
  check (status <> 'held' or hold_posting_id is not null),
  check (status <> 'pending_discharge' or (approval_id is not null and discharge_kind is not null)),
  check (status <> 'discharged' or (approval_id is not null and discharged_by is not null
                                    and discharged_at is not null
                                    and discharge_posting_id is not null)),
  check (refusals = 0 or (refused_by is not null and refused_at is not null
                          and char_length(trim(coalesce(refused_note, ''))) >= 8))
);

create index money_escrow_board_idx on money_escrow_holds (tenant_id, status, raised_at desc);
create index money_escrow_subject_idx on money_escrow_holds (subject_kind, subject_id);
create trigger trg_money_escrow_updated before update on money_escrow_holds
  for each row execute function public.set_updated_at();

-- One live hold against one job, and one signature per paper. The second is 131's, for the same
-- reason: an approval row that a paper does not point at is a signature nobody can spend.
create unique index if not exists money_escrow_one_live_per_job
  on money_escrow_holds (subject_kind, subject_id)
  where status in ('raised','held','pending_discharge');
create unique index if not exists money_escrow_one_approval
  on money_escrow_holds (approval_id) where approval_id is not null;

alter table money_escrow_holds enable row level security;
create policy money_escrow_tenant on money_escrow_holds
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on money_escrow_holds to app_runtime;
revoke all on money_escrow_holds from public, anon, authenticated, service_role;

comment on column money_escrow_holds.hold_posting_id is
  'The movement that put the money in escrow. A held paper without one cannot exist: the CHECK on the table says so.';
comment on column money_escrow_holds.discharge_kind is
  'The plan the second seat signed: released (all to the payee), refunded (all back to the payer), split (both).';

-- ============================================================
-- 4. the batch: a set of payouts signed as one sentence
-- ============================================================

create sequence if not exists payout_batch_number_seq;

create table if not exists money_payout_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ref text not null unique check (ref ~ '^PBT-[0-9]{4}-[0-9]{5,}$'),
  label text not null check (char_length(trim(label)) between 3 and 80),
  currency text not null check (currency in ('TZS','USD')),
  status text not null default 'open' check (status in (
    'open','pending_signature','released','closed')),
  -- Frozen by `propose_money_payout` from the lines that stand under it at that moment, and refused
  -- by trigger ever moving again. The second seat signs a total, so the total has to be a fact on the
  -- paper rather than a question the board re-asks after the signature.
  total_amount numeric(14,2) not null default 0 check (total_amount >= 0 and total_amount <= 100000000000),
  lines int not null default 0 check (lines >= 0),
  reason text check (reason is null or char_length(trim(reason)) between 8 and 600),
  approval_id uuid references platform_approvals(id),
  raised_by uuid not null references users(id),
  raised_at timestamptz not null default now(),
  released_by uuid references users(id),
  released_at timestamptz,
  closed_by uuid references users(id),
  closed_at timestamptz,
  closed_note text check (closed_note is null
                           or char_length(trim(closed_note)) between 8 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A paper that asks for a signature must be able to show what it is asking for, and a released
  -- batch must name the seat that spent the signature.
  check (status <> 'pending_signature' or (approval_id is not null and reason is not null)),
  check (status not in ('released','closed')
         or (approval_id is not null and released_by is not null and released_at is not null)),
  check (status = 'open' or (total_amount > 0 and lines > 0)),
  check ((released_by is null) = (released_at is null)),
  constraint money_payout_batch_one_approval unique (approval_id)
);

create index money_payout_batches_board_idx
  on money_payout_batches (tenant_id, status, raised_at desc);
create trigger trg_money_payout_batches_updated before update on money_payout_batches
  for each row execute function public.set_updated_at();

alter table money_payout_batches enable row level security;
create policy money_payout_batches_tenant on money_payout_batches
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on money_payout_batches to app_runtime;
revoke all on money_payout_batches from public, anon, authenticated, service_role;

comment on column money_payout_batches.total_amount is
  'The figure the second seat signed, copied from the batch''s own lines at propose time. It never moves after that.';

-- ============================================================
-- 5. the payout: money leaving the office
-- ============================================================

create sequence if not exists payout_number_seq;

create table if not exists money_payouts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ref text not null unique check (ref ~ '^PAY-[0-9]{4}-[0-9]{5,}$'),
  batch_id uuid references money_payout_batches(id),

  -- Who is paid. The kind and the id are checked against each other by trigger, which reads the named
  -- register and copies the name — so a payout cannot be walked to a person the office never had, and
  -- a deleted driver's paper says so out loud. `other` is the one kind with no register to read: it
  -- carries a typed name and no id, and the desk that raises it is the desk that signs for it.
  payee_kind text not null check (payee_kind in ('company','driver','staff','other')),
  payee_id uuid,
  payee_name text not null check (char_length(trim(payee_name)) between 2 and 140),
  payee_tenant_id uuid references tenants(id),

  rail_code text not null references money_payout_rails(code),
  -- The account or number the money goes to, encrypted the way 127 keeps an identity number: the
  -- whole line only ever leaves through the reveal route, the board prints the tail, and the keyed
  -- hash is what the signed payload carries, so a payout aimed at a different number breaks its own
  -- signature without the signature containing the number.
  payee_ref_encrypted bytea,
  payee_ref_tail text check (payee_ref_tail is null
                              or char_length(trim(payee_ref_tail)) between 1 and 4),
  payee_ref_hash text check (payee_ref_hash is null or payee_ref_hash ~ '^[0-9a-f]{64}$'),

  amount numeric(14,2) not null check (amount > 0 and amount <= 10000000000),
  -- The office's cut on this movement, added on top of what the payee is sent and booked to
  -- FEE-INCOME at the moment the cash leaves. A fee bigger than the money it rides on is a typing
  -- mistake, and the table says so.
  fee_amount numeric(14,2) not null default 0 check (fee_amount between 0 and amount),
  currency text not null check (currency in ('TZS','USD')),

  -- What the payout stands for. A pointer, not a foreign key, for 133's reason: 129's mask must not
  -- be able to reach the book through a paper. `refund` is the interlink the panel's money module
  -- asked for — 126's signed paper says a caller is owed and nothing has ever paid it — and the
  -- trigger reads that paper and refuses a payout that is not the figure the paper was signed for.
  source_kind text not null check (source_kind in (
    'manual','refund','payroll','wallet_withdrawal','cost')),
  source_id uuid,
  source_ref text check (source_ref is null or char_length(trim(source_ref)) between 3 and 60),
  purpose text not null check (char_length(trim(purpose)) between 8 and 600),

  -- raised: typed, unsigned, nothing booked. pending_signature: the second seat is being asked to sign
  -- exactly these bytes. released: the signature was spent and the obligation is accrued in the book.
  -- paid: the cash left and the fee was booked. failed: the rail said no and the accrual was answered
  -- by its mirror. declined: the second seat said no and nothing ever moved.
  status text not null default 'raised' check (status in (
    'raised','pending_signature','released','paid','failed','declined')),
  -- The three accounts the two moments use. All three are derived by the door from the currency, the
  -- source and the funding choice, and a trigger refuses a set that does not belong to this book or
  -- does not match this money — a desk cannot point a payout at a liability it invented.
  fund_account_id uuid not null references money_accounts(id),
  payable_account_id uuid not null references money_accounts(id),
  cash_account_id uuid not null references money_accounts(id),
  accrual_posting_id uuid references money_postings(id),
  payment_posting_id uuid references money_postings(id),

  approval_id uuid references platform_approvals(id),
  raised_by uuid not null references users(id),
  raised_at timestamptz not null default now(),
  released_by uuid references users(id),
  released_at timestamptz,
  paid_by uuid references users(id),
  paid_at timestamptz,
  paid_note text check (paid_note is null or char_length(trim(paid_note)) between 8 and 600),
  failed_by uuid references users(id),
  failed_at timestamptz,
  failure_reason text check (failure_reason is null
                              or char_length(trim(failure_reason)) between 8 and 600),
  declined_by uuid references users(id),
  declined_at timestamptz,
  declined_note text check (declined_note is null
                             or char_length(trim(declined_note)) between 8 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The payee line is a pair or it is nothing: a number with no tail cannot be quoted back by the
  -- desk that revealed it, and a tail with no number is a decoration.
  check ((payee_ref_encrypted is null) = (payee_ref_tail is null)),
  check (payee_ref_encrypted is null or payee_ref_hash is not null),
  -- A payout either names a register or names nobody: `other` cannot carry an id, and the three real
  -- kinds must.
  check ((payee_kind = 'other') = (payee_id is null)),
  -- Which company the money lands at, not which kind the payee is. `payee_names_its_payee` copies the
  -- tenant of a company, of a driver and of a staff member alike, so a rule that read the kind here
  -- would abort every payout to a person: a driver's own company is not `company`. Only `other` has
  -- no register to be from, and the guard nulls its company for exactly that reason.
  constraint money_payouts_payee_tenant_follows_kind
    check ((payee_kind = 'other') = (payee_tenant_id is null)),
  check (source_kind <> 'wallet_withdrawal' or payee_kind in ('company','other')),
  -- The state machine, in the table rather than in five routes.
  check (status <> 'pending_signature' or approval_id is not null),
  -- A line signed inside a batch carries no approval of its own: the signature is the batch's, and
  -- `money_payout_one_approval` below is exactly the reason it must stay NULL — two lines cannot each
  -- claim one signature. `payout_needs_two_seats` reads the batch's paper for those lines.
  check (status <> 'released' or (released_by is not null and released_at is not null
                                  and accrual_posting_id is not null
                                  and (approval_id is not null or batch_id is not null))),
  check (status <> 'paid' or (paid_by is not null and paid_at is not null
                              and payment_posting_id is not null
                              and char_length(trim(coalesce(paid_note, ''))) >= 8)),
  check (status <> 'failed' or (released_at is not null and failed_by is not null
                                and failed_at is not null
                                and char_length(trim(coalesce(failure_reason, ''))) >= 8)),
  check (status <> 'declined' or (declined_by is not null and declined_at is not null
                                  and char_length(trim(coalesce(declined_note, ''))) >= 8)),
  -- A signature is spent once, so one paper can stand under one.
  constraint money_payout_one_approval unique (approval_id),
  check ((released_by is null) = (released_at is null))
);

create index money_payouts_board_idx on money_payouts (tenant_id, status, raised_at desc);
create index money_payouts_batch_idx on money_payouts (batch_id) where batch_id is not null;
create index money_payouts_payee_idx on money_payouts (payee_kind, payee_id) where payee_id is not null;
create index money_payouts_rail_idx on money_payouts (rail_code, raised_at desc);
create trigger trg_money_payouts_updated before update on money_payouts
  for each row execute function public.set_updated_at();

alter table money_payouts enable row level security;
create policy money_payouts_tenant on money_payouts
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on money_payouts to app_runtime;
revoke all on money_payouts from public, anon, authenticated, service_role;

-- The rule just above is the one this file had backwards on its first run, and 134 is already
-- recorded, so the book has to be brought to it rather than re-migrated. The anonymous CHECK is
-- matched on its deparsed pair, which is 132's lesson about `pg_get_constraintdef` applied here: the
-- depicter casts the literal (`'company'::text`) and capitalises `IS NOT NULL`, so a needle built
-- from the typed words would find nothing and the drop would pass for a success. The new rule cannot
-- match the needle, so the whole block is a no-op the second time it runs.
do $$
declare
  v_rec record;
begin
  for v_rec in
    select conname from pg_constraint
     where conrelid = 'public.money_payouts'::regclass and contype = 'c'
       and lower(pg_get_constraintdef(oid))
             like '%payee_kind = ''company''%payee_tenant_id is not null%'
  loop
    execute 'alter table public.money_payouts drop constraint ' || quote_ident(v_rec.conname);
  end loop;
end $$;

alter table public.money_payouts
  drop constraint if exists money_payouts_payee_tenant_follows_kind,
  add constraint money_payouts_payee_tenant_follows_kind
    check ((payee_kind = 'other') = (payee_tenant_id is null));

comment on column money_payouts.payee_ref_hash is
  'Keyed hash of the payee line. It is what the signed payload carries, so the signature proves the number without containing it.';
comment on column money_payouts.payable_account_id is
  'PAYOUT-DUE, or REFUND-DUE when the payout stands on a signed 126 refund paper. Derived by the door, never typed.';

-- ============================================================
-- 6. the six control lines this file's doors derive
-- ============================================================

-- 133 seeded one currency's worth of chart and said a USD movement is never mixed into a TZS
-- posting. That rule is enforced by `money_leg_names_its_own_book`, which compares the leg's account
-- to the posting's currency — so a USD wallet, a USD hold and a USD payout each need a USD line to
-- point at, and a door that pointed them at a TZS account would be refused by 133's own trigger.
-- These five are those lines, plus the USD heading beside `WALLET-TZS`.
insert into money_accounts (tenant_id, code, label, kind, currency, note)
select t.id, c.code, c.label, c.kind, c.currency, c.note
  from (select id from tenants where type = 'platform' and deleted_at is null) t
 cross join (values
   ('WALLET-USD',   'Company balances held (USD)',   'liability', 'USD',
    'The heading the USD wallet lines sit under. Each holder''s money is on its own WLT- account.'),
   ('ESCROW-USD',   'Escrow held against a job (USD)', 'liability', 'USD',
    'Held until the job is done; released to one side and returned to the other.'),
   ('PAYOUT-DUE-USD','Payouts payable (USD)',        'liability', 'USD',
    'Money agreed out to a company or a driver and not yet paid.'),
   ('REFUND-DUE-USD','Refunds owed (USD)',           'liability', 'USD',
    'The 126 papers signed in USD, one line each, until the money leaves.'),
   ('FEE-INCOME-USD','Platform fee income (USD)',     'income',    'USD',
    'The office''s cut on a movement that carried one, booked when the cash left.'),
   ('COST-OPS-USD', 'Platform costs (USD)',           'expense',   'USD',
    'The USD side of what the office spends, so a USD payout has an expense to accrue against.')
 ) c(code, label, kind, currency, note)
where not exists (select 1 from money_accounts m where m.tenant_id = t.id and m.code = c.code);

-- The one correction this file makes to 133's chart. `WALLET-TZS` was seeded as an asset with the
-- note "the wallet book sits on this account". Money a company has put with the office is not the
-- office's asset and its own money — it is what the office owes, so the line is a liability. It was
-- seeded with no legs, so correcting its kind cannot move a figure: 133's own `money_book()` prints
-- the balance on the side the kind says, and until a leg lands on it both sides read zero.
update money_accounts
   set kind = 'liability',
       note = 'The heading the TZS wallet lines sit under. A holder''s spendable figure is on its '
           || 'own WLT- account, never here; the wallets board prints this group''s total, added up '
           || 'from those lines.'
 where tenant_id = (select id from tenants where type = 'platform' and deleted_at is null)
   and code = 'WALLET-TZS'
   and not exists (select 1 from money_entries e
                     where e.account_id = money_accounts.id);

comment on column money_wallets.account_id is
  'The WLT-… liability line this balance lives on, minted beside this row by `open_money_wallet`.';

-- Two helpers the guards and the doors below both call, so that one figure is written one way
-- everywhere. A signature is a hash of bytes, and a payload that prints `1000.0` in one door and
-- `1000.00` in the guard that checks it is a signature that cannot be spent.
create or replace function platform_auth.money_figure(p_amount numeric)
returns text language sql immutable set search_path = public as $$
  select trim(to_char(coalesce(p_amount, 0), 'FM999999999990.00'));
$$;

-- The office's own book, or nothing. A wallet, a hold and a payout are all lines of the company's
-- money as the office owes it, which only means something in the platform's chart; 133's doors take
-- the book from the session, and every door here is asked the same question first.
create or replace function platform_auth.money_move_is_the_office(p_tenant uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tenants t
                  where t.id = p_tenant and t.type = 'platform' and t.deleted_at is null);
$$;

-- ============================================================
-- 7. the guards: who a paper may name, and what a signature freezes
-- ============================================================

-- A wallet is opened by a door, but the rule it has to obey is written below the door, because the
-- rule is about two other tables. A holder that is the office itself, a person rather than a
-- company, or a tenant that has been deleted, would all make a wallet row that means nothing — and
-- `money_wallets` has no way to say so in a CHECK, since a CHECK cannot read `tenants`.
create or replace function platform_auth.money_wallet_holder_is_a_company()
returns trigger language plpgsql set search_path = public as $$
declare
  v_owner tenants%rowtype;
  v_book  tenants%rowtype;
begin
  select * into v_owner from tenants where id = new.owner_tenant_id;
  if not found then
    raise exception '134: a wallet cannot be opened for a company the office does not have'
      using errcode = '23514';
  end if;
  if v_owner.deleted_at is not null then
    raise exception '134: % was closed — money is not parked with a company that is gone',
      v_owner.name using errcode = '23514';
  end if;
  -- In this schema a company is a transporter or a shipper seat: `platform` is the office's own row
  -- and `seeker` is a person searching for a ride, neither of which holds money here.
  if v_owner.type not in ('transporter','shipper') then
    raise exception '134: % is a % account, and a wallet holds money for a company',
      v_owner.name, v_owner.type using errcode = '23514';
  end if;
  select * into v_book from tenants where id = new.tenant_id;
  if not found or v_book.type <> 'platform' then
    raise exception '134: a wallet''s balance is a line in the office''s own book, and this book is '
      'not the office''s' using errcode = '23514';
  end if;
  if new.holder_name <> v_owner.name then
    raise exception '134: this wallet is held for %, and the register says %',
      v_owner.name, new.holder_name using errcode = '23514';
  end if;
  return new;
end $$;

-- The account a wallet moves through is that wallet's own line: a liability in this book, in this
-- money, minted with the WLT- prefix. Read it as the pair the row already promises — the unique
-- indexes stop one account serving two wallets, and this stops a wallet serving an account it was
-- never minted for.
create or replace function platform_auth.money_wallet_owns_its_line()
returns trigger language plpgsql set search_path = public as $$
declare
  v money_accounts%rowtype;
begin
  select * into v from money_accounts where id = new.account_id;
  if not found then
    raise exception '134: % does not exist, so no wallet can hold money through it',
      new.account_id using errcode = '23514';
  end if;
  if v.tenant_id <> new.tenant_id then
    raise exception '134: % is not a line in the office''s book', v.code using errcode = '23514';
  end if;
  if v.kind <> 'liability' or v.code not like 'WLT-%' then
    raise exception '134: a wallet moves through its own WLT- liability line, and % is a % %',
      v.code, v.kind, lower(v.currency) using errcode = '23514';
  end if;
  if v.currency <> new.currency then
    raise exception '134: % holds % and this wallet is a % wallet — one money per line',
      v.code, v.currency, new.currency using errcode = '23514';
  end if;
  -- The line is not merely a WLT- liability in this money: it is the one this holder's door minted,
  -- and its code is the md5 of the holder and the money. `money_wallet_account_is_its_own` stops one
  -- line serving two wallets, and this stops a wallet being written onto a line minted for somebody
  -- else — which a hand could otherwise do to a holder that has no wallet yet, and which would leave
  -- that holder with a balance that is not theirs.
  if v.code <> 'WLT-' || upper(substr(md5(new.owner_tenant_id::text || '|' || new.currency), 1, 8))
                || '-' || new.currency then
    raise exception '134: % is not the line this holder''s % money mints — a wallet moves through '
      'the WLT- line its own company and money minted', v.code, new.currency
      using errcode = '23514';
  end if;
  return new;
end $$;

-- A wallet's identity is frozen at the moment it is opened. The holder, the money, the line and the
-- name it was opened under are not fields: they are the thing the balances below are sums of. A desk
-- that can re-point a wallet at another account can move money by editing a row instead of posting
-- a movement, and that is the one thing 133 was built to make impossible.
create or replace function platform_auth.money_wallet_identity_is_kept()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.owner_tenant_id <> old.owner_tenant_id or new.tenant_id <> old.tenant_id
     or new.account_id <> old.account_id or new.currency <> old.currency
     or new.holder_name <> old.holder_name or new.opened_by <> old.opened_by then
    raise exception
      '134: the wallet held for % in % is one holder, one money and one line — open a new wallet '
      'and move the balance through the book if that has to change',
      old.holder_name, old.currency using errcode = '23514';
  end if;
  if old.status = 'frozen' and new.status = 'open'
     and (new.frozen_by is not null or new.frozen_at is not null) then
    raise exception '134: an unfrozen wallet carries no freeze stamp — the door clears both'
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger money_wallets_name_their_holder
  before insert or update on money_wallets for each row
  execute function platform_auth.money_wallet_holder_is_a_company();
create trigger money_wallets_own_their_lines
  before insert or update on money_wallets for each row
  execute function platform_auth.money_wallet_owns_its_line();
create trigger money_wallets_keep_their_identity
  before update on money_wallets for each row
  execute function platform_auth.money_wallet_identity_is_kept();

-- The job a hold waits for, read out of the register that owns it, and copied onto the paper the way
-- 131 copies a card's name. A hold against a job the office never had is a place to hide money, and
-- a hold that can be walked from one job to another is a signature spent on work nobody agreed to.
-- Every note below is wrapped in `nullif(…, '')`: `concat_ws` answers an all-blank row with an empty
-- string rather than with NULL, so without it a paper whose job had nothing to say about it would pass
-- the last test in this function and print a hold with no job on it.
create or replace function platform_auth.escrow_names_its_subject()
returns trigger language plpgsql set search_path = public as $$
declare
  v_booking transport_bookings%rowtype;
  v_cargo   cargo_shipments%rowtype;
  v_call    support_tickets%rowtype;
  v_fight   service_disputes%rowtype;
begin
  if tg_op = 'UPDATE'
     and (new.subject_kind <> old.subject_kind or new.subject_id <> old.subject_id) then
    raise exception '134: % waits on % — raise a new hold for another job',
      old.ref, old.subject_note using errcode = '23514';
  end if;

  if new.subject_kind = 'booking' then
    select * into v_booking from transport_bookings where id = new.subject_id;
    if not found or v_booking.deleted_at is not null then
      raise exception '134: there is no booking % to hold money against',
        new.subject_id using errcode = '23514';
    end if;
    -- A booking has no number a clerk can say — 048 gave it an id and 044 gave its request one too —
    -- so the hold prints the id tail it was raised on rather than inventing a reference column.
    new.subject_ref := 'BK-' || upper(left(v_booking.id::text, 8));
    new.subject_note := nullif(left(concat_ws(' · ', nullif(trim(coalesce(v_booking.route_label, '')), ''),
      nullif(trim(coalesce(v_booking.cargo_label, '')), ''),
      nullif(trim(coalesce(v_booking.company_name, '')), '')), 600), '');
    new.subject_tenant_id := v_booking.tenant_id;
  elsif new.subject_kind = 'cargo_file' then
    select * into v_cargo from cargo_shipments where id = new.subject_id;
    if not found or v_cargo.deleted_at is not null then
      raise exception '134: there is no cargo file % to hold money against',
        new.subject_id using errcode = '23514';
    end if;
    new.subject_ref := v_cargo.file_number;
    new.subject_note := nullif(left(concat_ws(' · ',
      nullif(trim(coalesce(v_cargo.consignee_name, '')), ''),
      nullif(trim(coalesce(v_cargo.cargo_description, '')), '')), 600), '');
    new.subject_tenant_id := v_cargo.tenant_id;
  elsif new.subject_kind = 'call' then
    select * into v_call from support_tickets where id = new.subject_id;
    if not found or v_call.deleted_at is not null then
      raise exception '134: there is no call % to hold money against',
        new.subject_id using errcode = '23514';
    end if;
    new.subject_ref := v_call.ref;
    new.subject_note := nullif(left(concat_ws(' · ', nullif(trim(coalesce(v_call.subject, '')), ''),
      nullif(trim(coalesce(v_call.company_name, '')), '')), 600), '');
    new.subject_tenant_id := v_call.company_tenant_id;
  else
    select * into v_fight from service_disputes where id = new.subject_id;
    if not found or v_fight.deleted_at is not null then
      raise exception '134: there is no dispute % to hold money against',
        new.subject_id using errcode = '23514';
    end if;
    new.subject_ref := v_fight.ref;
    new.subject_note := nullif(left(concat_ws(' · ', nullif(trim(coalesce(v_fight.ground, '')), ''),
      nullif(trim(coalesce(v_fight.claim, '')), '')), 600), '');
    new.subject_tenant_id := v_fight.company_tenant_id;
  end if;
  if new.subject_ref is null or new.subject_note is null then
    raise exception '134: % cannot name the job it waits on', new.ref using errcode = '23514';
  end if;
  return new;
end $$;

create trigger money_escrow_names_its_job
  before insert or update on money_escrow_holds for each row
  execute function platform_auth.escrow_names_its_subject();

-- The two wallets and the two accounts a hold moves between, asked in one place. A payer wallet in
-- another money would let a TZS balance pay for a USD hold; a payee wallet in another money would
-- land the discharge on a line 133's own leg trigger refuses, after the paper had already been
-- stamped. Better to refuse the paper than to discover it at commit.
create or replace function platform_auth.escrow_wallets_hold_the_same_money()
returns trigger language plpgsql set search_path = public as $$
declare
  v_from  money_accounts%rowtype;
  v_into  money_accounts%rowtype;
  v_payer money_wallets%rowtype;
  v_payee money_wallets%rowtype;
begin
  select * into v_from from money_accounts where id = new.from_account_id;
  if not found or v_from.tenant_id <> new.tenant_id then
    raise exception '134: % takes money from a line that is not in the office''s book',
      new.ref using errcode = '23514';
  end if;
  select * into v_into from money_accounts where id = new.into_account_id;
  if not found or v_into.tenant_id <> new.tenant_id then
    raise exception '134: % parks money in a line that is not in the office''s book',
      new.ref using errcode = '23514';
  end if;
  if v_into.code <> 'ESCROW-' || new.currency then
    raise exception '134: money waits in ESCROW-%, and % points at %',
      new.currency, new.ref, v_into.code using errcode = '23514';
  end if;
  if v_from.code = v_into.code then
    raise exception '134: % would move money from a line onto the same line',
      new.ref using errcode = '23514';
  end if;
  if v_from.currency <> new.currency or v_into.currency <> new.currency then
    raise exception '134: % is held in % and its two lines are % and % — one money per movement',
      new.ref, new.currency, v_from.currency, v_into.currency using errcode = '23514';
  end if;
  if new.payer_wallet_id is not null then
    select * into v_payer from money_wallets where id = new.payer_wallet_id;
    if not found then
      raise exception '134: % names a payer wallet the office does not have',
        new.ref using errcode = '23514';
    end if;
    if v_payer.currency <> new.currency then
      raise exception '134: % is held for a % wallet and the money is %',
        new.ref, v_payer.currency, new.currency using errcode = '23514';
    end if;
    if v_payer.account_id <> new.from_account_id then
      raise exception '134: % comes out of the wallet held for %, whose own line is not the one this '
        'paper names', new.ref, v_payer.holder_name using errcode = '23514';
    end if;
  end if;
  if new.payee_wallet_id is not null then
    select * into v_payee from money_wallets where id = new.payee_wallet_id;
    if not found then
      raise exception '134: % names a payee wallet the office does not have',
        new.ref using errcode = '23514';
    end if;
    if v_payee.currency <> new.currency then
      raise exception '134: % releases to a % wallet and the money is %',
        new.ref, v_payee.currency, new.currency using errcode = '23514';
    end if;
    if new.payer_wallet_id = new.payee_wallet_id then
      raise exception '134: % would release money to the wallet it came from — that is a refund, and '
        '''refunded'' says so out loud', new.ref using errcode = '23514';
    end if;
    if new.discharge_kind = 'refunded' then
      raise exception '134: a refunded plan sends everything back to the payer, so it cannot name a '
        'payee wallet' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger money_escrow_wallets_match
  before insert or update on money_escrow_holds for each row
  execute function platform_auth.escrow_wallets_hold_the_same_money();

-- The plan a seat is asked to sign cannot move under the signature, and a discharged hold is a
-- finished paper. This is 131's window rule with figures in it: the second seat agreed to three
-- numbers and a wallet, and a desk that can quietly change one of them after the signature has spent
-- the paper has not been approved by a second seat at all.
create or replace function platform_auth.escrow_plan_is_kept()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.status = 'discharged' then
    raise exception '134: % is discharged and stays discharged — money that has left escrow is '
      'answered by a fresh movement, not by editing this paper',
      old.ref using errcode = '23514';
  end if;
  if old.status = 'pending_discharge'
     and (new.discharge_kind is distinct from old.discharge_kind
          or new.to_payee is distinct from old.to_payee
          or new.back_to_payer is distinct from old.back_to_payer
          or new.fee_amount is distinct from old.fee_amount
          or new.payee_wallet_id is distinct from old.payee_wallet_id
          or new.amount <> old.amount or new.currency <> old.currency) then
    raise exception
      '134: % is waiting on a signature over % to the payee, % back to the payer and % kept — the '
      'plan cannot move under it',
      old.ref, old.to_payee, old.back_to_payer, old.fee_amount using errcode = '23514';
  end if;
  if old.status in ('raised','held')
     and (new.amount <> old.amount or new.currency <> old.currency) then
    raise exception '134: % was raised for % % — the figure is set by the money that is parked',
      old.ref, old.amount, old.currency using errcode = '23514';
  end if;
  if old.status = 'held' and new.status = 'raised' then
    raise exception '134: % is holding % % — money that is in escrow does not un-park itself',
      old.ref, old.amount, old.currency using errcode = '23514';
  end if;
  return new;
end $$;

create trigger money_escrow_plan_kept
  before update on money_escrow_holds for each row
  execute function platform_auth.escrow_plan_is_kept();

-- Money leaves escrow on a second seat's signature, or not at all.
--
-- The signature is read from the register rather than trusted from the caller, exactly as 131 reads
-- it for a hold on a card, and then two more questions are asked that a card does not raise: was it
-- signed for *this* plan, and was it signed by a seat that is not the one releasing it? The figures
-- are compared against the payload's own text, because the payload is the bytes the hash was taken
-- of and a plan that answers to different numbers is a different paper.
create or replace function platform_auth.escrow_needs_two_seats()
returns trigger language plpgsql set search_path = public as $$
declare
  v platform_approvals%rowtype;
begin
  if new.status <> 'discharged' then return new; end if;
  select * into v from platform_approvals where id = new.approval_id;
  if not found
     or v.action <> 'money.escrow' or v.target_kind <> 'escrow_hold'
     or v.target_id <> new.id::text
     or v.status not in ('approved','applied')
     or v.decided_by = new.raised_by
     or v.decided_by is distinct from new.discharged_by then
    raise exception
      '134: % cannot leave escrow without a second seat''s signature on this plan (approval_id)',
      new.ref using errcode = '23514';
  end if;
  if v.payload ->> 'currency' <> new.currency
     or v.payload ->> 'amount' <> platform_auth.money_figure(new.amount)
     or v.payload ->> 'discharge_kind' <> new.discharge_kind
     or coalesce(v.payload ->> 'to_payee', '')
        <> platform_auth.money_figure(new.to_payee)
     or coalesce(v.payload ->> 'back_to_payer', '')
        <> platform_auth.money_figure(new.back_to_payer)
     or coalesce(v.payload ->> 'fee_amount', '')
        <> platform_auth.money_figure(new.fee_amount)
     or coalesce(v.payload ->> 'payee_wallet_id', '') <> coalesce(new.payee_wallet_id::text, '')
     or coalesce(v.payload ->> 'payer_wallet_id', '') <> coalesce(new.payer_wallet_id::text, '') then
    raise exception
      '134: % was signed for a different plan than the one being released — raise a new signature',
      new.ref using errcode = '23514';
  end if;
  return new;
end $$;

create trigger money_escrow_holds_two_seats
  before insert or update on money_escrow_holds for each row
  execute function platform_auth.escrow_needs_two_seats();

-- Escrow paper that has booked money is kept. The money is in the book either way, so a deleted hold
-- would be a movement the office cannot explain, and the way out of a hold is a signed discharge.
create or replace function platform_auth.escrow_is_not_deleted()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.hold_posting_id is not null then
    raise exception
      '134: % parked % % with a movement behind it — take the money out with a signed discharge, '
      'never by deleting the paper', old.ref, old.amount, old.currency
      using errcode = '23514';
  end if;
  return old;
end $$;

create trigger money_escrow_holds_are_kept
  before delete on money_escrow_holds for each row
  execute function platform_auth.escrow_is_not_deleted();

-- The payee is read out of a register, not typed beside a figure.
--
-- `company`, `driver` and `staff` are the three bodies the office already keeps, so a payout cannot
-- name a person who was never here, cannot be walked from one payee to another after a signature, and
-- still says who it paid after that person has been renamed or deleted. `other` is the one kind with
-- no register to read: it carries the desk's own typed name, and the door that raises it is the door
-- that says so in the audit.
create or replace function platform_auth.payout_names_its_payee()
returns trigger language plpgsql set search_path = public as $$
declare
  v_company tenants%rowtype;
  v_driver  drivers%rowtype;
  v_staff   employees%rowtype;
begin
  if tg_op = 'UPDATE' and (new.payee_kind <> old.payee_kind
                           or new.payee_id is distinct from old.payee_id) then
    raise exception '134: % is aimed at % — raise a new payout for anybody else',
      old.ref, old.payee_name using errcode = '23514';
  end if;

  if new.payee_kind = 'company' then
    select * into v_company from tenants where id = new.payee_id;
    if not found then
      raise exception '134: the office has no company %', new.payee_id using errcode = '23514';
    end if;
    if v_company.type = 'platform' then
      raise exception '134: % is the office itself — money does not leave the office to itself',
        v_company.name using errcode = '23514';
    end if;
    new.payee_name := v_company.name;
    new.payee_tenant_id := v_company.id;
  elsif new.payee_kind = 'driver' then
    select * into v_driver from drivers where id = new.payee_id;
    if not found then
      raise exception '134: the office has no driver %', new.payee_id using errcode = '23514';
    end if;
    new.payee_name := v_driver.full_name;
    new.payee_tenant_id := v_driver.tenant_id;
  elsif new.payee_kind = 'staff' then
    select * into v_staff from employees where id = new.payee_id;
    if not found then
      raise exception '134: the office has no staff member %', new.payee_id using errcode = '23514';
    end if;
    new.payee_name := v_staff.full_name;
    new.payee_tenant_id := v_staff.tenant_id;
  else
    new.payee_tenant_id := null;
  end if;
  return new;
end $$;

create trigger money_payouts_name_their_payee
  before insert or update on money_payouts for each row
  execute function platform_auth.payout_names_its_payee();

-- What the payee line has to be is a property of the rail, so the rail is asked and the answer is
-- enforced here rather than trusted from the desk. `phone` and `account` want the whole encrypted
-- line, its tail and its keyed hash; `none` wants nothing at all, because a cash payout that carries
-- an account number is a paper that will be read out to the wrong person.
create or replace function platform_auth.payout_line_fits_its_rail()
returns trigger language plpgsql set search_path = public as $$
declare
  v money_payout_rails%rowtype;
begin
  select * into v from money_payout_rails where code = new.rail_code;
  if not found then
    raise exception '134: % is not a rail the office pays on',
      new.rail_code using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and v.retired then
    raise exception '134: % was retired as a rail — a payout is not raised on a line the office '
      'stopped using', v.code using errcode = '23514';
  end if;
  if v.needs = 'none' then
    if new.payee_ref_encrypted is not null or new.payee_ref_hash is not null then
      raise exception '134: % is paid % , so this paper must carry no account line',
        new.ref, v.label using errcode = '23514';
    end if;
  elsif new.payee_ref_encrypted is null or new.payee_ref_hash is null then
    raise exception '134: % is paid on % and needs the payee''s % written on it',
      new.ref, v.label, case v.needs when 'phone' then 'number' else 'account' end
      using errcode = '23514';
  elsif v.needs = 'phone' and new.payee_ref_tail !~ '^[0-9]{4}$' then
    raise exception '134: %''s payee line ends % , which is not the tail of a phone number',
      new.ref, new.payee_ref_tail using errcode = '23514';
  elsif v.needs = 'account' and new.payee_ref_tail !~ '^[A-Za-z0-9]{1,4}$' then
    raise exception '134: %''s payee line ends % , which is not the tail of an account number',
      new.ref, new.payee_ref_tail using errcode = '23514';
  end if;
  return new;
end $$;

create trigger money_payouts_fit_their_rails
  before insert or update on money_payouts for each row
  execute function platform_auth.payout_line_fits_its_rail();

-- A payout that stands on a paper must stand on the whole paper.
--
-- This is the interlink the money module asked for and the reason 005's `refunded` has never been
-- written: 126's signed paper says a caller is owed, and the only way it can stop saying so is a
-- payout that names it. The figure and the money are compared against the paper, and the company
-- against the payee, so a refund cannot be paid short, paid in another money, or paid to somebody
-- who did not make the call.
create or replace function platform_auth.payout_source_is_a_real_paper()
returns trigger language plpgsql set search_path = public as $$
declare
  v_refund service_refund_requests%rowtype;
  v_run    payroll_runs%rowtype;
  v_wallet money_wallets%rowtype;
begin
  if new.source_kind = 'manual' then
    return new;
  end if;
  if new.source_kind = 'cost' then
    if new.source_ref is null then
      raise exception '134: a cost payout names what it pays for in %', new.ref
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.source_id is null then
    raise exception '134: a % payout stands on a paper, and % names none',
      new.source_kind, new.ref using errcode = '23514';
  end if;

  if new.source_kind = 'refund' then
    select * into v_refund from service_refund_requests where id = new.source_id;
    if not found then
      raise exception '134: % stands on a refund paper the office does not have',
        new.ref using errcode = '23514';
    end if;
    if v_refund.status <> 'released' then
      raise exception '134: the refund paper % is %, and only a released one owes money — signing '
        'a paper is not paying it', v_refund.ref, v_refund.status using errcode = '23514';
    end if;
    if v_refund.amount <> new.amount or v_refund.currency <> new.currency then
      raise exception '134: % was signed for % % and this payout is % % — the caller is owed what '
        'the paper says', v_refund.ref, v_refund.amount, v_refund.currency,
        new.amount, new.currency using errcode = '23514';
    end if;
    if new.payee_kind <> 'company' or new.payee_tenant_id is distinct from v_refund.company_tenant_id then
      raise exception '134: % is owed to %, not to %',
        v_refund.ref, v_refund.company_name, new.payee_name using errcode = '23514';
    end if;
  elsif new.source_kind = 'payroll' then
    select * into v_run from payroll_runs where id = new.source_id;
    if not found or v_run.deleted_at is not null then
      raise exception '134: there is no payroll run % to pay out of',
        new.source_id using errcode = '23514';
    end if;
    if v_run.currency <> new.currency then
      raise exception '134: run % is a % run and this payout is in %',
        to_char(v_run.period, 'YYYY-MM'), v_run.currency, new.currency using errcode = '23514';
    end if;
    if new.amount > v_run.net_total then
      raise exception '134: run % nets % and this payout is % — the office does not pay a run more '
        'than it issued', to_char(v_run.period, 'YYYY-MM'), v_run.net_total, new.amount
        using errcode = '23514';
    end if;
  else
    select * into v_wallet from money_wallets where id = new.source_id;
    if not found then
      raise exception '134: % withdraws from a wallet the office does not have',
        new.ref using errcode = '23514';
    end if;
    if v_wallet.currency <> new.currency then
      raise exception '134: the wallet held for % is a % wallet and this withdrawal is in %',
        v_wallet.holder_name, v_wallet.currency, new.currency using errcode = '23514';
    end if;
    if v_wallet.account_id <> new.fund_account_id then
      raise exception '134: a withdrawal drains the wallet it names, and % is not funded from that '
        'line', new.ref using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger money_payouts_stand_on_real_papers
  before insert or update on money_payouts for each row
  execute function platform_auth.payout_source_is_a_real_paper();

-- The three lines a payout moves between, checked instead of trusted.
--
-- All three are derived by the door from the currency, the source and the rail, and a seat that
-- could point a payout at a liability it invented would be able to move money into an account the
-- office has never reconciled. So the payable has to be the book's own due line for this source and
-- money, the funding line has to be one that can be drained, and the cash line has to be the asset
-- this rail actually pays out of. A frozen line is refused here in words — "the office stopped that
-- account" — rather than as 133's leg error after the paper has been stamped.
create or replace function platform_auth.payout_accounts_are_honest()
returns trigger language plpgsql set search_path = public as $$
declare
  v_fund    money_accounts%rowtype;
  v_payable money_accounts%rowtype;
  v_cash    money_accounts%rowtype;
  v_rail    money_payout_rails%rowtype;
  v_payname text;
  v_cashname text;
begin
  select * into v_fund from money_accounts where id = new.fund_account_id;
  if not found or v_fund.tenant_id <> new.tenant_id then
    raise exception '134: % is funded from a line that is not in the office''s book',
      new.ref using errcode = '23514';
  end if;
  select * into v_payable from money_accounts where id = new.payable_account_id;
  if not found or v_payable.tenant_id <> new.tenant_id then
    raise exception '134: % accrues to a line that is not in the office''s book',
      new.ref using errcode = '23514';
  end if;
  select * into v_cash from money_accounts where id = new.cash_account_id;
  if not found or v_cash.tenant_id <> new.tenant_id then
    raise exception '134: % is paid out of a line that is not in the office''s book',
      new.ref using errcode = '23514';
  end if;
  select * into v_rail from money_payout_rails where code = new.rail_code;

  if new.currency = 'USD' then
    v_payname := case new.source_kind when 'refund' then 'REFUND-DUE-USD' else 'PAYOUT-DUE-USD' end;
    v_cashname := 'OPS-USD';
  else
    v_payname := case new.source_kind when 'refund' then 'REFUND-DUE' else 'PAYOUT-DUE' end;
    v_cashname := case when v_rail.family = 'cash' then 'OPS-CASH' else 'OPS-BANK' end;
  end if;
  if v_payable.code <> v_payname then
    raise exception '134: a % payout stands on % and accrues to %, not to %',
      new.source_kind, new.currency, v_payname, v_payable.code using errcode = '23514';
  end if;
  if v_cash.code <> v_cashname then
    raise exception '134: money paid on % in % leaves through %, not %',
      v_rail.label, new.currency, v_cashname, v_cash.code using errcode = '23514';
  end if;
  if v_fund.kind not in ('liability','expense') then
    -- The kind is printed inside a sentence a desk reads aloud to a caller, so the article has to
    -- agree with it: `a expense line` is the sort of slip that makes the whole voice sound machine-made.
    -- A `RAISE` format knows only `%`, so the article is built whole rather than glued to a `%s`, which
    -- this file first wrote and which printed the literal `s` after the placeholder.
    raise exception '134: % is % % line, and a payout drains a liability or books an expense',
      v_fund.code,
      case when left(v_fund.kind, 1) in ('a','e','i','o','u') then 'an' else 'a' end,
      v_fund.kind using errcode = '23514';
  end if;
  if new.source_kind = 'wallet_withdrawal' and v_fund.code not like 'WLT-%' then
    raise exception '134: % is a withdrawal, and a withdrawal drains the holder''s own wallet line',
      new.ref using errcode = '23514';
  end if;
  if new.source_kind <> 'wallet_withdrawal' and v_fund.code <> 'COST-OPS'
     and v_fund.code <> 'COST-OPS-USD' then
    raise exception '134: the chart has one expense line for money the office pays out, and % is %',
      new.ref, v_fund.code using errcode = '23514';
  end if;
  if v_fund.currency <> new.currency or v_payable.currency <> new.currency
     or v_cash.currency <> new.currency then
    raise exception '134: % is a % payout and its three lines are %, % and % — one money per '
      'movement', new.ref, new.currency, v_fund.currency, v_payable.currency, v_cash.currency
      using errcode = '23514';
  end if;
  if v_fund.code = v_payable.code or v_payable.code = v_cash.code
     or v_fund.code = v_cash.code then
    raise exception '134: % would move money through the same line twice',
      new.ref using errcode = '23514';
  end if;
  if v_fund.status = 'frozen' then
    raise exception '134: % is frozen — %', v_fund.label, v_fund.frozen_reason
      using errcode = '23514';
  end if;
  if v_payable.status = 'frozen' then
    raise exception '134: % is frozen — %', v_payable.label, v_payable.frozen_reason
      using errcode = '23514';
  end if;
  if v_cash.status = 'frozen' then
    raise exception '134: % is frozen — %', v_cash.label, v_cash.frozen_reason
      using errcode = '23514';
  end if;
  -- The office's cut has to land somewhere, and the door that books it cannot invent the line. A
  -- paper with a fee and a book with no open fee income line is refused here, in the words the desk
  -- can act on, rather than at the moment the cash has already been confirmed as left.
  if new.fee_amount > 0 and not exists (select 1 from money_accounts m
        where m.tenant_id = new.tenant_id
          and m.code = 'FEE-INCOME' || case when new.currency = 'USD' then '-USD' else '' end
          and m.status = 'open') then
    raise exception '134: % carries a % fee and this book has no open FEE-INCOME line in %',
      new.ref, new.fee_amount, new.currency using errcode = '23514';
  end if;
  return new;
end $$;

create trigger money_payouts_name_honest_lines
  before insert or update on money_payouts for each row
  execute function platform_auth.payout_accounts_are_honest();

-- A payout line belongs to one batch, in one money, and joins it while the batch is still a draft.
-- Once the batch has asked for a signature its lines are the figure the second seat read, so a line
-- cannot be added to it, leave it, or have its figure edited under it.
create or replace function platform_auth.payout_line_fits_its_batch()
returns trigger language plpgsql set search_path = public as $$
declare
  v money_payout_batches%rowtype;
  o money_payout_batches%rowtype;
begin
  -- A line that stands in no batch, and never did, is not this guard's business.
  if new.batch_id is null and (tg_op = 'INSERT' or old.batch_id is null) then return new; end if;
  if new.batch_id is not null then
    select * into v from money_payout_batches where id = new.batch_id;
    if not found then
      raise exception '134: % names a batch the office does not have', new.ref using errcode = '23514';
    end if;
    if v.currency <> new.currency then
      raise exception '134: % is a % batch and % is a % line',
        v.ref, v.currency, new.ref, new.currency using errcode = '23514';
    end if;
  end if;
  -- The batch a line stands in is decided when the line is raised. Both edges of it used to be written
  -- as `new.batch_id <> old.batch_id`, which is NULL on the leaving side and on the joining side's old
  -- row, so neither arm could ever fire: a hand could pull a line out of a batch the office had just
  -- signed, and — worse — push one into a batch that had already asked, where the release loop pays
  -- every line it finds. The leaving arm names the batch the line actually stands in, which the old
  -- sentence got from the destination and so said the opposite of what it refused.
  if tg_op = 'UPDATE' and new.batch_id is distinct from old.batch_id then
    if old.batch_id is not null then
      select * into o from money_payout_batches where id = old.batch_id;
      raise exception '134: % belongs to % and stays in it', new.ref, o.ref using errcode = '23514';
    end if;
    if v.status <> 'open' then
      raise exception '134: % is % — nothing is added to a batch that has already asked for or spent a '
        'signature', v.ref, v.status using errcode = '23514';
    end if;
  end if;
  if tg_op = 'INSERT' and v.status <> 'open' then
    raise exception '134: % is % — nothing is added to a batch that has already asked for or spent a '
      'signature', v.ref, v.status using errcode = '23514';
  end if;
  if v.status <> 'open'
     and (new.amount <> old.amount or new.fee_amount <> old.fee_amount
          or new.currency <> old.currency or new.rail_code <> old.rail_code
          or new.payee_kind <> old.payee_kind or new.payee_id <> old.payee_id
          or new.payee_ref_hash is distinct from old.payee_ref_hash) then
    raise exception '134: % has a signature standing on its total — % cannot be edited under it',
      v.ref, new.ref using errcode = '23514';
  end if;
  return new;
end $$;

create trigger money_payouts_fit_their_batches
  before insert or update on money_payouts for each row
  execute function platform_auth.payout_line_fits_its_batch();

-- The figure the second seat signs cannot move under the signature, and a released payout cannot be
-- walked back into a draft. What may still change after a signature is only the state machine's own
-- stamps: who spent it, who confirmed the cash, and the sentences they typed.
create or replace function platform_auth.payout_frozen_after_signature()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.status in ('pending_signature','released','paid','failed','declined')
     and (new.amount <> old.amount or new.fee_amount <> old.fee_amount
          or new.currency <> old.currency or new.rail_code <> old.rail_code
          or new.payee_kind <> old.payee_kind or new.payee_id is distinct from old.payee_id
          or new.payee_ref_hash is distinct from old.payee_ref_hash
          or new.payee_ref_encrypted is distinct from old.payee_ref_encrypted
          or new.source_kind <> old.source_kind or new.source_id is distinct from old.source_id
          or new.fund_account_id <> old.fund_account_id
          or new.payable_account_id <> old.payable_account_id
          or new.cash_account_id <> old.cash_account_id
          or new.approval_id is distinct from old.approval_id
          or new.batch_id is distinct from old.batch_id) then
    raise exception '134: % is % — the figure, the payee, the rail and the lines it was signed on '
      'are frozen', old.ref, old.status using errcode = '23514';
  end if;
  if old.status in ('paid','failed','declined')
     and new.status is distinct from old.status then
    raise exception '134: % is % and stays % — a movement that has answered is answered with a new '
      'paper', old.ref, old.status, old.status using errcode = '23514';
  end if;
  if old.status = 'released' and new.status = 'raised' then
    raise exception '134: % has been accrued by a spent signature; a failed payment is marked failed, '
      'not un-signed', old.ref using errcode = '23514';
  end if;
  return new;
end $$;

create trigger money_payouts_keep_their_signed_figure
  before update on money_payouts for each row
  execute function platform_auth.payout_frozen_after_signature();

-- Money does not leave the office because one seat decided it should.
--
-- Either the paper carries its own signature or the batch it stands in does, and in both cases the
-- signature is read back out of 121's register: same action, same target, decided by a seat that is
-- not the one that raised it, spent by the seat that is releasing the money, and hashed over the
-- bytes this row still holds. A payout whose numbers were changed after the signature fails the last
-- question, which is the whole point of hashing a paper instead of a sentence.
create or replace function platform_auth.payout_needs_two_seats()
returns trigger language plpgsql set search_path = public as $$
declare
  v platform_approvals%rowtype;
  b money_payout_batches%rowtype;
  v_signed boolean;
begin
  if new.status not in ('released','paid') then return new; end if;
  if new.approval_id is not null then
    select * into v from platform_approvals where id = new.approval_id;
    if not found
       or v.action <> 'money.payout' or v.target_kind <> 'payout'
       or v.target_id <> new.id::text
       or v.status not in ('approved','applied')
       or v.decided_by is null or v.decided_by = new.raised_by
       or v.decided_by <> new.released_by then
      raise exception '134: % cannot be released without a second seat''s signature on this payout '
        '(approval_id)', new.ref using errcode = '23514';
    end if;
    if v.payload ->> 'currency' <> new.currency
       or v.payload ->> 'amount' <> platform_auth.money_figure(new.amount)
       or v.payload ->> 'fee_amount' <> platform_auth.money_figure(new.fee_amount)
       or v.payload ->> 'rail_code' <> new.rail_code
       or v.payload ->> 'payee' <> new.payee_name
       or coalesce(v.payload ->> 'payee_ref_hash', '') <> coalesce(new.payee_ref_hash, '')
       or v.payload ->> 'source_kind' <> new.source_kind then
      raise exception '134: % was signed for a different payout than the one being released — raise '
        'a new signature', new.ref using errcode = '23514';
    end if;
    return new;
  end if;

  if new.batch_id is null then
    raise exception '134: % cannot be released: a payout is signed on its own paper or on the batch '
      'it stands in', new.ref using errcode = '23514';
  end if;
  select * into v from platform_approvals
    where id = (select ba.approval_id from money_payout_batches ba where ba.id = new.batch_id);
  v_signed := found;
  select * into b from money_payout_batches where id = new.batch_id;
  if not v_signed or b.approval_id is null or b.status not in ('released','closed')
     or v.action <> 'money.payout' or v.target_kind <> 'payout_batch'
     or v.target_id <> b.id::text or v.status not in ('approved','applied')
     or v.decided_by is null or v.decided_by = b.raised_by
     or v.decided_by <> new.released_by then
    raise exception '134: % cannot be released without a second seat''s signature on % (approval_id)',
      new.ref, b.ref using errcode = '23514';
  end if;
  if v.payload ->> 'currency' <> new.currency
     or v.payload ->> 'total_amount' <> platform_auth.money_figure(b.total_amount)
     or v.payload ->> 'lines' <> b.lines::text then
    raise exception '134: % was signed for a batch of % line(s) totalling % % — this line does not '
      'stand under that signature', new.ref,
      coalesce(v.payload ->> 'lines', 'nothing'),
      coalesce(v.payload ->> 'total_amount', 'nothing'), b.currency using errcode = '23514';
  end if;
  return new;
end $$;

create trigger money_payouts_two_seats
  before insert or update on money_payouts for each row
  execute function platform_auth.payout_needs_two_seats();

-- A payout that has accrued money in the book is kept, whoever tries to remove it: the movement
-- stands under it and the office has to be able to say which paper the movement answered.
create or replace function platform_auth.payout_is_not_deleted()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.accrual_posting_id is not null or old.payment_posting_id is not null then
    raise exception '134: % has a movement behind it — mark it failed and the accrual is answered by '
      'its mirror, never by deleting the paper', old.ref using errcode = '23514';
  end if;
  return old;
end $$;

create trigger money_payouts_are_kept
  before delete on money_payouts for each row
  execute function platform_auth.payout_is_not_deleted();

-- The batch signs a total, so the total is a fact on the paper and not a question the board re-asks
-- after the signature. These two guards are what makes that true: the figures frozen at propose time
-- cannot move, and a batch that has booked anything cannot be removed.
create or replace function platform_auth.payout_batch_figures_are_kept()
returns trigger language plpgsql set search_path = public as $$
begin
  -- `reason` is in this list because it is the sentence the second seat signed, not a note the desk
  -- keeps to itself: a batch that has asked for a signature and then had its reason rewritten would be
  -- a different paper under the same name. `propose_money_payout_batch` is the only caller that writes
  -- it, and it moves the batch back to `open` in its own statement first, so this guard never stands
  -- in that door's way.
  if old.status in ('pending_signature','released','closed')
     and (new.total_amount <> old.total_amount or new.lines <> old.lines
          or new.currency <> old.currency or new.label <> old.label
          or new.approval_id is distinct from old.approval_id
          or new.reason is distinct from old.reason) then
    raise exception '134: % is % carrying % line(s) for % % — the signed total does not move',
      old.ref, old.status, old.lines, old.total_amount, old.currency
      using errcode = '23514';
  end if;
  if old.status = 'open' and new.status = 'closed' then
    raise exception '134: % is still a draft — a batch is closed from its signature, not from the '
      'board', old.ref using errcode = '23514';
  end if;
  if old.status in ('released','closed') and new.status = 'open' then
    raise exception '134: % has spent a signature and does not go back to a draft',
      old.ref using errcode = '23514';
  end if;
  return new;
end $$;

create trigger money_payout_batches_keep_their_totals
  before update on money_payout_batches for each row
  execute function platform_auth.payout_batch_figures_are_kept();

create or replace function platform_auth.payout_batch_is_not_deleted()
returns trigger language plpgsql set search_path = public as $$
declare
  v_lines int;
begin
  select count(*) into v_lines from money_payouts where batch_id = old.id;
  if old.status <> 'open' or v_lines > 0 then
    raise exception '134: % is % and holds % line(s) — a batch that has asked for a signature is '
      'kept', old.ref, old.status, v_lines using errcode = '23514';
  end if;
  return old;
end $$;

create trigger money_payout_batches_are_kept
  before delete on money_payout_batches for each row
  execute function platform_auth.payout_batch_is_not_deleted();

-- ============================================================
-- 8. the doors: the wallet, the hold and the payout
-- ============================================================

/**
 * Every movement this file books is composed here and handed to 133's `record_money_posting`.
 *
 * A leg is a line the second seat has to be able to read back, so the figure is printed with
 * `money_figure` — the same expression the signature's payload is hashed over — and the sentence is
 * cut to the 200 characters 133's `detail` column will accept. A leg whose figure is zero is not a
 * leg at all: 133 refuses it, so `money_leg` returns an empty array and the door's `||` adds nothing.
 * That is how an optional third side of a split discharge is written without five if-blocks.
 */
create or replace function platform_auth.money_leg(
  p_account uuid, p_side text, p_amount numeric, p_detail text
) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when coalesce(p_amount, 0) <= 0 then '[]'::jsonb
    else jsonb_build_array(jsonb_build_object(
      'account', p_account,
      'direction', p_side,
      'amount', platform_auth.money_figure(p_amount),
      'detail', case when char_length(trim(coalesce(p_detail, ''))) >= 3
                     then left(trim(p_detail), 200) end))
  end;
$$;

-- The audit row every door writes. 126, 129 and 131 each spell the insert out; here the shape is
-- asked for twenty times, so it is kept once and the doors pass their own before and after.
create or replace function platform_auth.money_audit(
  p_tenant uuid, p_actor uuid, p_role text, p_ip text, p_ua text,
  p_entity text, p_id uuid, p_action text, p_before jsonb, p_after jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_logs (tenant_id, actor_user_id, actor_role, ip, user_agent,
      entity, entity_id, action, before, after)
  values (p_tenant, p_actor, nullif(trim(coalesce(p_role, '')), ''),
          nullif(trim(coalesce(p_ip, '')), ''), left(coalesce(p_ua, ''), 300),
          p_entity, p_id, p_action, p_before, p_after);
end $$;

-- The figure a wallet holds, asked of the legs and never of the cached column.
--
-- 133 keeps `debit_total`/`credit_total` on the account so a register read does not walk the book, and
-- prints both beside the recomputed pair because a cached figure is a claim. A door that decided
-- whether money could leave from that claim would be a door that lets money leave when a trigger got
-- it wrong. So the balance is `credits - debits` over the wallet's own line, read under the row lock
-- the caller holds.
create or replace function platform_auth.money_wallet_balance(p_wallet uuid)
returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(case when e.direction = 'credit' then e.amount else -e.amount end), 0)
    from money_entries e
    join money_wallets w on w.account_id = e.account_id
   where w.id = p_wallet;
$$;

-- The line a seat pays money into, read from the word a desk chooses instead of a uuid it types.
-- `gateway` is 114's money-not-yet-confirmed line, which is why a USD wallet cannot be funded from
-- it: the office has one gateway, in one money, and 133 refuses a movement that changes currency.
create or replace function platform_auth.money_inflow_account(
  p_tenant uuid, p_from text, p_currency text
) returns uuid
language plpgsql stable set search_path = public as $$
declare
  v_code text;
  v_id   uuid;
begin
  v_code := case lower(trim(coalesce(p_from, '')))
    when 'bank'    then case when p_currency = 'USD' then 'OPS-USD'   else 'OPS-BANK'  end
    when 'cash'    then case when p_currency = 'USD' then 'OPS-USD'   else 'OPS-CASH'  end
    when 'gateway' then case when p_currency = 'USD' then 'GATE-USD'  else 'GATE-WAIT' end
    else null
  end;
  if v_code is null then
    raise exception '134: money comes into a wallet from the bank, the desk or the gateway — "%" is '
      'none of those', coalesce(p_from, '(nothing)');
  end if;
  select id into v_id from money_accounts
    where tenant_id = p_tenant and code = v_code and currency = p_currency;
  if v_id is null then
    if p_currency = 'USD' and lower(trim(p_from)) = 'gateway' then
      raise exception '134: the office receives money in % on one rail, and there is no % gateway '
        'line to fund a wallet from', p_currency, p_currency;
    end if;
    raise exception '134: this book has no open % line to take money in', v_code;
  end if;
  return v_id;
end $$;

-- The three lines a payout moves between, derived in one place because the guard below refuses any
-- other set. A seat is never offered a choice of liability account: the money, the paper the payout
-- stands on and the rail it travels by decide it, and that is the whole function.
create or replace function platform_auth.money_payout_accounts(
  p_tenant uuid, p_currency text, p_source_kind text, p_rail_family text, p_fund_wallet uuid
) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_out    jsonb;
  v_fund   uuid;
  v_pay    uuid;
  v_cash   uuid;
  v_paycode text;
  v_cashcode text;
begin
  v_paycode := case p_source_kind
    when 'refund' then case when p_currency = 'USD' then 'REFUND-DUE-USD' else 'REFUND-DUE' end
    else case when p_currency = 'USD' then 'PAYOUT-DUE-USD' else 'PAYOUT-DUE' end
  end;
  v_cashcode := case
    when p_currency = 'USD' then 'OPS-USD'
    when p_rail_family = 'cash' then 'OPS-CASH'
    else 'OPS-BANK'
  end;
  select jsonb_build_object(
           'fund',    case when p_source_kind = 'wallet_withdrawal' then w.account_id
                           else (select a.id from money_accounts a
                                  where a.tenant_id = p_tenant
                                    and a.code = case when p_currency = 'USD'
                                                      then 'COST-OPS-USD' else 'COST-OPS' end) end,
           'payable', (select a.id from money_accounts a
                        where a.tenant_id = p_tenant and a.code = v_paycode),
           'cash',    (select a.id from money_accounts a
                        where a.tenant_id = p_tenant and a.code = v_cashcode),
           'fee',     (select a.id from money_accounts a
                        where a.tenant_id = p_tenant
                          and a.code = case when p_currency = 'USD'
                                            then 'FEE-INCOME-USD' else 'FEE-INCOME' end)
         )
    into v_out
    from (select 1) one
    left join money_wallets w on w.id = p_fund_wallet;
  if v_out ->> 'fund' is null or v_out ->> 'payable' is null or v_out ->> 'cash' is null then
    raise exception '134: a % payout needs its fund, payable and cash lines and this book does not '
      'have all three (payable would be %, cash %)', p_currency, v_paycode, v_cashcode;
  end if;
  return v_out;
end $$;

-- ------------------------------------------------------------
-- 8a. the wallet
-- ------------------------------------------------------------

/**
 * Open a holder's wallet: one company, one money, one liability line in the office's book.
 *
 * The account code is minted from the holder and the currency, not typed at the desk, because a code
 * a seat could invent is a code that points at somebody else's balance. Nothing is posted here: an
 * empty wallet is a line with no legs, and an opening figure is the office's to declare with
 * `fund_money_wallet` or 133's `opening` movement, not a migration's or a door's.
 */
-- 134's doors keep their own audit rows, exactly as 126's refund paper, 129's erasure and 131's hold
-- do: the seat that spends a signature arrives through `approvals.ts`, which has no route-level
-- `writeAudit` of its own, and a money movement whose only record is a screen is not audited. So the
-- role, the ip and the user-agent are passed down with the actor and written beside every act.
create or replace function platform_auth.open_money_wallet(
  p_tenant uuid, p_owner_tenant uuid, p_currency text, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner tenants%rowtype;
  v_acct  jsonb;
  v_accid uuid;
  v_code  text;
  v_label text;
  v_cur   text;
  v_row   money_wallets;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    raise exception '134: a wallet is a line in the office''s own book';
  end if;
  if not exists (select 1 from users u where u.id = p_actor and u.tenant_id = p_tenant
                   and u.status = 'active' and u.deleted_at is null) then
    raise exception '134: only a live seat in the office''s book can open a wallet';
  end if;
  v_cur := upper(trim(coalesce(nullif(trim(p_currency), ''), 'TZS')));
  if v_cur not in ('TZS', 'USD') then
    raise exception '134: a wallet holds % or %, and "%" is neither', 'TZS', 'USD', v_cur;
  end if;
  select * into v_owner from tenants where id = p_owner_tenant;
  if not found or v_owner.deleted_at is not null or v_owner.type not in ('transporter','shipper') then
    raise exception '134: a wallet holds money for a live company, and % is not one',
      coalesce(v_owner.name, '(no such company)');
  end if;

  -- The one-per-holder rule is the register's own unique index, but that index sits behind a line
  -- that has already been minted: 133's `open_money_account` refuses a second account of the same
  -- `WLT-…` code first, and answers with the account's name rather than the company's. A desk that
  -- offers a wallet twice for one holder has to hear who already holds one, so the pair is asked
  -- here, before anything exists to be rolled back. The index stays as the answer to two seats
  -- clicking in the same instant, which is what the `unique_violation` handler below is for.
  if exists (select 1 from money_wallets w where w.tenant_id = p_tenant
               and w.owner_tenant_id = v_owner.id and w.currency = v_cur) then
    raise exception '134: % already holds a % wallet — one balance per company per money',
      v_owner.name, v_cur;
  end if;

  v_code := 'WLT-' || upper(substr(md5(v_owner.id::text || '|' || v_cur), 1, 8)) || '-' || v_cur;
  -- The register gives a company 120 characters and 133 gives an account label 80, so a long name has
  -- to be shortened somewhere before the line can be opened. It is clamped here rather than refused:
  -- a company whose name runs long is still owed a balance, and a desk cannot be told to rename its
  -- customer before it can hold their money. The code stays the minted one, so the line is still
  -- unique and still says whose money it is.
  v_label := left(v_owner.name || ' — wallet (' || v_cur || ')', 80);
  v_acct := platform_auth.open_money_account(p_tenant, v_code,
    v_label, 'liability', v_cur,
    'Opened by the wallet door for ' || left(v_owner.name, 500) || '. Money the office holds and owes.',
    p_actor);
  v_accid := nullif(v_acct ->> 'id', '')::uuid;
  if v_accid is null then
    raise exception '134: the wallet''s line was not opened, so no wallet was made';
  end if;

  insert into money_wallets (tenant_id, owner_tenant_id, account_id, currency, holder_name,
                             note, opened_by)
  values (p_tenant, v_owner.id, v_accid, v_cur, v_owner.name,
          nullif(trim(coalesce(p_note, '')), ''), p_actor)
  returning * into v_row;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_wallets', v_row.id, 'wallet.opened', null,
    jsonb_build_object('holder', v_row.holder_name, 'currency', v_row.currency,
      'account', v_acct ->> 'code', 'wallet', v_row.id, 'note', v_row.note));

  return jsonb_build_object('ok', true,
    'wallet', platform_auth.money_wallet_detail(p_tenant, v_row.id));
exception when unique_violation then
  raise exception '134: % already holds a % wallet — one balance per company per money',
    v_owner.name, v_cur;
end $$;

-- Money into a wallet. The line that takes it is named by a word the desk chooses, the wallet is
-- locked while its balance is read, and nothing is checked against the cached figure.
create or replace function platform_auth.fund_money_wallet(
  p_tenant uuid, p_wallet uuid, p_amount numeric, p_from text, p_memo text,
  p_posted_on date, p_actor uuid, p_role text, p_ip text, p_ua text, p_idempotency text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_wallet money_wallets;
  v_in     uuid;
  v_legs   jsonb;
  v_post   jsonb;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    raise exception '134: only the office''s book can hold a wallet balance';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000000 then
    raise exception '134: money going into a wallet is a figure above zero, and this is %',
      coalesce(p_amount::text, '(nothing)');
  end if;
  if char_length(trim(coalesce(p_memo, ''))) < 8 or char_length(trim(p_memo)) > 200 then
    raise exception '134: a movement into a wallet needs the sentence that says where the money came '
      'from — 8-200 characters';
  end if;
  select * into v_wallet from money_wallets
    where id = p_wallet and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_wallet.status = 'frozen' then
    return jsonb_build_object('ok', false, 'error', 'frozen',
      'message', 'This wallet is frozen: ' || v_wallet.frozen_reason,
      'holder', v_wallet.holder_name);
  end if;

  v_in := platform_auth.money_inflow_account(p_tenant, p_from, v_wallet.currency);
  v_legs := platform_auth.money_leg(v_in, 'debit', p_amount,
              'Into the wallet held for ' || v_wallet.holder_name)
         || platform_auth.money_leg(v_wallet.account_id, 'credit', p_amount,
              v_wallet.holder_name || ' balance, in from ' || lower(trim(p_from)));

  v_post := platform_auth.record_money_posting(p_tenant,
    coalesce(p_posted_on, current_date), left(trim(p_memo), 200), v_wallet.currency,
    'payment', v_wallet.id,
    -- A movement's `source_ref` is the line a later reader quotes, and 133 keeps it to 60 characters
    -- while a company's name may run to 140. Clamped rather than refused: the money has been taken
    -- in either way, and a desk cannot be told to shorten a holder's name to be paid.
    left(v_wallet.holder_name || ' ' || v_wallet.currency, 60),
    p_idempotency, p_actor, v_legs);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_wallets', v_wallet.id, 'wallet.funded',
    jsonb_build_object('balance', platform_auth.money_wallet_balance(v_wallet.id) - p_amount),
    jsonb_build_object('amount', p_amount, 'currency', v_wallet.currency,
      'from', lower(trim(p_from)),
      'posting', v_post -> 'posting' ->> 'ref',
      'balance', platform_auth.money_wallet_balance(v_wallet.id)));

  return jsonb_build_object('ok', true, 'replayed', (v_post ->> 'replayed')::boolean,
    'wallet', platform_auth.money_wallet_detail(p_tenant, v_wallet.id),
    'posting', v_post -> 'posting');
end $$;

-- A balance moved between two of the office's own wallets: one holder paying another. Both lines are
-- locked in the same order every time (by id), because two desks moving money the other way round in
-- the same second would otherwise be waiting on each other until one of them was cancelled.
create or replace function platform_auth.move_money_wallet(
  p_tenant uuid, p_from_wallet uuid, p_to_wallet uuid, p_amount numeric, p_memo text,
  p_posted_on date, p_actor uuid, p_role text, p_ip text, p_ua text, p_idempotency text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_from money_wallets;
  v_to   money_wallets;
  v_bal  numeric;
  v_legs jsonb;
  v_post jsonb;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    raise exception '134: a wallet balance only moves inside the office''s book';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000000 then
    raise exception '134: a balance moved is a figure above zero, and this is %',
      coalesce(p_amount::text, '(nothing)');
  end if;
  if char_length(trim(coalesce(p_memo, ''))) < 8 or char_length(trim(p_memo)) > 200 then
    raise exception '134: moving money between holders needs 8-200 characters of reason';
  end if;
  if p_from_wallet = p_to_wallet then
    raise exception '134: a balance moved into the wallet it left is not a movement';
  end if;

  -- One statement, one order. `FOR UPDATE` takes the rows as `ORDER BY` reads them, so two desks
  -- moving the same money the other way round in the same second both queue for the lower id first.
  -- Locked in the order the desk named them instead, the pair would deadlock and Postgres would
  -- cancel one of the two movements — and a cancelled movement is a page the office has to retype.
  perform 1 from money_wallets
    where id in (p_from_wallet, p_to_wallet) and tenant_id = p_tenant
    order by id for update;

  select * into v_from from money_wallets
    where id = p_from_wallet and tenant_id = p_tenant;
  if not found then return jsonb_build_object('ok', false, 'error', 'from_not_found'); end if;
  select * into v_to from money_wallets
    where id = p_to_wallet and tenant_id = p_tenant;
  if not found then return jsonb_build_object('ok', false, 'error', 'to_not_found'); end if;

  if v_from.status = 'frozen' or v_to.status = 'frozen' then
    return jsonb_build_object('ok', false, 'error', 'frozen',
      'message', 'A frozen wallet takes no movement in either direction',
      'holder', case when v_from.status = 'frozen' then v_from.holder_name else v_to.holder_name end);
  end if;
  if v_from.currency <> v_to.currency then
    raise exception '134: % holds % and % holds % — a balance that changes money is two movements '
      'with an exchange line between them, and this book has no exchange yet',
      v_from.holder_name, v_from.currency, v_to.holder_name, v_to.currency;
  end if;

  v_bal := platform_auth.money_wallet_balance(p_from_wallet);
  if v_bal < p_amount then
    return jsonb_build_object('ok', false, 'error', 'short',
      'message', 'This holder does not have that money to move',
      'holder', v_from.holder_name, 'balance', v_bal, 'amount', p_amount,
      'currency', v_from.currency, 'short_by', p_amount - v_bal);
  end if;

  v_legs := platform_auth.money_leg(v_from.account_id, 'debit', p_amount,
              'Out of ' || v_from.holder_name || '''s balance')
         || platform_auth.money_leg(v_to.account_id, 'credit', p_amount,
              v_to.holder_name || ' balance, moved in');
  -- 133's list of source kinds has no `transfer`: a balance moved between two of the office's own
  -- holders is the office's own pen, which is exactly what `manual` means there. The two holders are
  -- named in the memo and in `source_ref`, so the register still says whose money went where.
  v_post := platform_auth.record_money_posting(p_tenant,
    coalesce(p_posted_on, current_date), left(trim(p_memo), 200), v_from.currency,
    'manual', p_to_wallet,
    -- Two names and an arrow do not fit inside the 60 characters 133 gives a `source_ref`, so the
    -- pair is clamped: the two legs and the locked rows are what prove the movement, and the ref is
    -- the quote a clerk reads back.
    left(v_from.holder_name || ' -> ' || v_to.holder_name, 60),
    p_idempotency, p_actor, v_legs);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_wallets', p_from_wallet, 'wallet.moved',
    jsonb_build_object('balance', v_bal),
    jsonb_build_object('amount', p_amount, 'currency', v_from.currency,
      'from_holder', v_from.holder_name, 'to_holder', v_to.holder_name,
      'to_balance', platform_auth.money_wallet_balance(p_to_wallet),
      'posting', v_post -> 'posting' ->> 'ref'));

  return jsonb_build_object('ok', true, 'replayed', (v_post ->> 'replayed')::boolean,
    'from', platform_auth.money_wallet_detail(p_tenant, p_from_wallet),
    'to', platform_auth.money_wallet_detail(p_tenant, p_to_wallet),
    'posting', v_post -> 'posting');
end $$;

-- Stop a holder's money. The wallet and its line are frozen together, because 133's leg guard is the
-- thing that actually refuses a movement and it reads the account, not this row.
create or replace function platform_auth.freeze_money_wallet(
  p_tenant uuid, p_wallet uuid, p_reason text, p_actor uuid, p_frozen boolean,
  p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v money_wallets;
  v_acct jsonb;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    raise exception '134: freezing a wallet is the office stopping its own money';
  end if;
  select * into v from money_wallets where id = p_wallet and tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p_frozen and v.status = 'frozen' then
    return jsonb_build_object('ok', false, 'error', 'already', 'holder', v.holder_name,
      'reason', v.frozen_reason);
  end if;
  if not p_frozen and v.status = 'open' then
    return jsonb_build_object('ok', false, 'error', 'already_open', 'holder', v.holder_name);
  end if;
  if p_frozen and char_length(trim(coalesce(p_reason, ''))) < 8 then
    raise exception '134: stopping a wallet needs a sentence the holder is going to be told';
  end if;

  v_acct := platform_auth.freeze_money_account(p_tenant, v.account_id,
    case when p_frozen then 'Wallet stopped: ' || left(trim(p_reason), 500) end,
    p_actor, p_frozen);

  update money_wallets
     set status = case when p_frozen then 'frozen' else 'open' end,
         frozen_reason = case when p_frozen then trim(p_reason) end,
         frozen_by = case when p_frozen then p_actor end,
         frozen_at = case when p_frozen then now() end
   where id = v.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_wallets', v.id, case when p_frozen then 'wallet.frozen' else 'wallet.unfrozen' end,
    jsonb_build_object('status', v.status, 'reason', v.frozen_reason),
    jsonb_build_object('status', case when p_frozen then 'frozen' else 'open' end,
      'holder', v.holder_name, 'reason', trim(coalesce(p_reason, '')),
      'balance', platform_auth.money_wallet_balance(v.id),
      -- 133's two doors answer a line in two shapes: `open_money_account` returns the row itself, so
      -- `wallet.opened` reads `->>'code'`, while `freeze_money_account` wraps it under `account`. Read
      -- it the flat way here and every stop would be audited with a null line — which is exactly the
      -- coupling this call exists to prove.
      'account', v_acct -> 'account' ->> 'code'));

  return jsonb_build_object('ok', true,
    'wallet', platform_auth.money_wallet_detail(p_tenant, v.id));
end $$;

-- ------------------------------------------------------------
-- 8b. the escrow hold
-- ------------------------------------------------------------

/**
 * Park money against one job, in one call.
 *
 * 133's rule is that a register and the book may not disagree, and a hold is the register that most
 * easily does it: the desk writes "one million is waiting on this dispute" while the money is still
 * sitting in the operating line. So the paper and the movement are made together here — the row is
 * inserted, the movement is booked through 133's own door, and only then does the paper say `held`.
 * A call that fails at any of the three steps leaves nothing behind, because all three are one
 * transaction and a half-raised hold is not a thing the office can read.
 *
 * The money comes out of a holder's wallet when the desk names one, and out of the office's own line
 * when it does not: a hold raised on a call whose money the office is fronting has no payer wallet,
 * and a `refunded` plan sends that money back to the line it came from. `gateway` is refused as a
 * source, because money the rail has not yet confirmed is not money the office can park.
 *
 * The subject word is answered here rather than left to the guard below, because the guard reads
 * anything that is not a booking, a file, a call or a dispute as a dispute — so a desk that typed an
 * eighth word would be told there is no dispute with that id, which is a sentence about a paper nobody
 * mentioned. Every other vocabulary this door takes is answered the same way.
 */
create or replace function platform_auth.raise_money_escrow(
  p_tenant uuid, p_subject_kind text, p_subject_id uuid, p_amount numeric, p_currency text,
  p_payer_wallet uuid, p_from text, p_reason_code text, p_reason text, p_posted_on date,
  p_actor uuid, p_role text, p_ip text, p_ua text, p_idempotency text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id     uuid;
  v_hold   money_escrow_holds;
  v_payer  money_wallets;
  v_open   money_escrow_holds;
  v_from   uuid;
  v_into   uuid;
  v_bal    numeric;
  v_ccy    text;
  v_code   text;
  v_kind   text;
  v_reason text;
  v_legs   jsonb;
  v_post   jsonb;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    raise exception '134: money waits in escrow only in the office''s own book';
  end if;
  v_kind := lower(trim(coalesce(p_subject_kind, '')));
  if p_subject_id is null
     or v_kind not in ('booking','cargo_file','call','dispute') then
    return jsonb_build_object('ok', false, 'error', 'bad_subject',
      'message', 'A hold names the job it waits on: a booking, a cargo file, a call or a dispute.',
      'subject_kind', p_subject_kind);
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000000 then
    return jsonb_build_object('ok', false, 'error', 'bad_amount',
      'message', 'The figure held is above zero and no larger than the book carries.',
      'amount', p_amount);
  end if;
  v_ccy := upper(trim(coalesce(p_currency, '')));
  if v_ccy not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'bad_currency',
      'message', 'Escrow is held in TZS or USD.');
  end if;
  v_code := lower(trim(coalesce(p_reason_code, '')));
  if v_code not in ('terms_violation','long_idle','payment_default','abuse','complaint',
                    'security','other') then
    return jsonb_build_object('ok', false, 'error', 'bad_reason_code',
      'message', 'That is not one of the seven reasons a hold is raised for.',
      'reason_code', p_reason_code);
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters what the money is waiting for: it is the sentence the '
        || 'second seat reads before signing the plan.');
  end if;

  if p_payer_wallet is not null then
    select * into v_payer from money_wallets
      where id = p_payer_wallet and tenant_id = p_tenant for update;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'payer_not_found');
    end if;
    if v_payer.currency <> v_ccy then
      return jsonb_build_object('ok', false, 'error', 'currency_mismatch',
        'message', 'The payer wallet holds a different money from the hold being raised.',
        'holder', v_payer.holder_name, 'wallet_currency', v_payer.currency, 'currency', v_ccy);
    end if;
    if v_payer.status = 'frozen' then
      return jsonb_build_object('ok', false, 'error', 'frozen',
        'message', 'A stopped wallet''s money is not the office''s to park',
        'holder', v_payer.holder_name, 'reason', v_payer.frozen_reason);
    end if;
    v_from := v_payer.account_id;
    v_bal := platform_auth.money_wallet_balance(p_payer_wallet);
    if v_bal < p_amount then
      return jsonb_build_object('ok', false, 'error', 'short',
        'message', 'This holder does not have that money to park',
        'holder', v_payer.holder_name, 'balance', v_bal, 'amount', p_amount,
        'currency', v_ccy, 'short_by', p_amount - v_bal);
    end if;
  else
    if lower(trim(coalesce(p_from, ''))) not in ('bank','cash') then
      return jsonb_build_object('ok', false, 'error', 'bad_from',
        'message', 'A hold without a payer wallet is parked from the office''s bank or its till. '
          || 'Money the rail has only reported and not confirmed waits on the gateway line until 135 '
          || 'reconciles it, and the office cannot park what it has not been paid.');
    end if;
    v_from := platform_auth.money_inflow_account(p_tenant, p_from, v_ccy);
  end if;

  select a.id into v_into from money_accounts a
    where a.tenant_id = p_tenant and a.code = 'ESCROW-' || v_ccy and a.status = 'open';
  if v_into is null then
    raise exception '134: this book has no open ESCROW-% line for money to wait in', v_ccy;
  end if;

  -- The savepoint is 131's: the one-live-hold-per-job index is the answer a retrying desk gets, and
  -- a caught error inside the function's own transaction has to leave the transaction usable.
  begin
    insert into money_escrow_holds (tenant_id, ref, currency, amount, subject_kind, subject_id,
        from_account_id, payer_wallet_id, into_account_id, reason_code, reason, status, raised_by)
    values (p_tenant,
        'ESC-' || to_char(now(), 'YYYY') || '-'
            || lpad(nextval('escrow_hold_number_seq')::text, 5, '0'),
        v_ccy, p_amount, v_kind, p_subject_id,
        v_from, p_payer_wallet, v_into, v_code, v_reason, 'raised', p_actor)
    returning id into v_id;
  exception when unique_violation then
    select * into v_open from money_escrow_holds
     where subject_kind = v_kind and subject_id = p_subject_id
       and status in ('raised','held','pending_discharge')
     order by raised_at desc limit 1;
    return jsonb_build_object('ok', false, 'error', 'already_held',
      'message', 'This job already has money waiting on it. Discharge that hold, or raise a new one '
        || 'for the job that is actually in front of you.',
      'open_id', v_open.id, 'open_ref', v_open.ref, 'open_status', v_open.status,
      'open_amount', v_open.amount, 'open_currency', v_open.currency);
  end;

  select * into v_hold from money_escrow_holds where id = v_id;

  v_legs := platform_auth.money_leg(v_from, 'debit', p_amount,
              'Parked against ' || v_hold.subject_ref)
         || platform_auth.money_leg(v_into, 'credit', p_amount,
              'Escrow ' || v_hold.ref || ' — ' || v_hold.reason_code);
  v_post := platform_auth.record_money_posting(p_tenant,
    coalesce(p_posted_on, current_date),
    left('Escrow ' || v_hold.ref || ' on ' || v_hold.subject_ref || ': ' || v_reason, 200),
    v_ccy, 'escrow', v_hold.id, v_hold.ref, p_idempotency, p_actor, v_legs);

  -- A replayed key means the movement this paper was raised on already stands under a different
  -- hold, so the second paper would be a claim on the same money. Refusing here rolls the whole call
  -- back, which is the answer the desk wants: the money is parked once, under the ref already there.
  if (v_post ->> 'replayed')::boolean then
    raise exception '134: the key % already parked % % in this book — that movement is the money, '
      'and it is not held twice under two papers',
      coalesce(p_idempotency, '(nothing)'), p_amount, v_ccy;
  end if;

  update money_escrow_holds
     set status = 'held', hold_posting_id = (v_post -> 'posting' ->> 'id')::uuid, held_at = now()
   where id = v_hold.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_escrow_holds', v_hold.id, 'escrow.raised',
    null,
    jsonb_build_object('ref', v_hold.ref, 'amount', p_amount, 'currency', v_ccy,
      'subject_kind', v_hold.subject_kind, 'subject_ref', v_hold.subject_ref,
      'subject_tenant', v_hold.subject_tenant_id, 'reason_code', v_code, 'reason', v_reason,
      'payer_wallet', v_hold.payer_wallet_id,
      'from_account', (select a.code from money_accounts a where a.id = v_from),
      'into_account', 'ESCROW-' || v_ccy,
      'posting', v_post -> 'posting' ->> 'ref',
      'status', 'held'));

  return jsonb_build_object('ok', true,
    'hold', platform_auth.money_escrow_detail(p_tenant, v_hold.id),
    'posting', v_post -> 'posting');
end $$;

/**
 * Put a plan on a hold and ask a second seat to sign it.
 *
 * The arithmetic is checked here in the words a clerk reads, and again by the table, because the
 * three figures are the whole content of the signature: what the payee takes, what goes back to the
 * payer, what the office keeps. They are the sum of the money held or the paper is refused before it
 * reaches the register — a seat asked to sign a plan that does not add up has been asked to sign
 * nothing.
 *
 * A paper whose signature lapsed, or whose signature was refused, can be asked again. That is the
 * only way out of a lapse: the register keeps one open proposal per act per target, and an expired
 * signature is not one anybody can still give (126's note on the same trap, for the same paper).
 */
create or replace function platform_auth.propose_escrow_discharge(
  p_tenant uuid, p_hold uuid, p_kind text, p_to_payee numeric, p_back_to_payer numeric,
  p_fee_amount numeric, p_payee_wallet uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name   text;
  v_hold   money_escrow_holds;
  v_a      platform_approvals%rowtype;
  v_payee  money_wallets;
  v_reason text;
  v_kind   text;
  v_to     numeric := coalesce(p_to_payee, 0);
  v_back   numeric := coalesce(p_back_to_payer, 0);
  v_fee    numeric := coalesce(p_fee_amount, 0);
  v_payload jsonb;
  v_sha    text;
  v_expiry timestamptz;
  v_id     uuid;
  v_open   uuid;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can ask for a signature on a plan.');
  end if;
  v_kind := lower(trim(coalesce(p_kind, '')));
  if v_kind not in ('released','refunded','split') then
    return jsonb_build_object('ok', false, 'error', 'bad_kind',
      'message', 'A plan releases to the payee, refunds to the payer, or splits between them.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'The reason must be 8-600 characters: it is the sentence the second seat signs.');
  end if;

  select * into v_hold from money_escrow_holds
    where id = p_hold and tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_hold.status not in ('held','pending_discharge') then
    return jsonb_build_object('ok', false, 'error', 'conflict',
      'hold_status', v_hold.status, 'ref', v_hold.ref,
      'message', case when v_hold.status = 'discharged'
        then 'This hold is finished. Money that has left escrow is answered by a fresh movement.'
        else 'Nothing is parked against this paper yet.' end);
  end if;
  if v_hold.status = 'pending_discharge' then
    select * into v_a from platform_approvals where id = v_hold.approval_id;
    if found and v_a.status not in ('lapsed','rejected') then
      return jsonb_build_object('ok', false, 'error', 'already_open',
        'approval_id', v_a.id, 'approval_status', v_a.status,
        'message', 'This hold already stands open on a signature.');
    end if;
  end if;

  if v_to < 0 or v_back < 0 or v_fee < 0 then
    return jsonb_build_object('ok', false, 'error', 'negative_plan',
      'message', 'None of the three figures can be below zero: a plan takes money out, it does not '
        || 'put money in.');
  end if;
  if v_to + v_back + v_fee <> v_hold.amount then
    return jsonb_build_object('ok', false, 'error', 'does_not_add_up',
      'message', 'The three figures are the whole of the money held, or the plan is not a plan.',
      'to_payee', platform_auth.money_figure(v_to),
      'back_to_payer', platform_auth.money_figure(v_back),
      'fee_amount', platform_auth.money_figure(v_fee),
      'held', platform_auth.money_figure(v_hold.amount),
      'currency', v_hold.currency, 'ref', v_hold.ref);
  end if;
  if v_kind = 'refunded' and (v_to <> 0 or v_fee <> 0 or v_back <> v_hold.amount) then
    return jsonb_build_object('ok', false, 'error', 'bad_refund',
      'message', 'A refunded plan sends every unit back to the payer: nothing to the payee, no fee.');
  end if;
  if v_kind = 'released' and (v_to <= 0 or v_back <> 0) then
    return jsonb_build_object('ok', false, 'error', 'bad_release',
      'message', 'A released plan pays the payee and keeps the office''s cut; nothing goes back to '
        || 'the payer, or it is a split.');
  end if;
  if v_kind = 'split' and (v_to <= 0 or v_back <= 0) then
    return jsonb_build_object('ok', false, 'error', 'bad_split',
      'message', 'A split plan gives both sides something, or it is a release or a refund.');
  end if;

  if v_kind = 'refunded' then
    if p_payee_wallet is not null then
      return jsonb_build_object('ok', false, 'error', 'payee_named',
        'message', 'A refunded plan cannot name a payee wallet — the money goes back to where it came from.');
    end if;
  else
    if p_payee_wallet is null then
      return jsonb_build_object('ok', false, 'error', 'no_payee',
        'message', 'Money out of escrow goes to a holder''s wallet. Open one, or refund the hold.');
    end if;
    select * into v_payee from money_wallets
      where id = p_payee_wallet and tenant_id = p_tenant;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'payee_not_found');
    end if;
    if v_payee.currency <> v_hold.currency then
      return jsonb_build_object('ok', false, 'error', 'payee_currency',
        'message', 'The payee wallet holds a different money from the hold.',
        'holder', v_payee.holder_name, 'wallet_currency', v_payee.currency,
        'currency', v_hold.currency);
    end if;
    if v_payee.status = 'frozen' then
      return jsonb_build_object('ok', false, 'error', 'payee_frozen',
        'message', 'The payee''s wallet is stopped, so it cannot take money out of escrow.',
        'holder', v_payee.holder_name, 'reason', v_payee.frozen_reason);
    end if;
    if v_hold.payer_wallet_id = p_payee_wallet then
      return jsonb_build_object('ok', false, 'error', 'payee_is_payer',
        'message', 'This would release money to the wallet it came from, and ''refunded'' says that '
          || 'out loud.');
    end if;
  end if;

  -- The figures go into the payload as text, printed by the same expression the guard below re-reads,
  -- so a signature can never disagree with its own paper through the way jsonb stores a number.
  v_payload := jsonb_build_object('hold_id', v_hold.id, 'ref', v_hold.ref,
    'subject_kind', v_hold.subject_kind, 'subject_id', v_hold.subject_id,
    'subject_ref', v_hold.subject_ref, 'subject_tenant_id', v_hold.subject_tenant_id,
    'amount', platform_auth.money_figure(v_hold.amount), 'currency', v_hold.currency,
    'discharge_kind', v_kind,
    'to_payee', platform_auth.money_figure(v_to),
    'back_to_payer', platform_auth.money_figure(v_back),
    'fee_amount', platform_auth.money_figure(v_fee),
    'payee_wallet_id', p_payee_wallet, 'payer_wallet_id', v_hold.payer_wallet_id,
    'payer_holder', (select w.holder_name from money_wallets w where w.id = v_hold.payer_wallet_id),
    'payee_holder', v_payee.holder_name,
    'reason_code', v_hold.reason_code, 'reason', v_hold.reason, 'plan_note', v_reason);
  v_sha := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');
  v_expiry := now() + interval '7 days';

  begin
    insert into platform_approvals (id, action, target_kind, target_id, payload, payload_sha256,
        reason, status, proposed_by, proposed_role, proposed_ip, proposed_ua, expires_at)
    values (gen_random_uuid(), 'money.escrow', 'escrow_hold', v_hold.id::text, v_payload, v_sha,
        v_reason, 'pending', p_actor, p_role, p_ip,
        left(coalesce(p_ua, ''), 300), v_expiry)
    returning id into v_id;
  exception when unique_violation then
    select a.id into v_open from platform_approvals a
     where a.action = 'money.escrow' and a.target_kind = 'escrow_hold'
       and a.target_id = v_hold.id::text and a.status = 'pending'
     order by a.created_at desc limit 1;
    return jsonb_build_object('ok', false, 'error', 'already_open', 'open_id', v_open,
      'message', 'A signature for this plan is already open and waiting for a second seat.');
  end;

  -- A hold whose signature lapsed is re-planned from the parked state, not from under the old paper:
  -- the guard refuses a plan moving while the row still reads `pending_discharge`, so the state is
  -- walked back in its own statement first and the new plan cut into it second.
  if v_hold.status = 'pending_discharge' then
    update money_escrow_holds set status = 'held' where id = v_hold.id;
  end if;

  update money_escrow_holds
     set discharge_kind = v_kind, to_payee = v_to, back_to_payer = v_back, fee_amount = v_fee,
         payee_wallet_id = p_payee_wallet, approval_id = v_id, status = 'pending_discharge'
   where id = v_hold.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_escrow_holds', v_hold.id, 'escrow.discharge_proposed',
    jsonb_build_object('status', v_hold.status, 'approval_id', v_hold.approval_id),
    jsonb_build_object('ref', v_hold.ref, 'amount', v_hold.amount, 'currency', v_hold.currency,
      'discharge_kind', v_kind, 'to_payee', v_to, 'back_to_payer', v_back, 'fee_amount', v_fee,
      'payee_wallet_id', p_payee_wallet, 'approval_id', v_id, 'plan_note', v_reason,
      'payload_sha256', v_sha, 'expires_at', v_expiry, 'proposed_name', v_name,
      'prior_refusals', v_hold.refusals, 'status', 'pending_discharge'));

  return jsonb_build_object('ok', true, 'approval_id', v_id, 'action', 'money.escrow',
    'target_kind', 'escrow_hold', 'target_id', v_hold.id, 'ref', v_hold.ref,
    'amount', v_hold.amount, 'currency', v_hold.currency, 'discharge_kind', v_kind,
    'to_payee', v_to, 'back_to_payer', v_back, 'fee_amount', v_fee,
    'payee_wallet_id', p_payee_wallet, 'payload_sha256', v_sha, 'expires_at', v_expiry,
    'hold', platform_auth.money_escrow_detail(p_tenant, v_hold.id));
end $$;

-- Refuse the plan. The signature is answered first and the paper stamped from the answer, exactly as
-- 129 refuses an erasure — a desk must not be able to mark a plan refused while its proposal still
-- stands open waiting to be spent. The money stays parked: a refused plan is a hold that has to be
-- planned again, not a hold that has been emptied.
create or replace function platform_auth.refuse_escrow_discharge(
  p_tenant uuid, p_hold uuid, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_hold money_escrow_holds;
  v_a    platform_approvals%rowtype;
  v_note text;
  v_dec  jsonb;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can refuse a plan.');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say why in 8-600 characters: it is the sentence the next plan answers.');
  end if;

  select * into v_hold from money_escrow_holds
    where id = p_hold and tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_hold.status = 'discharged' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'hold_status', v_hold.status,
      'message', 'This hold is finished.');
  end if;
  if v_hold.status <> 'pending_discharge' then
    return jsonb_build_object('ok', false, 'error', 'nothing_open', 'hold_status', v_hold.status,
      'message', 'No signature is standing on this paper. Refusing a plan the office never asked '
        || 'for is not a thing a register can record.');
  end if;

  select * into v_a from platform_approvals where id = v_hold.approval_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'approval_missing');
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
    return jsonb_build_object('ok', false, 'error', 'conflict',
      'approval_status', v_a.status,
      'message', 'The signature on this plan was released. A plan that has been signed is spent on '
        || 'Approvals or it is not; it is not refused from here.');
  end if;

  update money_escrow_holds
     set status = 'held', refusals = refusals + 1, refused_by = p_actor, refused_at = now(),
         refused_note = v_note
   where id = v_hold.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_escrow_holds', v_hold.id, 'escrow.discharge_refused',
    jsonb_build_object('status', v_hold.status, 'approval_id', v_hold.approval_id,
      'discharge_kind', v_hold.discharge_kind, 'to_payee', v_hold.to_payee,
      'back_to_payer', v_hold.back_to_payer, 'fee_amount', v_hold.fee_amount,
      'refusals', v_hold.refusals),
    jsonb_build_object('status', 'held', 'ref', v_hold.ref, 'amount', v_hold.amount,
      'currency', v_hold.currency, 'approval_id', v_a.id, 'note', v_note,
      'refusals', v_hold.refusals + 1, 'refused_name', v_name,
      'payload_sha256', v_a.payload_sha256));

  return jsonb_build_object('ok', true, 'hold', platform_auth.money_escrow_detail(p_tenant, v_hold.id),
    'refusals', v_hold.refusals + 1, 'approval_id', v_a.id);
end $$;

-- Spend the signature the plan was signed on.
--
-- Called inside the same transaction as `decide_approval` and `claim_approval`, in 121's order
-- (decide -> claim -> apply -> settle). It expects the approval already spent by the seat calling it,
-- and the table's own guard re-reads the signature from the row — so a handler that skipped the claim
-- finds nothing to spend, and a signature released against a different plan cannot be used here.
create or replace function platform_auth.apply_escrow_discharge(
  p_approval_id uuid, p_actor_user_id uuid, p_actor_role text, p_actor_ip text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a      platform_approvals%rowtype;
  v_hold   money_escrow_holds;
  v_payee  money_wallets;
  v_back   uuid;
  v_legs   jsonb;
  v_post   jsonb;
begin
  select * into v_a from platform_approvals where id = p_approval_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_a.action <> 'money.escrow' or v_a.target_kind <> 'escrow_hold' then
    return jsonb_build_object('ok', false, 'error', 'not_a_hold',
      'message', 'That signature is not an escrow plan.');
  end if;
  if v_a.status <> 'applied' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'approval_status', v_a.status,
      'message', 'The signature was not spent by this call.');
  end if;
  if v_a.decided_by <> p_actor_user_id then
    return jsonb_build_object('ok', false, 'error', 'unauthorised',
      'message', 'Only the seat that released a signature may spend it.');
  end if;

  select * into v_hold from money_escrow_holds
    where id = v_a.target_id::uuid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_hold.status = 'discharged' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'ref', v_hold.ref,
      'message', 'This hold was already discharged by its signature.');
  end if;
  if v_hold.status <> 'pending_discharge' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'hold_status', v_hold.status,
      'message', 'This paper is not waiting for that signature.');
  end if;

  -- The payee is re-read, because seven days is long enough for a desk to stop a wallet, and 133's leg
  -- guard would refuse the movement at commit with a sentence about a frozen account.
  if v_hold.payee_wallet_id is not null then
    select * into v_payee from money_wallets where id = v_hold.payee_wallet_id for update;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'payee_gone',
        'message', 'The payee wallet this plan was signed for is no longer in the office''s book.');
    end if;
    if v_payee.status = 'frozen' then
      return jsonb_build_object('ok', false, 'error', 'payee_frozen',
        'message', 'The payee''s wallet was stopped while the plan waited.',
        'holder', v_payee.holder_name, 'reason', v_payee.frozen_reason);
    end if;
  end if;
  if v_hold.payer_wallet_id is not null and not exists (
       select 1 from money_wallets w
        where w.id = v_hold.payer_wallet_id and w.status = 'open') then
    return jsonb_build_object('ok', false, 'error', 'payer_frozen',
      'message', 'The plan sends money back to a wallet the office has stopped. Re-plan the hold '
        || 'without the refund, or unfreeze the holder first.');
  end if;
  -- Money out of escrow goes back to the holder's own line when there is one, and to the line it came
  -- from when the office fronted the money. Both are already on the paper, so a seat that signed this
  -- plan cannot be shown a different destination at the moment it is spent.
  if v_hold.payer_wallet_id is not null then
    v_back := (select w.account_id from money_wallets w where w.id = v_hold.payer_wallet_id);
  else
    v_back := v_hold.from_account_id;
  end if;

  v_legs := platform_auth.money_leg(v_hold.into_account_id, 'debit', v_hold.amount,
              'Escrow ' || v_hold.ref || ' discharged')
         || platform_auth.money_leg(v_payee.account_id, 'credit', v_hold.to_payee,
              'To ' || coalesce(v_payee.holder_name, 'the payee') || ' from escrow ' || v_hold.ref)
         || platform_auth.money_leg(v_back, 'credit', v_hold.back_to_payer,
              'Back to the payer of ' || v_hold.ref);
  if v_hold.fee_amount > 0 then
    v_legs := v_legs || platform_auth.money_leg(
      (select a.id from money_accounts a
        where a.tenant_id = v_hold.tenant_id
          and a.code = 'FEE-INCOME' || case when v_hold.currency = 'USD' then '-USD' else '' end
          and a.status = 'open'),
      'credit', v_hold.fee_amount, 'Office cut on ' || v_hold.ref);
  end if;

  v_post := platform_auth.record_money_posting(v_hold.tenant_id, current_date,
    left('Escrow ' || v_hold.ref || ' ' || v_hold.discharge_kind || ' — '
         || coalesce(v_a.reason, ''), 200),
    v_hold.currency, 'escrow', v_hold.id, v_hold.ref, null, p_actor_user_id, v_legs);

  update money_escrow_holds
     set status = 'discharged', discharge_posting_id = (v_post -> 'posting' ->> 'id')::uuid,
         discharged_by = p_actor_user_id, discharged_at = now()
   where id = v_hold.id;

  perform platform_auth.money_audit(v_hold.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip, null,
    'money_escrow_holds', v_hold.id, 'escrow.discharged',
    jsonb_build_object('status', v_hold.status, 'refusals', v_hold.refusals),
    jsonb_build_object('ref', v_hold.ref, 'amount', v_hold.amount, 'currency', v_hold.currency,
      'discharge_kind', v_hold.discharge_kind, 'to_payee', v_hold.to_payee,
      'back_to_payer', v_hold.back_to_payer, 'fee_amount', v_hold.fee_amount,
      'payee_wallet_id', v_hold.payee_wallet_id, 'approval_id', v_a.id,
      'proposed_by', v_a.proposed_by, 'payload_sha256', v_a.payload_sha256,
      'posting', v_post -> 'posting' ->> 'ref', 'status', 'discharged'));

  return jsonb_build_object('ok', true, 'hold_id', v_hold.id, 'ref', v_hold.ref,
    'amount', v_hold.amount, 'currency', v_hold.currency, 'discharge_kind', v_hold.discharge_kind,
    'to_payee', v_hold.to_payee, 'back_to_payer', v_hold.back_to_payer, 'fee_amount', v_hold.fee_amount,
    'payee_wallet_id', v_hold.payee_wallet_id, 'subject_kind', v_hold.subject_kind,
    'subject_id', v_hold.subject_id, 'subject_ref', v_hold.subject_ref,
    'subject_tenant_id', v_hold.subject_tenant_id,
    'posting', v_post -> 'posting', 'approval_id', v_a.id,
    'raised_by', v_hold.raised_by, 'discharged_by', p_actor_user_id);
end $$;

-- ------------------------------------------------------------
-- 8c. the payout, and the batch that signs a set of them
-- ------------------------------------------------------------

/**
 * A payout is booked twice, and the two moments are the whole reason this file exists.
 *
 * The signature releases the *obligation*: Dr the expense or the wallet, Cr PAYOUT-DUE, and the
 * office's cut is accrued with it because the figure the second seat signed is gross. Then the desk
 * that actually hands the money over confirms it: Dr PAYOUT-DUE, Cr the cash line the rail pays out
 * of, Cr FEE-INCOME for the office's part. Between the two the liability sits on the books where the
 * panel can see it, which is what "the office owes this person and has not paid them" is worth when
 * somebody asks. A payment that the rail refused is answered by reversing the accrual, so the book
 * keeps both the promise and the fact that it was withdrawn.
 *
 * The batch is the same two moments for a set of papers at once: one signature over a frozen total,
 * then one line confirmed at a time.
 */
create or replace function platform_auth.raise_money_payout(
  p_tenant uuid, p_payee_kind text, p_payee_id uuid, p_payee_name text, p_rail_code text,
  p_payee_ref_encrypted bytea, p_payee_ref_tail text, p_payee_ref_hash text,
  p_amount numeric, p_fee_amount numeric, p_currency text,
  p_source_kind text, p_source_id uuid, p_source_ref text, p_purpose text, p_batch_id uuid,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row    money_payouts;
  v_rail   money_payout_rails%rowtype;
  v_wallet money_wallets;
  v_refund service_refund_requests%rowtype;
  v_run    payroll_runs%rowtype;
  v_acct   jsonb;
  v_fee    numeric := coalesce(p_fee_amount, 0);
  v_batch  money_payout_batches;
  v_bal    numeric;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    raise exception '134: money leaves the office only from the office''s own book';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000000 then
    return jsonb_build_object('ok', false, 'error', 'bad_amount',
      'message', 'A payout is for a figure above zero and no larger than the book carries.');
  end if;
  if v_fee < 0 or v_fee > p_amount then
    return jsonb_build_object('ok', false, 'error', 'bad_fee',
      'message', 'The office''s cut cannot be below zero or bigger than the money it rides on.',
      'amount', p_amount, 'fee', v_fee);
  end if;
  if char_length(trim(coalesce(p_purpose, ''))) < 8 or char_length(trim(p_purpose)) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_purpose',
      'message', 'Say in 8-600 characters what this money is for: it is the sentence the second seat '
        || 'reads, and the one the office answers with when anybody asks why the payout was made.');
  end if;
  if p_payee_kind not in ('company','driver','staff','other') then
    return jsonb_build_object('ok', false, 'error', 'bad_payee_kind',
      'message', 'A payout is aimed at a company, a driver, a staff member, or a name the desk types '
        || 'for itself.');
  end if;
  if p_payee_kind = 'other' and char_length(trim(coalesce(p_payee_name, ''))) < 2 then
    return jsonb_build_object('ok', false, 'error', 'bad_payee_name',
      'message', 'A payee the registers do not know has to be named by the desk that pays them.');
  end if;
  if p_payee_kind <> 'other' and p_payee_id is null then
    return jsonb_build_object('ok', false, 'error', 'payee_not_named',
      'message', 'The office pays a company, a driver or a staff member it already has a paper for.');
  end if;
  -- The other half of the same pair, answered here rather than left to the row: `other` is the kind
  -- with no register, so an id aimed at a company that does not exist would be a payout the desk
  -- cannot walk back to anything.
  if p_payee_kind = 'other' and p_payee_id is not null then
    return jsonb_build_object('ok', false, 'error', 'payee_not_named',
      'message', 'A payee the desk typed a name for has no paper to point at. Either raise it as a '
        || 'company, a driver or a staff member, or drop the id and let the typed name stand alone.');
  end if;

  select * into v_rail from money_payout_rails where code = lower(trim(coalesce(p_rail_code, '')));
  if not found then
    return jsonb_build_object('ok', false, 'error', 'bad_rail',
      'message', 'That is not a rail the office pays on.', 'rail', p_rail_code);
  end if;
  if v_rail.needs = 'none' and (p_payee_ref_encrypted is not null or p_payee_ref_hash is not null) then
    return jsonb_build_object('ok', false, 'error', 'line_on_cash_rail',
      'message', 'A cash payout is handed over at the desk and must carry no account line.',
      'rail', v_rail.label);
  end if;
  if v_rail.needs <> 'none' and (p_payee_ref_encrypted is null or p_payee_ref_hash is null) then
    return jsonb_build_object('ok', false, 'error', 'line_missing',
      'message', 'This rail pays a number, and the paper has to carry it. The whole line is stored '
        || 'encrypted; only its tail and its keyed hash are read back.',
      'needs', v_rail.needs);
  end if;
  if p_payee_ref_hash is not null and p_payee_ref_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_hash',
      'message', 'The payee line hash is 64 lowercase hex characters or it is not a keyed hash.');
  end if;

  if p_source_kind not in ('manual','refund','payroll','wallet_withdrawal','cost') then
    return jsonb_build_object('ok', false, 'error', 'bad_source_kind',
      'message', 'A payout says what it stands for: the office''s own pen, a signed refund, a payroll '
        || 'run, a holder''s withdrawal, or a cost.');
  end if;
  if upper(trim(coalesce(p_currency, ''))) not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'bad_currency',
      'message', 'A payout is made in TZS or USD.');
  end if;

  -- Each source is read out of the register it names before the paper is written, so the answer the
  -- desk gets is a sentence about the paper, not a trigger error about a row it cannot see.
  if p_source_kind = 'refund' then
    select * into v_refund from service_refund_requests where id = p_source_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'refund_not_found',
        'message', 'There is no refund paper behind this payout.');
    end if;
    if v_refund.status <> 'released' then
      return jsonb_build_object('ok', false, 'error', 'refund_not_released',
        'message', 'Only a released refund paper owes money. Signing a paper is not paying it.',
        'refund_ref', v_refund.ref, 'refund_status', v_refund.status);
    end if;
    if v_refund.amount <> p_amount or v_refund.currency <> upper(trim(p_currency)) then
      return jsonb_build_object('ok', false, 'error', 'refund_figure',
        'message', 'The caller is owed what the signed paper says, to the unit.',
        'owed', platform_auth.money_figure(v_refund.amount),
        'currency', v_refund.currency, 'refund_ref', v_refund.ref);
    end if;
    if v_refund.company_tenant_id is null then
      return jsonb_build_object('ok', false, 'error', 'refund_company_gone',
        'message', 'The company this refund was signed for is no longer on the register, so the '
          || 'money has nobody to go to. 127 keeps a paper that loses its company.',
        'refund_ref', v_refund.ref);
    end if;
    if p_payee_kind <> 'company' or p_payee_id <> v_refund.company_tenant_id then
      return jsonb_build_object('ok', false, 'error', 'refund_payee',
        'message', 'A refund pays the company the paper was signed for.',
        'owed_to', v_refund.company_name, 'refund_ref', v_refund.ref);
    end if;
  elsif p_source_kind = 'payroll' then
    select * into v_run from payroll_runs where id = p_source_id and deleted_at is null;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'run_not_found',
        'message', 'There is no payroll run behind this payout.');
    end if;
    if v_run.currency <> upper(trim(p_currency)) then
      return jsonb_build_object('ok', false, 'error', 'run_currency',
        'message', 'The run is in a different money from the payout.',
        'run_currency', v_run.currency, 'currency', p_currency);
    end if;
    if p_amount > v_run.net_total then
      return jsonb_build_object('ok', false, 'error', 'run_figure',
        'message', 'The office does not pay a run more than it issued.',
        'net_total', platform_auth.money_figure(v_run.net_total), 'amount', p_amount);
    end if;
  elsif p_source_kind = 'wallet_withdrawal' then
    select * into v_wallet from money_wallets
      where id = p_source_id and tenant_id = p_tenant for update;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'wallet_not_found',
        'message', 'A withdrawal drains a wallet the office holds.');
    end if;
    if v_wallet.currency <> upper(trim(p_currency)) then
      return jsonb_build_object('ok', false, 'error', 'wallet_currency',
        'message', 'The holder''s wallet is in a different money from the withdrawal.',
        'holder', v_wallet.holder_name, 'wallet_currency', v_wallet.currency);
    end if;
    if v_wallet.status = 'frozen' then
      return jsonb_build_object('ok', false, 'error', 'wallet_frozen',
        'message', 'The holder cannot take money out of a stopped wallet.',
        'holder', v_wallet.holder_name, 'reason', v_wallet.frozen_reason);
    end if;
    v_bal := platform_auth.money_wallet_balance(p_source_id);
    if v_bal < p_amount + v_fee then
      return jsonb_build_object('ok', false, 'error', 'short',
        'message', 'The holder does not have that money, and the office''s cut comes out of the same '
          || 'balance.',
        'holder', v_wallet.holder_name, 'balance', v_bal,
        'needs', platform_auth.money_figure(p_amount + v_fee),
        'currency', v_wallet.currency, 'short_by', (p_amount + v_fee) - v_bal);
    end if;
  end if;

  if p_batch_id is not null then
    select * into v_batch from money_payout_batches where id = p_batch_id and tenant_id = p_tenant;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'batch_not_found');
    end if;
    if v_batch.status <> 'open' then
      return jsonb_build_object('ok', false, 'error', 'batch_closed',
        'message', 'Nothing is added to a batch that has already asked for or spent a signature.',
        'batch_ref', v_batch.ref, 'batch_status', v_batch.status);
    end if;
    if v_batch.currency <> upper(trim(p_currency)) then
      return jsonb_build_object('ok', false, 'error', 'batch_currency',
        'message', 'A batch is one money, and so is every line under it.',
        'batch_currency', v_batch.currency);
    end if;
  end if;

  v_acct := platform_auth.money_payout_accounts(p_tenant, upper(trim(p_currency)), p_source_kind,
              v_rail.family, case when p_source_kind = 'wallet_withdrawal' then p_source_id end);

  insert into money_payouts (tenant_id, ref, batch_id, payee_kind, payee_id, payee_name,
      rail_code, payee_ref_encrypted, payee_ref_tail, payee_ref_hash,
      amount, fee_amount, currency, source_kind, source_id, source_ref, purpose,
      status, fund_account_id, payable_account_id, cash_account_id, raised_by)
  values (p_tenant,
      'PAY-' || to_char(now(), 'YYYY') || '-'
          || lpad(nextval('payout_number_seq')::text, 5, '0'),
      p_batch_id, p_payee_kind, p_payee_id,
      coalesce(nullif(trim(coalesce(p_payee_name, '')), ''), 'unnamed'),
      v_rail.code, p_payee_ref_encrypted, nullif(trim(coalesce(p_payee_ref_tail, '')), ''),
      p_payee_ref_hash,
      p_amount, v_fee, upper(trim(p_currency)), p_source_kind, p_source_id,
      -- The quote a payout carries is clamped to the 60 characters 133 gives a `source_ref`, exactly
      -- as a wallet funding and a balance transfer clamp theirs above. A holder whose company name
      -- fills the register's own 120, or a desk that pastes a long waybill number, would otherwise
      -- abort on the column's CHECK — and a payout that cannot be raised because its payee is
      -- long-named is a payout the office still owes.
      left(coalesce(nullif(trim(coalesce(p_source_ref, '')), ''),
               v_refund.ref, to_char(v_run.period, 'YYYY-MM'), v_wallet.holder_name, v_rail.label), 60),
      trim(p_purpose), 'raised',
      (v_acct ->> 'fund')::uuid, (v_acct ->> 'payable')::uuid, (v_acct ->> 'cash')::uuid, p_actor)
  returning * into v_row;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_payouts', v_row.id, 'payout.raised', null,
    jsonb_build_object('ref', v_row.ref, 'payee', v_row.payee_name, 'payee_kind', v_row.payee_kind,
      'payee_id', v_row.payee_id, 'rail', v_rail.code, 'payee_ref_tail', v_row.payee_ref_tail,
      'payee_ref_hash', v_row.payee_ref_hash, 'amount', v_row.amount,
      'fee_amount', v_row.fee_amount, 'currency', v_row.currency,
      'source_kind', v_row.source_kind, 'source_id', v_row.source_id, 'source_ref', v_row.source_ref,
      'purpose', v_row.purpose, 'batch', v_batch.ref,
      'fund', (v_acct ->> 'fund'), 'payable', (v_acct ->> 'payable'),
      'cash', (v_acct ->> 'cash'), 'status', 'raised'));

  return jsonb_build_object('ok', true, 'payout', platform_auth.money_payout_detail(p_tenant, v_row.id));
end $$;

-- Open a batch: a label, one money, and nothing under it yet. The total is not typed — it is copied
-- from the lines that stand under the batch at the moment the desk asks for a signature.
create or replace function platform_auth.open_money_payout_batch(
  p_tenant uuid, p_label text, p_currency text, p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    raise exception '134: a payout batch is the office paying several people at once';
  end if;
  if char_length(trim(coalesce(p_label, ''))) < 3 then
    return jsonb_build_object('ok', false, 'error', 'bad_label',
      'message', 'A batch needs a name a second seat can read: what the set is for.');
  end if;
  if upper(trim(coalesce(p_currency, ''))) not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'bad_currency',
      'message', 'A batch is one money, decided when it is opened.');
  end if;

  insert into money_payout_batches (tenant_id, ref, label, currency, status, raised_by)
  values (p_tenant,
      'PBT-' || to_char(now(), 'YYYY') || '-'
           || lpad(nextval('payout_batch_number_seq')::text, 5, '0'),
      left(trim(p_label), 80), upper(trim(p_currency)), 'open', p_actor)
  returning id into v_id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_payout_batches', v_id, 'payout_batch.opened', null,
    jsonb_build_object('ref', (select ref from money_payout_batches where id = v_id),
      'label', left(trim(p_label), 80), 'currency', upper(trim(p_currency)), 'status', 'open'));

  return jsonb_build_object('ok', true,
    'batch', platform_auth.money_payout_batch_detail(p_tenant, v_id));
end $$;

/**
 * Ask a second seat to sign one payout.
 *
 * The payload is built from the row the desk is standing at, not from what the desk typed: the payee
 * name is the one the register gave, the figure is printed by the same expression the guard re-reads,
 * and the payee line enters the hash as its keyed hash and never as the number itself. So the
 * signature proves which account the money was aimed at without the register having to hold it in the
 * clear, and a payout walked to a different number breaks its own signature.
 */
create or replace function platform_auth.propose_money_payout(
  p_tenant uuid, p_payout uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_row  money_payouts;
  v_a    platform_approvals%rowtype;
  v_rail money_payout_rails%rowtype;
  v_reason text;
  v_payload jsonb;
  v_sha  text;
  v_expiry timestamptz;
  v_id   uuid;
  v_open uuid;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can ask for a signature on a payout.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'The reason must be 8-600 characters: it is the sentence the second seat signs.');
  end if;

  select * into v_row from money_payouts
    where id = p_payout and tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_row.batch_id is not null then
    return jsonb_build_object('ok', false, 'error', 'in_a_batch',
      'message', 'This line stands in a batch and is signed with it, not on its own paper.',
      'batch_id', v_row.batch_id);
  end if;
  if v_row.status not in ('raised','pending_signature') then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'payout_status', v_row.status,
      'ref', v_row.ref, 'message', 'This payout is finished.');
  end if;
  if v_row.status = 'pending_signature' then
    select * into v_a from platform_approvals where id = v_row.approval_id;
    if found and v_a.status not in ('lapsed','rejected') then
      return jsonb_build_object('ok', false, 'error', 'already_open',
        'approval_id', v_a.id, 'approval_status', v_a.status,
        'message', 'This payout already stands open on a signature.');
    end if;
  end if;

  select * into v_rail from money_payout_rails where code = v_row.rail_code;
  v_payload := jsonb_build_object('payout_id', v_row.id, 'ref', v_row.ref,
    'payee', v_row.payee_name, 'payee_kind', v_row.payee_kind, 'payee_id', v_row.payee_id,
    'payee_tenant_id', v_row.payee_tenant_id,
    'rail_code', v_row.rail_code, 'rail', v_rail.label, 'rail_family', v_rail.family,
    'payee_ref_tail', v_row.payee_ref_tail, 'payee_ref_hash', v_row.payee_ref_hash,
    'amount', platform_auth.money_figure(v_row.amount),
    'fee_amount', platform_auth.money_figure(v_row.fee_amount),
    'total_out', platform_auth.money_figure(v_row.amount + v_row.fee_amount),
    'currency', v_row.currency,
    'source_kind', v_row.source_kind, 'source_id', v_row.source_id, 'source_ref', v_row.source_ref,
    'purpose', v_row.purpose, 'raised_by_name',
    (select coalesce(nullif(trim(u.full_name), ''), split_part(u.email, '@', 1))
       from users u where u.id = v_row.raised_by));
  v_sha := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');
  v_expiry := now() + interval '7 days';

  begin
    insert into platform_approvals (id, action, target_kind, target_id, payload, payload_sha256,
        reason, status, proposed_by, proposed_role, proposed_ip, proposed_ua, expires_at)
    values (gen_random_uuid(), 'money.payout', 'payout', v_row.id::text, v_payload, v_sha,
        v_reason, 'pending', p_actor, p_role, p_ip,
        left(coalesce(p_ua, ''), 300), v_expiry)
    returning id into v_id;
  exception when unique_violation then
    select a.id into v_open from platform_approvals a
     where a.action = 'money.payout' and a.target_kind = 'payout'
       and a.target_id = v_row.id::text and a.status = 'pending'
     order by a.created_at desc limit 1;
    return jsonb_build_object('ok', false, 'error', 'already_open', 'open_id', v_open,
      'message', 'A signature for this payout is already open and waiting for a second seat.');
  end;

  -- The same two statements as the batch: the row's own guard will not let a signature be swapped on
  -- a paper that still reads `pending_signature`, so it goes back to being a draft first.
  if v_row.status = 'pending_signature' then
    update money_payouts set status = 'raised' where id = v_row.id;
  end if;

  update money_payouts
     set status = 'pending_signature', approval_id = v_id
   where id = v_row.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_payouts', v_row.id, 'payout.proposed',
    jsonb_build_object('status', v_row.status, 'approval_id', v_row.approval_id),
    jsonb_build_object('ref', v_row.ref, 'payee', v_row.payee_name, 'amount', v_row.amount,
      'fee_amount', v_row.fee_amount, 'currency', v_row.currency, 'rail', v_row.rail_code,
      'source_kind', v_row.source_kind, 'approval_id', v_id, 'reason', v_reason,
      'payload_sha256', v_sha, 'expires_at', v_expiry, 'proposed_name', v_name,
      'status', 'pending_signature'));

  return jsonb_build_object('ok', true, 'approval_id', v_id, 'action', 'money.payout',
    'target_kind', 'payout', 'target_id', v_row.id, 'ref', v_row.ref,
    'payee', v_row.payee_name, 'amount', v_row.amount, 'fee_amount', v_row.fee_amount,
    'currency', v_row.currency, 'payload_sha256', v_sha, 'expires_at', v_expiry,
    'payout', platform_auth.money_payout_detail(p_tenant, v_row.id));
end $$;

-- Ask a second seat to sign a whole batch as one sentence.
--
-- The total and the line count are copied off the lines that stand under the batch at this moment and
-- then frozen by trigger: the seat signs a figure, and a figure that the board re-added after the
-- signature would be a different paper than the one that was signed.
create or replace function platform_auth.propose_money_payout_batch(
  p_tenant uuid, p_batch uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name   text;
  v_batch  money_payout_batches;
  v_a      platform_approvals%rowtype;
  v_reason text;
  v_total  numeric;
  v_lines  int;
  v_payload jsonb;
  v_sha    text;
  v_expiry timestamptz;
  v_id     uuid;
  v_open   uuid;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can ask for a signature on a batch.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'The reason must be 8-600 characters: it is the sentence the second seat signs.');
  end if;

  select * into v_batch from money_payout_batches
    where id = p_batch and tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_batch.status not in ('open','pending_signature') then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'batch_status', v_batch.status,
      'ref', v_batch.ref, 'message', 'This batch has spent its signature or been closed.');
  end if;
  if v_batch.status = 'pending_signature' then
    select * into v_a from platform_approvals where id = v_batch.approval_id;
    if found and v_a.status not in ('lapsed','rejected') then
      return jsonb_build_object('ok', false, 'error', 'already_open',
        'approval_id', v_a.id, 'approval_status', v_a.status,
        'message', 'This batch already stands open on a signature.');
    end if;
  end if;

  select coalesce(sum(amount + fee_amount), 0), count(*)
    into v_total, v_lines
    from money_payouts
   where batch_id = v_batch.id and status = 'raised' and currency = v_batch.currency;
  if v_lines = 0 then
    return jsonb_build_object('ok', false, 'error', 'empty_batch', 'ref', v_batch.ref,
      'message', 'A batch of nothing is not a sentence a second seat can sign. Put the payouts under '
        || 'it first.');
  end if;

  v_payload := jsonb_build_object('batch_id', v_batch.id, 'ref', v_batch.ref,
    'label', v_batch.label, 'currency', v_batch.currency,
    'total_amount', platform_auth.money_figure(v_total), 'lines', v_lines,
    'fee_total', platform_auth.money_figure(
      (select coalesce(sum(fee_amount), 0) from money_payouts
        where batch_id = v_batch.id and status = 'raised' and currency = v_batch.currency)),
    -- The order belongs inside `jsonb_agg`, not after the subselect: this subquery aggregates the whole
    -- set into one value, so a `payee_name` in the statement's own ORDER BY is a column nobody grouped.
    'pays', (select jsonb_agg(jsonb_build_object('ref', p.ref, 'payee', p.payee_name,
                       'amount', platform_auth.money_figure(p.amount),
                       'fee', platform_auth.money_figure(p.fee_amount),
                       'rail', p.rail_code)
                     order by p.payee_name, p.ref)
               from money_payouts p
              where p.batch_id = v_batch.id and p.status = 'raised'
                and p.currency = v_batch.currency),
    'raised_by_name',
    (select coalesce(nullif(trim(u.full_name), ''), split_part(u.email, '@', 1))
       from users u where u.id = v_batch.raised_by));
  v_sha := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');
  v_expiry := now() + interval '7 days';

  begin
    insert into platform_approvals (id, action, target_kind, target_id, payload, payload_sha256,
        reason, status, proposed_by, proposed_role, proposed_ip, proposed_ua, expires_at)
    values (gen_random_uuid(), 'money.payout', 'payout_batch', v_batch.id::text, v_payload, v_sha,
        v_reason, 'pending', p_actor, p_role, p_ip,
        left(coalesce(p_ua, ''), 300), v_expiry)
    returning id into v_id;
  exception when unique_violation then
    select a.id into v_open from platform_approvals a
     where a.action = 'money.payout' and a.target_kind = 'payout_batch'
       and a.target_id = v_batch.id::text and a.status = 'pending'
     order by a.created_at desc limit 1;
    return jsonb_build_object('ok', false, 'error', 'already_open', 'open_id', v_open,
      'message', 'A signature for this batch is already open and waiting for a second seat.');
  end;

  -- A batch that comes back here had its signature lapsed or refused, and 134's own guard keeps a
  -- signed paper's figures where they are. So the draft step is its own statement: the state moves
  -- back with nothing else touching it, and only then are the new figures cut into it.
  if v_batch.status = 'pending_signature' then
    update money_payout_batches set status = 'open' where id = v_batch.id;
  end if;

  update money_payout_batches
     set status = 'pending_signature', total_amount = v_total, lines = v_lines,
         reason = v_reason, approval_id = v_id
   where id = v_batch.id;
  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_payout_batches', v_batch.id, 'payout_batch.proposed',
    jsonb_build_object('status', v_batch.status, 'total_amount', v_batch.total_amount,
      'lines', v_batch.lines, 'approval_id', v_batch.approval_id),
    jsonb_build_object('ref', v_batch.ref, 'label', v_batch.label, 'total_amount', v_total,
      'lines', v_lines, 'currency', v_batch.currency, 'reason', v_reason, 'approval_id', v_id,
      'payload_sha256', v_sha, 'expires_at', v_expiry, 'proposed_name', v_name,
      'status', 'pending_signature'));

  return jsonb_build_object('ok', true, 'approval_id', v_id, 'action', 'money.payout',
    'target_kind', 'payout_batch', 'target_id', v_batch.id, 'ref', v_batch.ref,
    'total_amount', v_total, 'lines', v_lines, 'currency', v_batch.currency,
    'payload_sha256', v_sha, 'expires_at', v_expiry,
    'batch', platform_auth.money_payout_batch_detail(p_tenant, v_batch.id));
end $$;

-- Say no to a payout. Both registers in one call, exactly as 126 refuses a refund: the signature is
-- answered first and the paper stamped from the answer, so a desk cannot mark a payout declined while
-- the second seat's proposal still stands open waiting to be spent. A payout a released signature has
-- already committed is not refused from here — it is paid, or it is failed when the rail says no.
create or replace function platform_auth.decline_money_payout(
  p_tenant uuid, p_payout uuid, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_row  money_payouts;
  v_b    money_payout_batches;
  v_a    platform_approvals%rowtype;
  v_note text;
  v_dec  jsonb;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can decline a payout.');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say why in 8-600 characters: it is the sentence the payee is given.');
  end if;

  select * into v_row from money_payouts
    where id = p_payout and tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_row.status in ('paid','failed','declined') then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'payout_status', v_row.status,
      'ref', v_row.ref, 'message', 'This payout has answered.');
  end if;
  if v_row.status = 'released' then
    return jsonb_build_object('ok', false, 'error', 'already_released', 'ref', v_row.ref,
      'message', 'A spent signature has already made the office owe this money. Confirm the cash or '
        || 'mark the payment failed; do not unsign it.');
  end if;
  if v_row.batch_id is not null then
    select * into v_b from money_payout_batches where id = v_row.batch_id;
    if v_b.status <> 'open' then
      return jsonb_build_object('ok', false, 'error', 'in_a_signed_batch', 'batch_ref', v_b.ref,
        'message', 'This line is inside a batch that has asked for a signature. Refuse the batch, or '
          || 'wait until it is back on the board as a draft.');
    end if;
  end if;

  if v_row.approval_id is not null then
    select * into v_a from platform_approvals where id = v_row.approval_id;
    if found and v_a.status = 'pending' then
      v_dec := platform_auth.decide_approval(v_a.id, 'reject', v_note, p_actor, p_role, p_ip,
        left(coalesce(p_ua, ''), 300));
      if v_dec ->> 'status' <> 'ok' then
        return jsonb_build_object('ok', false, 'error', 'refused_the_signature_first',
          'message', 'The signature was not answered: '
            || coalesce(v_dec ->> 'message', v_dec ->> 'status'),
          'approval_answer', v_dec);
      end if;
    elsif found and v_a.status in ('approved','applied') then
      return jsonb_build_object('ok', false, 'error', 'conflict', 'approval_status', v_a.status,
        'message', 'The signature on this payout was released. It is spent on Approvals, not '
          || 'declined from here.');
    end if;
  end if;

  update money_payouts
     set status = 'declined', declined_by = p_actor, declined_at = now(), declined_note = v_note
   where id = v_row.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_payouts', v_row.id, 'payout.declined',
    jsonb_build_object('status', v_row.status, 'approval_id', v_row.approval_id),
    jsonb_build_object('ref', v_row.ref, 'payee', v_row.payee_name, 'amount', v_row.amount,
      'fee_amount', v_row.fee_amount, 'currency', v_row.currency, 'note', v_note,
      'declined_name', v_name, 'approval_id', v_row.approval_id, 'status', 'declined'));

  return jsonb_build_object('ok', true, 'payout', platform_auth.money_payout_detail(p_tenant, v_row.id));
end $$;

-- Refuse a whole batch. One "no" answers the signature and stamps every line that was standing under
-- it, because a batch is signed as one sentence and a half-refused set of payouts is not a thing that
-- was ever proposed. The paper goes back to a draft so the desk can cut it again.
create or replace function platform_auth.decline_money_payout_batch(
  p_tenant uuid, p_batch uuid, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_b    money_payout_batches;
  v_a    platform_approvals%rowtype;
  v_note text;
  v_dec  jsonb;
  v_lines int := 0;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can refuse a batch.');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say why in 8-600 characters: it is the sentence the payees are given.');
  end if;

  select * into v_b from money_payout_batches
    where id = p_batch and tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_b.status <> 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'batch_status', v_b.status,
      'ref', v_b.ref,
      'message', 'Nothing is standing open on this batch. A draft is refused line by line, and a '
        || 'batch that has spent its signature is paid or failed, not refused.');
  end if;

  select * into v_a from platform_approvals where id = v_b.approval_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'approval_missing');
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
  elsif v_a.status in ('approved','applied') then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'approval_status', v_a.status,
      'message', 'The signature on this batch was released. It is spent on Approvals.');
  end if;

  -- The batch keeps the approval it was refused under — the guard will not let a signed paper's
  -- approval move — and comes back as a draft the desk can cut again.
  update money_payout_batches set status = 'open' where id = v_b.id;

  update money_payouts
     set status = 'declined', declined_by = p_actor, declined_at = now(), declined_note = v_note
   where batch_id = v_b.id and status in ('raised','pending_signature');
  get diagnostics v_lines = row_count;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_payout_batches', v_b.id, 'payout_batch.refused',
    jsonb_build_object('status', v_b.status, 'total_amount', v_b.total_amount,
      'lines', v_b.lines, 'approval_id', v_b.approval_id),
    jsonb_build_object('ref', v_b.ref, 'label', v_b.label, 'total_amount', v_b.total_amount,
      'lines', v_b.lines, 'currency', v_b.currency, 'note', v_note, 'refused_name', v_name,
      'lines_declined', v_lines, 'approval_id', v_a.id,
      'payload_sha256', v_a.payload_sha256, 'status', 'open'));

  return jsonb_build_object('ok', true, 'lines_declined', v_lines, 'approval_id', v_a.id,
    'batch', platform_auth.money_payout_batch_detail(p_tenant, v_b.id));
end $$;

-- Spend the signature and accrue the obligation.
--
-- Called in the same transaction as `decide_approval` and `claim_approval`, in 121's order. The table
-- guard re-reads the signature from the row, so a handler that skipped the claim finds nothing to
-- spend and a signature released against a different paper cannot be used here.
create or replace function platform_auth.apply_payout_release(
  p_approval_id uuid, p_actor_user_id uuid, p_actor_role text, p_actor_ip text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a    platform_approvals%rowtype;
  v_row  money_payouts;
  v_b    money_payout_batches;
  v_line money_payouts;
  v_rail money_payout_rails%rowtype;
  v_legs jsonb;
  v_post jsonb;
  -- An object, not an array: `||` on the left of an object appends rather than merges, so a `[]` seed
  -- would have made the answer a list of one-pair objects that nobody could look a payout's number up in.
  v_refs jsonb := '{}'::jsonb;
  v_count int := 0;
begin
  select * into v_a from platform_approvals where id = p_approval_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_a.action <> 'money.payout' then
    return jsonb_build_object('ok', false, 'error', 'not_a_payout',
      'message', 'That signature is not a payout.');
  end if;
  if v_a.status <> 'applied' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'approval_status', v_a.status,
      'message', 'The signature was not spent by this call.');
  end if;
  if v_a.decided_by <> p_actor_user_id then
    return jsonb_build_object('ok', false, 'error', 'unauthorised',
      'message', 'Only the seat that released a signature may spend it.');
  end if;

  if v_a.target_kind = 'payout' then
    select * into v_row from money_payouts
      where id = v_a.target_id::uuid for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    if v_row.status = 'released' then
      return jsonb_build_object('ok', false, 'error', 'conflict', 'ref', v_row.ref,
        'message', 'This payout was already accrued by its signature.');
    end if;
    if v_row.status <> 'pending_signature' then
      return jsonb_build_object('ok', false, 'error', 'conflict', 'payout_status', v_row.status,
        'ref', v_row.ref, 'message', 'This paper is not waiting for that signature.');
    end if;

    v_legs := platform_auth.money_leg(v_row.fund_account_id, 'debit', v_row.amount + v_row.fee_amount,
              'Payout to ' || v_row.payee_name || ' accrued')
         || platform_auth.money_leg(v_row.payable_account_id, 'credit',
              v_row.amount + v_row.fee_amount, v_row.payee_name || ' owed on ' || v_row.ref);
    v_post := platform_auth.record_money_posting(v_row.tenant_id, current_date,
      left('Payout ' || v_row.ref || ' released to ' || v_row.payee_name || ' — '
           || coalesce(v_a.reason, ''), 200),
      v_row.currency, 'payout', v_row.id, v_row.ref, null, p_actor_user_id, v_legs);

    update money_payouts
       set status = 'released', released_by = p_actor_user_id, released_at = now(),
           accrual_posting_id = (v_post -> 'posting' ->> 'id')::uuid
     where id = v_row.id;

    perform platform_auth.money_audit(v_row.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      null, 'money_payouts', v_row.id, 'payout.released',
      jsonb_build_object('status', v_row.status),
      jsonb_build_object('ref', v_row.ref, 'payee', v_row.payee_name, 'amount', v_row.amount,
        'fee_amount', v_row.fee_amount, 'currency', v_row.currency, 'rail', v_row.rail_code,
        'approval_id', v_a.id, 'proposed_by', v_a.proposed_by, 'purpose', v_row.purpose,
        'payload_sha256', v_a.payload_sha256, 'posting', v_post -> 'posting' ->> 'ref',
        'status', 'released'));

    return jsonb_build_object('ok', true, 'target_kind', 'payout', 'payout_id', v_row.id,
      'ref', v_row.ref, 'payee', v_row.payee_name, 'payee_id', v_row.payee_id,
      'amount', v_row.amount, 'fee_amount', v_row.fee_amount, 'currency', v_row.currency,
      'source_kind', v_row.source_kind, 'source_id', v_row.source_id,
      'posting', v_post -> 'posting', 'approval_id', v_a.id,
      'raised_by', v_row.raised_by, 'released_by', p_actor_user_id);
  end if;

  if v_a.target_kind <> 'payout_batch' then
    return jsonb_build_object('ok', false, 'error', 'not_a_payout',
      'message', 'That signature is not aimed at a payout or a batch of them.');
  end if;

  select * into v_b from money_payout_batches
    where id = v_a.target_id::uuid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_b.status = 'released' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'ref', v_b.ref,
      'message', 'This batch was already spent.');
  end if;
  if v_b.status <> 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'batch_status', v_b.status,
      'ref', v_b.ref, 'message', 'This batch is not waiting for that signature.');
  end if;

  -- The batch is released before its lines, because each line's own guard asks the batch what state
  -- its signature is in and a line released under a batch that still reads `pending_signature` is a
  -- line the office cannot prove was signed.
  update money_payout_batches
     set status = 'released', released_by = p_actor_user_id, released_at = now()
   where id = v_b.id;

  for v_line in
    select * from money_payouts
     where batch_id = v_b.id and status = 'raised'
     order by id for update
  loop
    select * into v_rail from money_payout_rails where code = v_line.rail_code;
    v_legs := platform_auth.money_leg(v_line.fund_account_id, 'debit',
                v_line.amount + v_line.fee_amount,
                'Payout to ' || v_line.payee_name || ' accrued')
           || platform_auth.money_leg(v_line.payable_account_id, 'credit',
                v_line.amount + v_line.fee_amount,
                v_line.payee_name || ' owed on ' || v_line.ref);
    v_post := platform_auth.record_money_posting(v_line.tenant_id, current_date,
      left('Payout ' || v_line.ref || ' released in batch ' || v_b.ref || ' to '
           || v_line.payee_name, 200),
      v_line.currency, 'payout', v_line.id, v_line.ref, null, p_actor_user_id, v_legs);

    update money_payouts
       set status = 'released', released_by = p_actor_user_id, released_at = now(),
           accrual_posting_id = (v_post -> 'posting' ->> 'id')::uuid
     where id = v_line.id;

    -- One audit per line, not one per signature. A payee phones about their own paper, and the desk
    -- answering has to find the movement on that paper's row rather than reconstruct it from the
    -- batch's answer and the loop that ran.
    perform platform_auth.money_audit(v_line.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      null, 'money_payouts', v_line.id, 'payout.released',
      jsonb_build_object('status', v_line.status, 'batch_id', v_line.batch_id),
      jsonb_build_object('ref', v_line.ref, 'payee', v_line.payee_name, 'amount', v_line.amount,
        'fee_amount', v_line.fee_amount, 'currency', v_line.currency, 'rail', v_line.rail_code,
        'approval_id', v_a.id, 'proposed_by', v_a.proposed_by, 'purpose', v_line.purpose,
        'payload_sha256', v_a.payload_sha256, 'batch', v_b.ref,
        'posting', v_post -> 'posting' ->> 'ref', 'status', 'released'));

    v_refs := v_refs || jsonb_build_object(v_line.ref, v_post -> 'posting' ->> 'ref');
    v_count := v_count + 1;
  end loop;

  perform platform_auth.money_audit(v_b.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
    null, 'money_payout_batches', v_b.id, 'payout_batch.released',
    jsonb_build_object('status', v_b.status, 'total_amount', v_b.total_amount, 'lines', v_b.lines),
    jsonb_build_object('ref', v_b.ref, 'label', v_b.label, 'total_amount', v_b.total_amount,
      'lines', v_b.lines, 'currency', v_b.currency, 'accrued', v_count, 'postings', v_refs,
      'approval_id', v_a.id, 'proposed_by', v_a.proposed_by,
      'payload_sha256', v_a.payload_sha256, 'status', 'released'));

  return jsonb_build_object('ok', true, 'target_kind', 'payout_batch', 'batch_id', v_b.id,
    'ref', v_b.ref, 'label', v_b.label, 'total_amount', v_b.total_amount, 'lines', v_b.lines,
    'accrued', v_count, 'postings', v_refs, 'currency', v_b.currency, 'approval_id', v_a.id,
    'raised_by', v_b.raised_by, 'released_by', p_actor_user_id);
end $$;

-- The cash left. This is the second posting 133's own header said a paid register has to add: the
-- obligation was booked on the signature, and the money is answered on the day it actually goes.
create or replace function platform_auth.mark_money_payout_paid(
  p_tenant uuid, p_payout uuid, p_note text, p_posted_on date,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row  money_payouts;
  v_note text;
  v_fee  uuid;
  v_legs jsonb;
  v_post jsonb;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    raise exception '134: only the office confirms money leaving its own book';
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say how the money went — the rail''s reference, the receipt number, the name '
        || 'that signed for it. 8-600 characters.');
  end if;

  select * into v_row from money_payouts
    where id = p_payout and tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_row.status <> 'released' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'payout_status', v_row.status,
      'ref', v_row.ref,
      'message', 'A payout is paid after a second seat has released it, and once.');
  end if;

  v_fee := (select a.id from money_accounts a
             where a.tenant_id = v_row.tenant_id
               and a.code = 'FEE-INCOME'
                    || case when v_row.currency = 'USD' then '-USD' else '' end
               and a.status = 'open');
  if v_row.fee_amount > 0 and v_fee is null then
    return jsonb_build_object('ok', false, 'error', 'no_fee_line',
      'message', 'This payout carries the office''s cut and the book has no open income line for it.',
      'fee_amount', v_row.fee_amount, 'currency', v_row.currency);
  end if;

  v_legs := platform_auth.money_leg(v_row.payable_account_id, 'debit',
              v_row.amount + v_row.fee_amount,
              v_row.payee_name || ' paid on ' || v_row.ref)
         || platform_auth.money_leg(v_row.cash_account_id, 'credit', v_row.amount,
              'Paid ' || v_row.payee_name || ' on ' || v_row.rail_code)
         || platform_auth.money_leg(v_fee, 'credit', v_row.fee_amount,
              'Office cut on ' || v_row.ref);
  v_post := platform_auth.record_money_posting(v_row.tenant_id,
    coalesce(p_posted_on, current_date),
    left('Payout ' || v_row.ref || ' paid to ' || v_row.payee_name || ' — ' || v_note, 200),
    v_row.currency, 'payout', v_row.id, v_row.ref, null, p_actor, v_legs);

  update money_payouts
     set status = 'paid', paid_by = p_actor, paid_at = now(), paid_note = v_note,
         payment_posting_id = (v_post -> 'posting' ->> 'id')::uuid
   where id = v_row.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_payouts', v_row.id, 'payout.paid',
    jsonb_build_object('status', v_row.status, 'accrual', v_row.accrual_posting_id),
    jsonb_build_object('ref', v_row.ref, 'payee', v_row.payee_name, 'amount', v_row.amount,
      'fee_amount', v_row.fee_amount, 'currency', v_row.currency, 'rail', v_row.rail_code,
      'payee_ref_tail', v_row.payee_ref_tail, 'note', v_note,
      'posting', v_post -> 'posting' ->> 'ref',
      'source_kind', v_row.source_kind, 'source_ref', v_row.source_ref, 'status', 'paid'));

  return jsonb_build_object('ok', true, 'posting', v_post -> 'posting',
    'payout', platform_auth.money_payout_detail(p_tenant, v_row.id));
end $$;

-- The rail said no. The obligation is answered by its mirror, not by deleting the accrual: the office
-- owed the money, tried to pay it, and the book keeps both facts.
create or replace function platform_auth.mark_money_payout_failed(
  p_tenant uuid, p_payout uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row  money_payouts;
  v_rev  jsonb;
  v_reason text;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    raise exception '134: only the office records its own payments failing';
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say what the rail answered, in 8-600 characters: it is the sentence the next '
        || 'payout for the same person starts from.');
  end if;

  select * into v_row from money_payouts
    where id = p_payout and tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_row.status <> 'released' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'payout_status', v_row.status,
      'ref', v_row.ref,
      'message', 'Only a released payout can fail. A paper nobody signed has not tried to pay yet.');
  end if;

  -- 133 writes this sentence into the accrual's own `reversal_note`, whose column check stops at 600
  -- characters, so the reason is cut before the ref is glued in front of it rather than after.
  v_rev := platform_auth.reverse_money_posting(v_row.tenant_id, v_row.accrual_posting_id,
    left('Payout ' || v_row.ref || ' failed: ' || v_reason, 600), p_actor);
  if (v_rev ->> 'ok')::boolean is not true then
    return jsonb_build_object('ok', false, 'error', 'reversal_refused',
      'message', 'The accrual behind this payout could not be answered.',
      'answer', v_rev);
  end if;

  update money_payouts
     set status = 'failed', failed_by = p_actor, failed_at = now(), failure_reason = v_reason
   where id = v_row.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_payouts', v_row.id, 'payout.failed',
    jsonb_build_object('status', v_row.status, 'accrual', v_row.accrual_posting_id),
    jsonb_build_object('ref', v_row.ref, 'payee', v_row.payee_name, 'amount', v_row.amount,
      'fee_amount', v_row.fee_amount, 'currency', v_row.currency, 'rail', v_row.rail_code,
      'reason', v_reason, 'reversal', v_rev -> 'reversal' ->> 'ref',
      'accrual', v_row.accrual_posting_id, 'status', 'failed'));

  return jsonb_build_object('ok', true, 'reversal', v_rev -> 'reversal',
    'payout', platform_auth.money_payout_detail(p_tenant, v_row.id));
end $$;

-- The batch is finished when every line under it has answered. Nothing new is booked here — it is the
-- desk's own way of saying the paper is done, which is why it refuses while a line is still owed.
create or replace function platform_auth.close_money_payout_batch(
  p_tenant uuid, p_batch uuid, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_b  money_payout_batches;
  v_left int;
  v_note text;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    raise exception '134: only the office closes its own batches';
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say what the batch ended with, in 8-600 characters.');
  end if;

  select * into v_b from money_payout_batches
    where id = p_batch and tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_b.status = 'closed' then
    return jsonb_build_object('ok', false, 'error', 'already_closed', 'ref', v_b.ref);
  end if;
  if v_b.status <> 'released' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'batch_status', v_b.status,
      'ref', v_b.ref,
      'message', 'A batch is closed from its spent signature, not from the board.');
  end if;

  select count(*) into v_left from money_payouts
    where batch_id = v_b.id and status in ('raised','pending_signature','released');
  if v_left > 0 then
    return jsonb_build_object('ok', false, 'error', 'lines_outstanding', 'ref', v_b.ref,
      'message', 'This batch still owes an answer on some of its lines.',
      'outstanding', v_left);
  end if;

  update money_payout_batches
     set status = 'closed', closed_by = p_actor, closed_at = now(), closed_note = v_note
   where id = v_b.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_payout_batches', v_b.id, 'payout_batch.closed',
    jsonb_build_object('status', v_b.status),
    jsonb_build_object('ref', v_b.ref, 'label', v_b.label, 'total_amount', v_b.total_amount,
      'lines', v_b.lines, 'currency', v_b.currency, 'note', v_note, 'status', 'closed'));

  return jsonb_build_object('ok', true,
    'batch', platform_auth.money_payout_batch_detail(p_tenant, v_b.id));
end $$;

-- ------------------------------------------------------------
-- 8d. the reads the desk prints
-- ------------------------------------------------------------

/**
 * Nothing here writes and nothing here decides. These are the boards a seat reads before it is asked
 * for a signature, so every figure is recomputed from the legs rather than taken from the cached
 * column it is meant to be checked against — 133's `money_book()` keeps the same rule, and
 * `money_payable()` below is where that rule is pointed at the papers instead of at the book.
 *
 * The payout reads build their objects field by field rather than with `to_jsonb(row)`. A bytea has
 * no JSON form, so the whole read would fail outright — and if it did not, it would hand the desk the
 * account number it is allowed to see only the tail of. `payee_ref_encrypted` is in no read in this
 * file; the reveal route is the only door that opens it, and the only place a seat is recorded as
 * having asked.
 *
 * Every board cuts its page in its own subquery before it aggregates anything, which is 133's
 * `money_register()` pattern and the reason a desk with six hundred payouts on it does not sum three
 * thousand legs to throw five hundred and forty rows away.
 */

-- The signature a paper is waiting on, in the words a desk has to read out: who asked, who decided,
-- and whether it is still open. Three reads want it, and none of them should re-derive it
-- differently — the figure a second seat signed is only useful if the desk can say who signed it.
create or replace function platform_auth.money_approval(p_approval uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select (select jsonb_build_object(
            'id', a.id, 'action', a.action, 'status', a.status, 'reason', a.reason,
            'target_kind', a.target_kind, 'target_id', a.target_id,
            'proposed_by', (select u.full_name from users u where u.id = a.proposed_by),
            'proposed_role', a.proposed_role, 'proposed_at', a.proposed_at,
            'decided_by', (select u.full_name from users u where u.id = a.decided_by),
            'decided_role', a.decided_role, 'decided_note', a.decided_note,
            'decided_at', a.decided_at, 'applied_at', a.applied_at,
            'expires_at', a.expires_at, 'result', a.result)
       from platform_approvals a where a.id = p_approval);
$$;

-- The rails, with how many payouts have actually travelled by each. A clerk chooses a rail by its
-- words, so this is the one place those words are kept: the code, the label a person reads, the
-- family it belongs to, and the shape the payee line has to be. `needs` is printed here because a
-- desk that learns it after typing an account number has been asked to retype the paper.
create or replace function platform_auth.money_rails(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
               'code', r.code, 'label', r.label, 'family', r.family, 'needs', r.needs,
               'note', r.note, 'retired', r.retired, 'sort', r.sort,
               'paid', coalesce((select count(*)::int from money_payouts p
                                  where p.rail_code = r.code and p.tenant_id = p_tenant), 0),
               'settled', coalesce((select sum(p.amount + p.fee_amount)::numeric(14,2)
                                      from money_payouts p
                                     where p.rail_code = r.code and p.tenant_id = p_tenant
                                       and p.status = 'paid'), 0)
             ) order by r.sort, r.code)
           from money_payout_rails r), '[]'::jsonb),
    'count', (select count(*)::int from money_payout_rails),
    'offered', (select count(*)::int from money_payout_rails where not retired),
    'bound', p_tenant);
$$;

/**
 * The wallets board: whose money the office is holding, and how much of it is really there.
 *
 * `balance` is the legs and `cached` is the account's own running totals, both on one row, because a
 * cached figure is a claim and the desk is the body that notices when the claim stops matching. A
 * drift line here is the same fault 133 refuses to let a posting commit, and it is printed rather
 * than hidden because the trigger that keeps it can only be caught at commit time.
 */
create or replace function platform_auth.money_wallet_board(
  p_tenant uuid, p_status text, p_currency text, p_search text,
  p_limit int, p_offset int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows   jsonb;
  v_held   jsonb;
  v_count  int;
  v_status text := nullif(lower(trim(coalesce(p_status, ''))), '');
  v_cur    text := nullif(upper(trim(coalesce(p_currency, ''))), '');
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_limit  int := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('rows', '[]'::jsonb, 'count', 0, 'returned', 0,
      'limit', v_limit, 'offset', v_offset, 'held', '[]'::jsonb,
      'error', 'A wallet is a line in the office''s own book, and this is not that book.');
  end if;

  select count(*)::int into v_count
    from money_wallets w
   where w.tenant_id = p_tenant
     and (v_status is null or w.status = v_status)
     and (v_cur is null or w.currency = v_cur)
     and (v_search is null or w.holder_name ilike '%' || v_search || '%'
                       or coalesce(w.note, '') ilike '%' || v_search || '%');

  select coalesce(jsonb_agg(row_json order by opened_at desc, holder, cur), '[]'::jsonb) into v_rows
    from (
      select w.opened_at, w.holder_name as holder, w.currency as cur, jsonb_build_object(
        'id', w.id, 'holder', w.holder_name, 'owner_tenant_id', w.owner_tenant_id,
        'owner_type', (select t.type from tenants t where t.id = w.owner_tenant_id),
        'currency', w.currency, 'account', b.code, 'account_id', w.account_id,
        'balance', b.balance, 'cached', b.cached, 'drift', b.balance - b.cached,
        'legs', b.legs, 'holds', b.holds, 'withdrawals', b.withdrawals,
        'status', w.status, 'frozen_reason', w.frozen_reason, 'note', w.note,
        'opened_at', w.opened_at, 'opened_by', b.opened_by
      ) as row_json
      from (
        select w2.id
          from money_wallets w2
         where w2.tenant_id = p_tenant
           and (v_status is null or w2.status = v_status)
           and (v_cur is null or w2.currency = v_cur)
           and (v_search is null or w2.holder_name ilike '%' || v_search || '%'
                             or coalesce(w2.note, '') ilike '%' || v_search || '%')
         order by w2.opened_at desc, w2.holder_name, w2.currency
         limit v_limit offset v_offset
      ) page
      join money_wallets w on w.id = page.id
      cross join lateral (
        select a.code,
               coalesce((select sum(case when e.direction = 'credit' then e.amount else -e.amount end)
                           from money_entries e where e.account_id = a.id), 0)::numeric(14,2)
                 as balance,
               (a.credit_total - a.debit_total)::numeric(14,2) as cached,
               a.entry_count::int as legs,
               coalesce((select count(*)::int from money_escrow_holds h
                          where h.tenant_id = w.tenant_id
                            and (h.payer_wallet_id = w.id or h.payee_wallet_id = w.id)
                            and h.status in ('held','pending_discharge')), 0) as holds,
               coalesce((select count(*)::int from money_payouts p
                          where p.tenant_id = w.tenant_id
                            and p.source_kind = 'wallet_withdrawal'
                            and p.source_id = w.id), 0) as withdrawals,
               (select u.full_name from users u where u.id = w.opened_by) as opened_by
          from money_accounts a
         where a.id = w.account_id
      ) b
    ) x;

  -- The heading the board adds up under: every wallet the filters still name, not the page. A desk
  -- that totals the twenty rows it can see reports a fraction of the money it holds as the whole.
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', g.currency, 'wallets', g.wallets, 'held', g.held, 'frozen', g.frozen
         ) order by g.currency), '[]'::jsonb) into v_held
    from (
      select w.currency, count(*)::int as wallets,
             coalesce(sum(b.balance), 0)::numeric(14,2) as held,
             count(*) filter (where w.status = 'frozen')::int as frozen
        from money_wallets w
       cross join lateral (select platform_auth.money_wallet_balance(w.id) as balance) b
       where w.tenant_id = p_tenant
         and (v_status is null or w.status = v_status)
         and (v_cur is null or w.currency = v_cur)
         and (v_search is null or w.holder_name ilike '%' || v_search || '%'
                           or coalesce(w.note, '') ilike '%' || v_search || '%')
       group by w.currency
    ) g;

  return jsonb_build_object('rows', v_rows, 'count', v_count,
                            'returned', coalesce(jsonb_array_length(v_rows), 0),
                            'limit', v_limit, 'offset', v_offset, 'held', v_held);
end $$;

/**
 * One wallet, the money it holds and the papers that move it: the last movements on its own line, the
 * holds it is a party to and the withdrawals raised against it.
 *
 * The movements are the legs read straight off the book rather than a summary, because the question a
 * person asks about a balance is "which six things made it", and a number with no ref next to it is
 * the kind of answer that ends a phone call with nobody believing it.
 */
create or replace function platform_auth.money_wallet_detail(p_tenant uuid, p_wallet uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object(
              'id', w.id, 'holder', w.holder_name, 'owner_tenant_id', w.owner_tenant_id,
              'owner_name', (select t.name from tenants t where t.id = w.owner_tenant_id),
              'owner_type', (select t.type from tenants t where t.id = w.owner_tenant_id),
              'currency', w.currency, 'status', w.status, 'note', w.note,
              'frozen_reason', w.frozen_reason, 'frozen_at', w.frozen_at,
              'frozen_by', (select u.full_name from users u where u.id = w.frozen_by),
              'opened_at', w.opened_at,
              'opened_by', (select u.full_name from users u where u.id = w.opened_by),
              'account', platform_auth.money_account_row(p_tenant, w.account_id),
              'balance', platform_auth.money_wallet_balance(w.id),
              'movements', coalesce((select jsonb_agg(m.row_json order by m.sort_at desc, m.ref) from (
                          select p.raised_at as sort_at, p.ref as ref, jsonb_build_object(
                            'ref', p.ref, 'posting', p.id,
                            'posted_on', to_char(p.posted_on, 'YYYY-MM-DD'),
                            'memo', p.memo, 'source_kind', p.source_kind,
                            'source_ref', p.source_ref, 'posting_status', p.status,
                            'direction', e.direction, 'amount', e.amount,
                            'detail', e.detail) as row_json
                            from money_entries e
                            join money_postings p on p.id = e.posting_id
                           where e.account_id = w.account_id
                           order by p.raised_at desc limit 12) m), '[]'::jsonb),
              'holds', coalesce((select jsonb_agg(h.row_json order by h.sort_at desc) from (
                          select e.raised_at as sort_at, jsonb_build_object(
                            'id', e.id, 'ref', e.ref, 'status', e.status,
                            'amount', e.amount, 'currency', e.currency,
                            'side', case when e.payer_wallet_id = w.id then 'payer' else 'payee' end,
                            'subject_kind', e.subject_kind, 'subject_ref', e.subject_ref,
                            'raised_at', e.raised_at) as row_json
                            from money_escrow_holds e
                           where e.tenant_id = p_tenant
                             and (e.payer_wallet_id = w.id or e.payee_wallet_id = w.id)
                           order by e.raised_at desc limit 12) h), '[]'::jsonb),
              'withdrawals', coalesce((select jsonb_agg(v.row_json order by v.sort_at desc) from (
                          select p.raised_at as sort_at, jsonb_build_object(
                            'id', p.id, 'ref', p.ref, 'status', p.status,
                            'amount', p.amount, 'fee', p.fee_amount, 'currency', p.currency,
                            'rail', p.rail_code, 'raised_at', p.raised_at) as row_json
                            from money_payouts p
                           where p.tenant_id = p_tenant
                             and p.source_kind = 'wallet_withdrawal'
                             and p.source_id = w.id
                           order by p.raised_at desc limit 12) v), '[]'::jsonb))
       from money_wallets w
      where w.id = p_wallet and w.tenant_id = p_tenant),
    jsonb_build_object('error', 'There is no wallet in this book.'));
$$;

/**
 * The escrow board: whose job has money sitting against it, and what state the paper is in.
 *
 * A hold is read by the subject it names, so the subject's own number and the tenant it belongs to
 * are on every row: the question a desk is asked over the phone is "is my job held up?", and that is
 * answered by the booking's number, not by an internal escrow ref the caller has never seen.
 */
create or replace function platform_auth.money_escrow_board(
  p_tenant uuid, p_status text, p_currency text, p_subject_kind text,
  p_limit int, p_offset int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows   jsonb;
  v_sums   jsonb;
  v_count  int;
  v_status text := nullif(lower(trim(coalesce(p_status, ''))), '');
  v_cur    text := nullif(upper(trim(coalesce(p_currency, ''))), '');
  v_kind   text := nullif(lower(trim(coalesce(p_subject_kind, ''))), '');
  v_limit  int := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('rows', '[]'::jsonb, 'count', 0, 'returned', 0,
      'limit', v_limit, 'offset', v_offset, 'held', '[]'::jsonb,
      'error', 'An escrow hold is a line in the office''s own book, and this is not that book.');
  end if;

  select count(*)::int into v_count
    from money_escrow_holds h
   where h.tenant_id = p_tenant
     and (v_status is null or h.status = v_status)
     and (v_cur is null or h.currency = v_cur)
     and (v_kind is null or h.subject_kind = v_kind);

  select coalesce(jsonb_agg(row_json order by raised_at desc, ref desc), '[]'::jsonb) into v_rows
    from (
      select h.raised_at, h.ref, jsonb_build_object(
        'id', h.id, 'ref', h.ref, 'status', h.status,
        'amount', h.amount, 'currency', h.currency,
        'subject_kind', h.subject_kind, 'subject_id', h.subject_id,
        'subject_ref', h.subject_ref, 'subject_note', h.subject_note,
        'subject_tenant_id', h.subject_tenant_id,
        'subject_name', (select t.name from tenants t where t.id = h.subject_tenant_id),
        'reason_code', h.reason_code, 'reason', h.reason,
        'from_account', (select a.code from money_accounts a where a.id = h.from_account_id),
        'into_account', (select a.code from money_accounts a where a.id = h.into_account_id),
        'payer', (select w.holder_name from money_wallets w where w.id = h.payer_wallet_id),
        'payee', (select w.holder_name from money_wallets w where w.id = h.payee_wallet_id),
        'plan', case when h.discharge_kind is null then null else jsonb_build_object(
                    'kind', h.discharge_kind, 'to_payee', h.to_payee,
                    'back_to_payer', h.back_to_payer, 'fee', h.fee_amount) end,
        'approval', (select a.status from platform_approvals a where a.id = h.approval_id),
        'refusals', h.refusals,
        'hold_posting', (select p.ref from money_postings p where p.id = h.hold_posting_id),
        'discharge_posting', (select p.ref from money_postings p where p.id = h.discharge_posting_id),
        'raised_by', (select u.full_name from users u where u.id = h.raised_by),
        'raised_at', h.raised_at, 'held_at', h.held_at,
        'discharged_at', h.discharged_at,
        'discharged_by', (select u.full_name from users u where u.id = h.discharged_by),
        'refused_at', h.refused_at, 'refused_note', h.refused_note
      ) as row_json
      from (
        -- The second sort key is the whole of a stable page. `now()` is the transaction's own
        -- timestamp, so two papers raised in one call carry an identical `raised_at`, and a page
        -- cut on the hour alone is free to show a row twice on page one and never on page two.
        select h2.id
          from money_escrow_holds h2
         where h2.tenant_id = p_tenant
           and (v_status is null or h2.status = v_status)
           and (v_cur is null or h2.currency = v_cur)
           and (v_kind is null or h2.subject_kind = v_kind)
         order by h2.raised_at desc, h2.ref desc
         limit v_limit offset v_offset
      ) page
      join money_escrow_holds h on h.id = page.id
    ) x;

  -- What is parked, by money. `held` counts the papers whose money is in escrow; a `raised` paper has
  -- asked for a hold it has not yet got, and adding its figure to the money the office is holding
  -- would report money that has not moved.
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', g.currency, 'holds', g.holds, 'held', g.held, 'awaiting', g.awaiting
         ) order by g.currency), '[]'::jsonb) into v_sums
    from (
      select h.currency,
             count(*) filter (where h.status in ('held','pending_discharge'))::int as holds,
             coalesce(sum(h.amount) filter (where h.status in ('held','pending_discharge')), 0)
               ::numeric(14,2) as held,
             count(*) filter (where h.status = 'raised')::int as awaiting
        from money_escrow_holds h
       where h.tenant_id = p_tenant
         and (v_status is null or h.status = v_status)
         and (v_cur is null or h.currency = v_cur)
         and (v_kind is null or h.subject_kind = v_kind)
       group by h.currency
    ) g;

  return jsonb_build_object('rows', v_rows, 'count', v_count,
                            'returned', coalesce(jsonb_array_length(v_rows), 0),
                            'limit', v_limit, 'offset', v_offset, 'held', v_sums);
end $$;

-- One hold, in full: the subject, both lines the money moved between, the two movements themselves
-- read off the book, the signature the plan is waiting on and the refusal it has already answered
-- for. A second seat is about to sign a plan over three figures, so all three and the figure they add
-- up to are printed together rather than left for the desk to assemble.
create or replace function platform_auth.money_escrow_detail(p_tenant uuid, p_hold uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select to_jsonb(h) - 'tenant_id' || jsonb_build_object(
              'subject_name', (select t.name from tenants t where t.id = h.subject_tenant_id),
              'from', platform_auth.money_account_row(p_tenant, h.from_account_id),
              'into', platform_auth.money_account_row(p_tenant, h.into_account_id),
              'payer_wallet', (select jsonb_build_object('id', w.id, 'holder', w.holder_name,
                                        'currency', w.currency, 'status', w.status,
                                        'balance', platform_auth.money_wallet_balance(w.id))
                                 from money_wallets w where w.id = h.payer_wallet_id),
              'payee_wallet', (select jsonb_build_object('id', w.id, 'holder', w.holder_name,
                                        'currency', w.currency, 'status', w.status,
                                        'balance', platform_auth.money_wallet_balance(w.id))
                                 from money_wallets w where w.id = h.payee_wallet_id),
              'plan_total', coalesce(h.to_payee, 0) + coalesce(h.back_to_payer, 0)
                             + coalesce(h.fee_amount, 0),
              'plan_agrees', h.discharge_kind is null
                             or (coalesce(h.to_payee, 0) + coalesce(h.back_to_payer, 0)
                                 + coalesce(h.fee_amount, 0)) = h.amount,
              'hold_posting', platform_auth.money_posting_detail(p_tenant, h.hold_posting_id),
              'discharge_posting', platform_auth.money_posting_detail(p_tenant, h.discharge_posting_id),
              'approval', platform_auth.money_approval(h.approval_id),
              'raised_by_name', (select u.full_name from users u where u.id = h.raised_by),
              'discharged_by_name', (select u.full_name from users u where u.id = h.discharged_by),
              'refused_by_name', (select u.full_name from users u where u.id = h.refused_by))
       from money_escrow_holds h
      where h.id = p_hold and h.tenant_id = p_tenant),
    jsonb_build_object('error', 'There is no hold in this book.'));
$$;

/**
 * The payouts board.
 *
 * `p_batch` arrives as text because the desk filters by the number it can read off a printed sheet,
 * and an uuid-shaped filter that is not an uuid would otherwise abort the read with a 22P02 the seat
 * has no way to interpret: a bad filter is no rows, not an error page.
 *
 * The payee line is the tail and nothing else. `line_sealed` says whether the paper carries a number
 * at all, which is what a clerk needs in order to know whether to ask for a reveal.
 */
create or replace function platform_auth.money_payout_board(
  p_tenant uuid, p_status text, p_currency text, p_payee_kind text,
  p_rail text, p_batch text, p_search text, p_limit int, p_offset int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows   jsonb;
  v_due    jsonb;
  v_count  int;
  v_status text := nullif(lower(trim(coalesce(p_status, ''))), '');
  v_cur    text := nullif(upper(trim(coalesce(p_currency, ''))), '');
  v_kind   text := nullif(lower(trim(coalesce(p_payee_kind, ''))), '');
  v_rail   text := nullif(lower(trim(coalesce(p_rail, ''))), '');
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_batch  uuid := case when coalesce(nullif(trim(p_batch), ''), '') ~*
                           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        then nullif(trim(p_batch), '')::uuid end;
  v_limit  int := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('rows', '[]'::jsonb, 'count', 0, 'returned', 0,
      'limit', v_limit, 'offset', v_offset, 'due', '[]'::jsonb,
      'error', 'A payout leaves the office''s own book, and this is not that book.');
  end if;

  select count(*)::int into v_count
    from money_payouts p
   where p.tenant_id = p_tenant
     and (v_status is null or p.status = v_status)
     and (v_cur is null or p.currency = v_cur)
     and (v_kind is null or p.payee_kind = v_kind)
     and (v_rail is null or p.rail_code = v_rail)
     and (v_batch is null or p.batch_id = v_batch)
     and (v_search is null or p.ref ilike '%' || v_search || '%'
                       or p.payee_name ilike '%' || v_search || '%'
                       or p.purpose ilike '%' || v_search || '%'
                       or coalesce(p.source_ref, '') ilike '%' || v_search || '%');

  select coalesce(jsonb_agg(row_json order by raised_at desc, ref desc), '[]'::jsonb) into v_rows
    from (
      select p.raised_at, p.ref, jsonb_build_object(
        'id', p.id, 'ref', p.ref, 'status', p.status,
        'amount', p.amount, 'fee', p.fee_amount, 'total', p.amount + p.fee_amount,
        'currency', p.currency,
        'payee_kind', p.payee_kind, 'payee_id', p.payee_id, 'payee_name', p.payee_name,
        'rail', p.rail_code, 'rail_label', (select r.label from money_payout_rails r
                                              where r.code = p.rail_code),
        'rail_family', (select r.family from money_payout_rails r where r.code = p.rail_code),
        'line_tail', p.payee_ref_tail, 'line_sealed', p.payee_ref_encrypted is not null,
        'source_kind', p.source_kind, 'source_id', p.source_id, 'source_ref', p.source_ref,
        'purpose', p.purpose,
        'batch', (select b.ref from money_payout_batches b where b.id = p.batch_id),
        'batch_id', p.batch_id,
        'payable', (select a.code from money_accounts a where a.id = p.payable_account_id),
        'accrual', (select o.ref from money_postings o where o.id = p.accrual_posting_id),
        'payment', (select o.ref from money_postings o where o.id = p.payment_posting_id),
        'approval', (select a.status from platform_approvals a where a.id = p.approval_id),
        'raised_by', (select u.full_name from users u where u.id = p.raised_by),
        'raised_at', p.raised_at, 'released_at', p.released_at, 'paid_at', p.paid_at,
        'failed_at', p.failed_at, 'failure_reason', p.failure_reason,
        'declined_at', p.declined_at
      ) as row_json
      from (
        select p2.id
          from money_payouts p2
         where p2.tenant_id = p_tenant
           and (v_status is null or p2.status = v_status)
           and (v_cur is null or p2.currency = v_cur)
           and (v_kind is null or p2.payee_kind = v_kind)
           and (v_rail is null or p2.rail_code = v_rail)
           and (v_batch is null or p2.batch_id = v_batch)
           and (v_search is null or p2.ref ilike '%' || v_search || '%'
                             or p2.payee_name ilike '%' || v_search || '%'
                             or p2.purpose ilike '%' || v_search || '%'
                             or coalesce(p2.source_ref, '') ilike '%' || v_search || '%')
         order by p2.raised_at desc, p2.ref desc
         limit v_limit offset v_offset
      ) page
      join money_payouts p on p.id = page.id
    ) x;

  -- What the office owes out, in each money, counted from the papers rather than from the book's
  -- payable lines: `money_payable()` below is the read that compares the two, and a board that only
  -- ever showed the book's own figure could not disagree with anything.
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', g.currency, 'released', g.released, 'awaiting', g.awaiting,
           'due', g.due, 'failed', g.failed
         ) order by g.currency), '[]'::jsonb) into v_due
    from (
      select p.currency,
             count(*) filter (where p.status = 'released')::int as released,
             count(*) filter (where p.status = 'pending_signature')::int as awaiting,
             coalesce(sum(p.amount + p.fee_amount) filter (where p.status = 'released'), 0)
               ::numeric(14,2) as due,
             count(*) filter (where p.status = 'failed')::int as failed
        from money_payouts p
       where p.tenant_id = p_tenant
       group by p.currency
    ) g;

  return jsonb_build_object('rows', v_rows, 'count', v_count,
                            'returned', coalesce(jsonb_array_length(v_rows), 0),
                            'limit', v_limit, 'offset', v_offset, 'due', v_due);
end $$;

-- One payout, in full, and the only place the payee's keyed hash is read back. The hash is not a
-- secret — it is a digest the second seat already signed — and the desk needs it to answer "is this
-- the number I signed?" without anybody opening the line. Both movements are printed with their legs,
-- because a payout that accrued and then failed has two sides to it and the mirror is the part a
-- caller asks about.
create or replace function platform_auth.money_payout_detail(p_tenant uuid, p_payout uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object(
              'id', p.id, 'tenant_id', p.tenant_id, 'ref', p.ref, 'batch_id', p.batch_id,
              'payee_kind', p.payee_kind, 'payee_id', p.payee_id, 'payee_name', p.payee_name,
              'payee_tenant_id', p.payee_tenant_id,
              'rail_code', p.rail_code, 'rail_label', (select r.label from money_payout_rails r
                                                         where r.code = p.rail_code),
              'rail_family', (select r.family from money_payout_rails r where r.code = p.rail_code),
              'rail_needs', (select r.needs from money_payout_rails r where r.code = p.rail_code),
              'payee_ref_tail', p.payee_ref_tail, 'payee_ref_hash', p.payee_ref_hash,
              'line_sealed', p.payee_ref_encrypted is not null,
              'amount', p.amount, 'fee_amount', p.fee_amount,
              'total', p.amount + p.fee_amount, 'currency', p.currency,
              'source_kind', p.source_kind, 'source_id', p.source_id, 'source_ref', p.source_ref,
              'purpose', p.purpose, 'status', p.status,
              'fund', platform_auth.money_account_row(p_tenant, p.fund_account_id),
              'payable', platform_auth.money_account_row(p_tenant, p.payable_account_id),
              'cash', platform_auth.money_account_row(p_tenant, p.cash_account_id),
              'accrual_posting', platform_auth.money_posting_detail(p_tenant, p.accrual_posting_id),
              'payment_posting', platform_auth.money_posting_detail(p_tenant, p.payment_posting_id),
              'approval', platform_auth.money_approval(p.approval_id),
              'batch', (select jsonb_build_object('id', b.id, 'ref', b.ref, 'label', b.label,
                                 'status', b.status, 'total_amount', b.total_amount,
                                 'lines', b.lines)
                          from money_payout_batches b where b.id = p.batch_id),
              'source_paper', case p.source_kind
                when 'refund' then (select jsonb_build_object(
                                    'ref', r.ref, 'status', r.status, 'amount', r.amount,
                                    'currency', r.currency, 'company', r.company_name,
                                    'ticket_ref', r.ticket_ref, 'released_at', r.released_at)
                                    from service_refund_requests r where r.id = p.source_id)
                when 'payroll' then (select jsonb_build_object(
                                    'period', to_char(y.period, 'YYYY-MM'), 'status', y.status,
                                    'net_total', y.net_total, 'headcount', y.headcount,
                                    'currency', y.currency)
                                    from payroll_runs y where y.id = p.source_id)
                when 'wallet_withdrawal' then (select jsonb_build_object(
                                    'holder', w.holder_name, 'currency', w.currency,
                                    'status', w.status,
                                    'balance', platform_auth.money_wallet_balance(w.id))
                                    from money_wallets w where w.id = p.source_id)
                else null end,
              'raised_by', (select u.full_name from users u where u.id = p.raised_by),
              'raised_at', p.raised_at,
              'released_by', (select u.full_name from users u where u.id = p.released_by),
              'released_at', p.released_at,
              'paid_by', (select u.full_name from users u where u.id = p.paid_by),
              'paid_at', p.paid_at, 'paid_note', p.paid_note,
              'failed_by', (select u.full_name from users u where u.id = p.failed_by),
              'failed_at', p.failed_at, 'failure_reason', p.failure_reason,
              'declined_by', (select u.full_name from users u where u.id = p.declined_by),
              'declined_at', p.declined_at, 'declined_note', p.declined_note,
              'created_at', p.created_at, 'updated_at', p.updated_at)
       from money_payouts p
      where p.id = p_payout and p.tenant_id = p_tenant),
    jsonb_build_object('error', 'There is no payout in this book.'));
$$;

/**
 * The batches board: one signature over several lines.
 *
 * Each row carries its own line counts by status, because the question a desk asks a batch is "can I
 * close it yet", and that is answered by what is outstanding under it rather than by the total the
 * second seat signed.
 */
create or replace function platform_auth.money_payout_batch_board(
  p_tenant uuid, p_status text, p_currency text, p_search text,
  p_limit int, p_offset int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows   jsonb;
  v_count  int;
  v_status text := nullif(lower(trim(coalesce(p_status, ''))), '');
  v_cur    text := nullif(upper(trim(coalesce(p_currency, ''))), '');
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_limit  int := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('rows', '[]'::jsonb, 'count', 0, 'returned', 0,
      'limit', v_limit, 'offset', v_offset,
      'error', 'A payout batch is a paper of the office''s own book.');
  end if;

  select count(*)::int into v_count
    from money_payout_batches b
   where b.tenant_id = p_tenant
     and (v_status is null or b.status = v_status)
     and (v_cur is null or b.currency = v_cur)
     and (v_search is null or b.ref ilike '%' || v_search || '%'
                       or b.label ilike '%' || v_search || '%'
                       or coalesce(b.reason, '') ilike '%' || v_search || '%');

  select coalesce(jsonb_agg(row_json order by raised_at desc, ref desc), '[]'::jsonb) into v_rows
    from (
      select b.raised_at, b.ref, jsonb_build_object(
        'id', b.id, 'ref', b.ref, 'label', b.label, 'currency', b.currency,
        'status', b.status, 'total_amount', b.total_amount, 'lines', b.lines,
        'reason', b.reason,
        'approval', (select a.status from platform_approvals a where a.id = b.approval_id),
        'paid', coalesce(l.paid, 0), 'failed', coalesce(l.failed, 0),
        'declined', coalesce(l.declined, 0), 'outstanding', coalesce(l.outstanding, 0),
        'paid_total', coalesce(l.paid_total, 0),
        'raised_by', (select u.full_name from users u where u.id = b.raised_by),
        'raised_at', b.raised_at,
        'released_by', (select u.full_name from users u where u.id = b.released_by),
        'released_at', b.released_at,
        'closed_by', (select u.full_name from users u where u.id = b.closed_by),
        'closed_at', b.closed_at, 'closed_note', b.closed_note
      ) as row_json
      from (
        select b2.id
          from money_payout_batches b2
         where b2.tenant_id = p_tenant
           and (v_status is null or b2.status = v_status)
           and (v_cur is null or b2.currency = v_cur)
           and (v_search is null or b2.ref ilike '%' || v_search || '%'
                             or b2.label ilike '%' || v_search || '%'
                             or coalesce(b2.reason, '') ilike '%' || v_search || '%')
         order by b2.raised_at desc, b2.ref desc
         limit v_limit offset v_offset
      ) page
      join money_payout_batches b on b.id = page.id
      left join lateral (
        select count(*) filter (where p.status = 'paid')::int as paid,
               count(*) filter (where p.status = 'failed')::int as failed,
               count(*) filter (where p.status = 'declined')::int as declined,
               count(*) filter (where p.status in ('raised','pending_signature','released'))::int
                 as outstanding,
               coalesce(sum(p.amount + p.fee_amount) filter (where p.status = 'paid'), 0)
                 ::numeric(14,2) as paid_total
          from money_payouts p where p.batch_id = b.id
      ) l on true
    ) x;

  return jsonb_build_object('rows', v_rows, 'count', v_count,
                            'returned', coalesce(jsonb_array_length(v_rows), 0),
                            'limit', v_limit, 'offset', v_offset);
end $$;

-- One batch and every line under it, with the figure it was signed for beside the figure its lines
-- actually add up to now. The two are allowed to differ only in one direction — a line can fail or be
-- declined after the signature, but `payout_batch_figures_are_kept` forbids the signed total from
-- moving — so a disagreement here is the desk being told the paper no longer describes the money.
create or replace function platform_auth.money_payout_batch_detail(p_tenant uuid, p_batch uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select to_jsonb(b) - 'tenant_id' || jsonb_build_object(
              'approval', platform_auth.money_approval(b.approval_id),
              'raised_by_name', (select u.full_name from users u where u.id = b.raised_by),
              'released_by_name', (select u.full_name from users u where u.id = b.released_by),
              'closed_by_name', (select u.full_name from users u where u.id = b.closed_by),
              'lines_now', coalesce((select count(*)::int from money_payouts p
                                      where p.batch_id = b.id), 0),
              'sum_now', coalesce((select sum(p.amount + p.fee_amount)::numeric(14,2)
                                     from money_payouts p where p.batch_id = b.id), 0),
              'signed_sum', b.total_amount,
              'figures_agree', coalesce((select sum(p.amount + p.fee_amount)::numeric(14,2)
                                           from money_payouts p where p.batch_id = b.id), 0)
                               = b.total_amount,
              'by_status', coalesce((select jsonb_object_agg(p.status, p.n) from (
                          select p2.status, count(*)::int as n
                            from money_payouts p2 where p2.batch_id = b.id
                           group by p2.status) p), '{}'::jsonb),
              'payouts', coalesce((select jsonb_agg(x.row_json order by x.sort_at desc, x.ref) from (
                          select p.raised_at as sort_at, p.ref as ref, jsonb_build_object(
                            'id', p.id, 'ref', p.ref, 'status', p.status,
                            'payee_kind', p.payee_kind, 'payee_name', p.payee_name,
                            'payee_id', p.payee_id, 'rail', p.rail_code,
                            'line_tail', p.payee_ref_tail,
                            'amount', p.amount, 'fee', p.fee_amount,
                            'total', p.amount + p.fee_amount, 'currency', p.currency,
                            'source_kind', p.source_kind, 'source_ref', p.source_ref,
                            'purpose', p.purpose, 'paid_at', p.paid_at,
                            'failure_reason', p.failure_reason, 'raised_at', p.raised_at) as row_json
                            from money_payouts p
                           where p.batch_id = b.id
                           order by p.raised_at desc limit 200) x), '[]'::jsonb))
       from money_payout_batches b
      where b.id = p_batch and b.tenant_id = p_tenant),
    jsonb_build_object('error', 'There is no batch in this book.'));
$$;

/**
 * The one read that asks the papers and the book the same question separately and prints both
 * answers: is the money the office says it owes the money some paper says it is owed?
 *
 * `book` is the legs, `cached` is the account's own running totals and `papers` is the registers this
 * file writes — the holds that are still parked and the payouts that have been released but not yet
 * paid. A row where `book` and `cached` disagree is a trigger that got it wrong; a row where `book`
 * and `papers` disagree is an office holding money it cannot account for, which is a different fault
 * and needs a different word.
 *
 * The wallet lines have no independent paper: a holder's balance is what its legs say it is, so
 * `papers` is null there and the square count does not pretend to have checked it. What this file can
 * prove is escrow and the two payables; reconciling the payable lines against 005's payment rows and
 * 114's gateway webhook log is 135's job, and the money in the office's bank against the office's
 * own cash lines is a figure the desk declares, not a fact the schema can reach.
 */
create or replace function platform_auth.money_payable(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows     jsonb;
  v_accounts int  := 0;
  v_drift    int  := 0;
  v_bad      int  := 0;
  v_held     jsonb;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('rows', '[]'::jsonb, 'accounts', 0, 'drift', 0,
      'disagrees', 0, 'square', false, 'held', '[]'::jsonb,
      'error', 'Only the office''s own book carries these lines.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'account', x.code, 'label', x.label, 'kind', x.kind, 'currency', x.currency,
           'what', x.what, 'book', x.book, 'cached', x.cached,
           'drift', x.book - x.cached, 'papers', x.papers, 'papers_n', x.papers_n,
           'disagrees', case when x.papers is null then null
                             else x.book <> x.papers end)
         order by x.code), '[]'::jsonb),
         count(*)::int,
         count(*) filter (where x.book <> x.cached)::int,
         count(*) filter (where x.papers is not null and x.book <> x.papers)::int
    into v_rows, v_accounts, v_drift, v_bad
    from (
      select a.code, a.label, a.kind, a.currency,
             'money parked against a job' as what,
             coalesce((select sum(case when e.direction = 'credit' then e.amount
                                       else -e.amount end)
                         from money_entries e where e.account_id = a.id), 0)::numeric(14,2) as book,
             (a.credit_total - a.debit_total)::numeric(14,2) as cached,
             coalesce((select sum(h.amount)::numeric(14,2) from money_escrow_holds h
                        where h.into_account_id = a.id
                          and h.status in ('held','pending_discharge')), 0) as papers,
             coalesce((select count(*)::int from money_escrow_holds h
                        where h.into_account_id = a.id
                          and h.status in ('held','pending_discharge')), 0) as papers_n
        from money_accounts a
       where a.tenant_id = p_tenant and a.code like 'ESCROW%'

       union all

       select a.code, a.label, a.kind, a.currency,
             'money agreed out and not yet paid' as what,
             coalesce((select sum(case when e.direction = 'credit' then e.amount
                                       else -e.amount end)
                         from money_entries e where e.account_id = a.id), 0)::numeric(14,2) as book,
             (a.credit_total - a.debit_total)::numeric(14,2) as cached,
             coalesce((select sum(p.amount + p.fee_amount)::numeric(14,2) from money_payouts p
                        where p.payable_account_id = a.id and p.status = 'released'), 0) as papers,
             coalesce((select count(*)::int from money_payouts p
                        where p.payable_account_id = a.id and p.status = 'released'), 0) as papers_n
        from money_accounts a
       where a.tenant_id = p_tenant
         and a.code in ('PAYOUT-DUE','REFUND-DUE','PAYOUT-DUE-USD','REFUND-DUE-USD')

       union all

       select a.code, a.label, a.kind, a.currency,
             'a holder''s balance' as what,
             coalesce((select sum(case when e.direction = 'credit' then e.amount
                                       else -e.amount end)
                         from money_entries e where e.account_id = a.id), 0)::numeric(14,2) as book,
             (a.credit_total - a.debit_total)::numeric(14,2) as cached,
             null::numeric as papers,
             0 as papers_n
        from money_accounts a
        join money_wallets w on w.account_id = a.id
       where a.tenant_id = p_tenant and a.code like 'WLT-%'
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', g.currency, 'wallets', g.wallets, 'held', g.held
         ) order by g.currency), '[]'::jsonb) into v_held
    from (
      select w.currency, count(*)::int as wallets,
             coalesce(sum(b.balance), 0)::numeric(14,2) as held
        from money_wallets w
       cross join lateral (select platform_auth.money_wallet_balance(w.id) as balance) b
       where w.tenant_id = p_tenant
       group by w.currency
    ) g;

  return jsonb_build_object('rows', v_rows, 'accounts', v_accounts, 'drift', v_drift,
                            'disagrees', v_bad, 'held', v_held,
                            'square', v_drift = 0 and v_bad = 0,
                            'bound', p_tenant);
end $$;

/**
 * Who the office can pay, read out of the three registers it keeps a person in.
 *
 * `payout_names_its_payee` takes the name off a row, so a desk that types an uuid off a printed sheet
 * can raise a paper the trigger then refuses with `the office has no driver …`. This is the read that
 * lets the desk pick instead of guess, and it answers the two doors' own rules rather than a third
 * one invented here: a payout may be aimed at any row that exists — including a company that has since
 * closed, because the refund it is owed is exactly the paper a desk raises after a shutdown — while a
 * wallet is only opened for a live transporter or shipper (`open_money_wallet` refuses every other
 * owner). `can_wallet` is that second rule, printed so the wallet form cannot offer a holder the book
 * is going to refuse.
 *
 * No phone, no NIDA, no account line, no hash. A payee is chosen on a name and the company it belongs
 * to; the number the money travels on is typed once, by the seat that has it, onto the paper that
 * carries it, and is encrypted on the way in.
 */
create or replace function platform_auth.money_payees(
  p_tenant uuid, p_kind text, p_search text, p_limit int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rows     jsonb;
  v_matched  int := 0;
  v_returned int := 0;
  v_kind     text := lower(trim(coalesce(nullif(trim(p_kind), ''), 'company')));
  v_search   text := nullif(trim(coalesce(p_search, '')), '');
  v_limit    int := least(greatest(coalesce(p_limit, 25), 1), 50);
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('rows', '[]'::jsonb, 'kind', v_kind, 'count', 0, 'returned', 0,
      'error', 'Only the office that keeps the book looks for somebody to pay.');
  end if;
  if v_kind not in ('company','driver','staff') then
    return jsonb_build_object('rows', '[]'::jsonb, 'kind', v_kind, 'count', 0, 'returned', 0,
      'error', 'The office pays a company, a driver or a staff member it has a paper for, or '
        || 'somebody it names itself.');
  end if;
  if v_search is not null and char_length(v_search) < 2 then
    return jsonb_build_object('rows', '[]'::jsonb, 'kind', v_kind, 'count', 0, 'returned', 0,
      'error', 'Two characters at least — a one-letter name search is a list of everybody.');
  end if;

  -- `matched` is counted before the cut, so a desk that types two letters of a common name is told
  -- there are more people than it was shown and can type further; a board that only ever returned a
  -- page would read as "these are the only three Kilians the office has".
  if v_kind = 'company' then
    select coalesce(jsonb_agg(x.row_json order by x.name, x.id), '[]'::jsonb),
           count(*)::int, max(x.matched)::int
      into v_rows, v_returned, v_matched
      from (
        select t.name as name, t.id as id, count(*) over () as matched, jsonb_build_object(
          'kind', 'company', 'id', t.id, 'name', t.name, 'company', t.name,
          'company_tenant_id', t.id,
          'detail', t.type || ' · ' || t.status
                    || (case when t.deleted_at is not null then ' · deleted' else '' end),
          'status', t.status, 'archived', t.deleted_at is not null,
          'can_pay', true,
          'can_wallet', t.deleted_at is null and t.type in ('transporter','shipper')
        ) as row_json
        from tenants t
        where t.type <> 'platform'
          and (v_search is null or t.name ilike '%' || v_search || '%')
        order by t.name limit v_limit
      ) x;
  elsif v_kind = 'driver' then
    select coalesce(jsonb_agg(x.row_json order by x.name, x.id), '[]'::jsonb),
           count(*)::int, max(x.matched)::int
      into v_rows, v_returned, v_matched
      from (
        select d.full_name as name, d.id as id, count(*) over () as matched, jsonb_build_object(
          'kind', 'driver', 'id', d.id, 'name', d.full_name, 'company', t.name,
          'company_tenant_id', d.tenant_id,
          'detail', d.status || ' · ' || t.name
                    || (case when d.deleted_at is not null then ' · deleted' else '' end),
          'status', d.status, 'archived', d.deleted_at is not null,
          'can_pay', true, 'can_wallet', false
        ) as row_json
        from drivers d join tenants t on t.id = d.tenant_id
        where t.type <> 'platform'
          and (v_search is null or d.full_name ilike '%' || v_search || '%'
                              or t.name ilike '%' || v_search || '%')
        order by d.full_name limit v_limit
      ) x;
  else
    select coalesce(jsonb_agg(x.row_json order by x.name, x.id), '[]'::jsonb),
           count(*)::int, max(x.matched)::int
      into v_rows, v_returned, v_matched
      from (
        select e.full_name as name, e.id as id, count(*) over () as matched, jsonb_build_object(
          'kind', 'staff', 'id', e.id, 'name', e.full_name, 'company', t.name,
          'company_tenant_id', e.tenant_id,
          'detail', coalesce(nullif(trim(e.job_title), ''), 'staff') || ' · ' || e.status
                    || ' · ' || t.name
                    || (case when e.deleted_at is not null then ' · deleted' else '' end),
          'status', e.status, 'archived', e.deleted_at is not null,
          'can_pay', true, 'can_wallet', false
        ) as row_json
        from employees e join tenants t on t.id = e.tenant_id
        where t.type <> 'platform'
          and (v_search is null or e.full_name ilike '%' || v_search || '%'
                              or t.name ilike '%' || v_search || '%')
        order by e.full_name limit v_limit
      ) x;
  end if;

  return jsonb_build_object('rows', coalesce(v_rows, '[]'::jsonb), 'kind', v_kind,
    'count', coalesce(v_matched, 0), 'returned', v_returned,
    'limit', v_limit, 'search', v_search);
end $$;

/**
 * Which job a hold waits on, read out of the four registers that can carry one.
 *
 * A desk parks money against a booking, a cargo file, a call or a dispute, and `raise_money_escrow`
 * takes the subject's id — so without this read the form asks a clerk to paste an uuid off a support
 * ticket, which nobody has and which the guard then refuses with a sentence about a row that does
 * not exist. `escrow_names_its_subject` is the authority on what a subject may be; this prints the
 * same four rules so the picker cannot offer a job the door will reject:
 *
 *   - a row that has been deleted is not a job, and the guard says so;
 *   - a booking whose route, cargo label and company name are all empty, or a cargo file whose
 *     consignee and description are, gets a null `subject_note` from the guard and is refused for not
 *     naming the job it waits on, so `can_hold` is false. A call's subject and a dispute's ground
 *     cannot be empty on their own registers, which is why those two are always holdable;
 *   - `ref` is built here exactly the way the guard builds it — the cargo file number, the ticket
 *     or dispute ref, and `BK-` plus the booking's id tail, because 048 gave a booking no number.
 *
 * No figure and no person's contact: a clerk choosing what to hold money against needs the job's own
 * reference and whose it is, and the money is typed next.
 */
create or replace function platform_auth.money_subjects(
  p_tenant uuid, p_kind text, p_search text, p_limit int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rows     jsonb;
  v_matched  int := 0;
  v_returned int := 0;
  v_kind     text := lower(trim(coalesce(nullif(trim(p_kind), ''), 'call')));
  v_search   text := nullif(trim(coalesce(p_search, '')), '');
  v_limit    int := least(greatest(coalesce(p_limit, 25), 1), 50);
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('rows', '[]'::jsonb, 'kind', v_kind, 'count', 0, 'returned', 0,
      'error', 'Only the office that keeps the book parks money against a job.');
  end if;
  if v_kind not in ('booking','cargo_file','call','dispute') then
    return jsonb_build_object('rows', '[]'::jsonb, 'kind', v_kind, 'count', 0, 'returned', 0,
      'error', 'A hold waits on a booking, a cargo file, a call or a dispute — the four the '
        || 'register lets a desk park money against.');
  end if;
  if v_search is not null and char_length(v_search) < 2 then
    return jsonb_build_object('rows', '[]'::jsonb, 'kind', v_kind, 'count', 0, 'returned', 0,
      'error', 'Two characters at least — a one-letter job search is a list of every job the office '
        || 'has ever had.');
  end if;

  if v_kind = 'booking' then
    select coalesce(jsonb_agg(x.row_json order by x.sort_at desc, x.ref), '[]'::jsonb),
           count(*)::int, max(x.matched)::int
      into v_rows, v_returned, v_matched
      from (
        select b.created_at as sort_at, 'BK-' || upper(left(b.id::text, 8)) as ref,
               count(*) over () as matched, jsonb_build_object(
          'kind', 'booking', 'id', b.id,
          'ref', 'BK-' || upper(left(b.id::text, 8)),
          'what', left(concat_ws(' · ', nullif(trim(coalesce(b.route_label, '')), ''),
                                 nullif(trim(coalesce(b.cargo_label, '')), ''),
                                 nullif(trim(coalesce(b.company_name, '')), '')), 200),
          'company', b.company_name, 'company_tenant_id', b.tenant_id,
          'status', b.status, 'created_at', b.created_at,
          'can_hold', nullif(trim(coalesce(b.route_label, '')), '') is not null
                      or nullif(trim(coalesce(b.cargo_label, '')), '') is not null
                      or nullif(trim(coalesce(b.company_name, '')), '') is not null
        ) as row_json
        from transport_bookings b
        where b.deleted_at is null
          and (v_search is null
               or 'BK-' || upper(left(b.id::text, 8)) ilike '%' || v_search || '%'
               or coalesce(b.route_label, '') ilike '%' || v_search || '%'
               or coalesce(b.cargo_label, '') ilike '%' || v_search || '%'
               or coalesce(b.company_name, '') ilike '%' || v_search || '%')
        order by b.created_at desc limit v_limit
      ) x;
  elsif v_kind = 'cargo_file' then
    select coalesce(jsonb_agg(x.row_json order by x.sort_at desc, x.ref), '[]'::jsonb),
           count(*)::int, max(x.matched)::int
      into v_rows, v_returned, v_matched
      from (
        select c.created_at as sort_at, c.file_number as ref,
               count(*) over () as matched, jsonb_build_object(
          'kind', 'cargo_file', 'id', c.id, 'ref', c.file_number,
          'what', left(concat_ws(' · ', nullif(trim(coalesce(c.consignee_name, '')), ''),
                                 nullif(trim(coalesce(c.cargo_description, '')), '')), 200),
          'company', c.consignee_name, 'company_tenant_id', c.tenant_id,
          'status', c.shipment_type || (case when c.completed_at is not null
                                             then ' · completed' else '' end),
          'created_at', c.created_at,
          'can_hold', nullif(trim(coalesce(c.consignee_name, '')), '') is not null
                      or nullif(trim(coalesce(c.cargo_description, '')), '') is not null
        ) as row_json
        from cargo_shipments c
        where c.deleted_at is null
          and (v_search is null
               or c.file_number ilike '%' || v_search || '%'
               or coalesce(c.consignee_name, '') ilike '%' || v_search || '%'
               or coalesce(c.cargo_description, '') ilike '%' || v_search || '%')
        order by c.created_at desc limit v_limit
      ) x;
  elsif v_kind = 'call' then
    select coalesce(jsonb_agg(x.row_json order by x.sort_at desc, x.ref), '[]'::jsonb),
           count(*)::int, max(x.matched)::int
      into v_rows, v_returned, v_matched
      from (
        select k.created_at as sort_at, k.ref as ref,
               count(*) over () as matched, jsonb_build_object(
          'kind', 'call', 'id', k.id, 'ref', k.ref,
          'what', left(concat_ws(' · ', nullif(trim(coalesce(k.subject, '')), ''),
                                 nullif(trim(coalesce(k.company_name, '')), '')), 200),
          'company', k.company_name, 'company_tenant_id', k.company_tenant_id,
          'status', k.status, 'created_at', k.created_at, 'can_hold', true
        ) as row_json
        from support_tickets k
        where k.deleted_at is null
          and (v_search is null
               or k.ref ilike '%' || v_search || '%'
               or coalesce(k.subject, '') ilike '%' || v_search || '%'
               or coalesce(k.company_name, '') ilike '%' || v_search || '%')
        order by k.created_at desc limit v_limit
      ) x;
  else
    select coalesce(jsonb_agg(x.row_json order by x.sort_at desc, x.ref), '[]'::jsonb),
           count(*)::int, max(x.matched)::int
      into v_rows, v_returned, v_matched
      from (
        select f.created_at as sort_at, f.ref as ref,
               count(*) over () as matched, jsonb_build_object(
          'kind', 'dispute', 'id', f.id, 'ref', f.ref,
          'what', left(concat_ws(' · ', nullif(trim(coalesce(f.ground, '')), ''),
                                 nullif(trim(coalesce(f.claim, '')), '')), 200),
          'company', coalesce(nullif(trim(coalesce(f.company_name, '')), ''),
                              (select t.name from tenants t where t.id = f.company_tenant_id)),
          'company_tenant_id', f.company_tenant_id,
          'status', f.status, 'created_at', f.created_at, 'can_hold', true
        ) as row_json
        from service_disputes f
        where f.deleted_at is null
          and (v_search is null
               or f.ref ilike '%' || v_search || '%'
               or coalesce(f.ground, '') ilike '%' || v_search || '%'
               or coalesce(f.claim, '') ilike '%' || v_search || '%'
               or coalesce(f.company_name, '') ilike '%' || v_search || '%')
        order by f.created_at desc limit v_limit
      ) x;
  end if;

  return jsonb_build_object('rows', coalesce(v_rows, '[]'::jsonb), 'kind', v_kind,
    'count', coalesce(v_matched, 0), 'returned', v_returned,
    'limit', v_limit, 'search', v_search);
end $$;

-- ============================================================
-- 9. the duties
-- ============================================================

-- Putting money somewhere and stopping money from moving are different jobs from writing in the book,
-- and 133's three keys deliberately do not cover them: `control.money.post` lets a seat post a
-- movement, and a payout is a movement plus a payee plus a rail that a person's account number is
-- written onto. Asking for a signature and spending one still cost 126's keys — `control.payments.
-- manage` to propose and `control.approvals.decide` to decide — and no new key is invented for that
-- here either.
insert into permissions (key, description) values
  ('control.money.pay',
   'Control - Open and fund a wallet, raise a payout and settle one that left the office'),
  ('control.money.escrow',
   'Control - Hold money against a job, plan its discharge and stop or restart a wallet'),
  ('control.money.reveal',
   'Control - Open a payout''s payee line to read the whole account number back to a caller')
on conflict do nothing;

-- A wallet is opened and a payout is raised by the seats that settle money; a hold is raised by the
-- seats that adjudicate a job, and one of those is not the other. The office's own analyst reads the
-- book and is given none of these.
insert into role_permissions (role_id, permission_key)
select r.id, 'control.money.pay'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','billing_admin','finance_officer')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.money.escrow'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','finance_officer','compliance_officer')
on conflict do nothing;

-- Revealing an account number is the narrowest of the three and the easiest to do for the wrong
-- reason, so it is a key of its own rather than a line inside `control.money.pay`: a seat that raises
-- payouts all day has no standing to read a stranger's bank account out loud.
insert into role_permissions (role_id, permission_key)
select r.id, 'control.money.reveal'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','finance_officer')
on conflict do nothing;

-- ============================================================
-- 10. grants on the doors
-- ============================================================

-- The trigger bodies are fired, never called, and the eight helpers below them are internal to this
-- file: a desk that could call `money_inflow_account` or `money_audit` directly could write an audit
-- row with no actor and name a liability line the doors do not use.
revoke all on function
  platform_auth.money_wallet_holder_is_a_company(),
  platform_auth.money_wallet_owns_its_line(),
  platform_auth.money_wallet_identity_is_kept(),
  platform_auth.escrow_names_its_subject(),
  platform_auth.escrow_wallets_hold_the_same_money(),
  platform_auth.escrow_plan_is_kept(),
  platform_auth.escrow_needs_two_seats(),
  platform_auth.escrow_is_not_deleted(),
  platform_auth.payout_names_its_payee(),
  platform_auth.payout_line_fits_its_rail(),
  platform_auth.payout_source_is_a_real_paper(),
  platform_auth.payout_accounts_are_honest(),
  platform_auth.payout_line_fits_its_batch(),
  platform_auth.payout_frozen_after_signature(),
  platform_auth.payout_needs_two_seats(),
  platform_auth.payout_is_not_deleted(),
  platform_auth.payout_batch_figures_are_kept(),
  platform_auth.payout_batch_is_not_deleted(),
  platform_auth.money_figure(numeric),
  platform_auth.money_move_is_the_office(uuid),
  platform_auth.money_leg(uuid, text, numeric, text),
  platform_auth.money_audit(uuid, uuid, text, text, text, text, uuid, text, jsonb, jsonb),
  platform_auth.money_wallet_balance(uuid),
  platform_auth.money_inflow_account(uuid, text, text),
  platform_auth.money_payout_accounts(uuid, text, text, text, uuid),
  platform_auth.money_approval(uuid)
from public, anon, authenticated, app_runtime, service_role;

-- Eighteen doors and twelve reads. A seat never INSERTs into a wallet, a hold, a batch or a payout: it
-- asks one of these, and the door is where the book is told as well as the paper.
grant execute on function
  platform_auth.open_money_wallet(uuid, uuid, text, text, uuid, text, text, text),
  platform_auth.fund_money_wallet(uuid, uuid, numeric, text, text, date, uuid, text, text, text, text),
  platform_auth.move_money_wallet(uuid, uuid, uuid, numeric, text, date, uuid, text, text, text, text),
  platform_auth.freeze_money_wallet(uuid, uuid, text, uuid, boolean, text, text, text),
  platform_auth.raise_money_escrow(uuid, text, uuid, numeric, text, uuid, text, text, text, date,
                                   uuid, text, text, text, text),
  platform_auth.propose_escrow_discharge(uuid, uuid, text, numeric, numeric, numeric, uuid, text,
                                         uuid, text, text, text),
  platform_auth.refuse_escrow_discharge(uuid, uuid, text, uuid, text, text, text),
  platform_auth.apply_escrow_discharge(uuid, uuid, text, text),
  platform_auth.raise_money_payout(uuid, text, uuid, text, text, bytea, text, text, numeric, numeric,
                                   text, text, uuid, text, text, uuid, uuid, text, text, text),
  platform_auth.open_money_payout_batch(uuid, text, text, uuid, text, text, text),
  platform_auth.propose_money_payout(uuid, uuid, text, uuid, text, text, text),
  platform_auth.propose_money_payout_batch(uuid, uuid, text, uuid, text, text, text),
  platform_auth.decline_money_payout(uuid, uuid, text, uuid, text, text, text),
  platform_auth.decline_money_payout_batch(uuid, uuid, text, uuid, text, text, text),
  platform_auth.apply_payout_release(uuid, uuid, text, text),
  platform_auth.mark_money_payout_paid(uuid, uuid, text, date, uuid, text, text, text),
  platform_auth.mark_money_payout_failed(uuid, uuid, text, uuid, text, text, text),
  platform_auth.close_money_payout_batch(uuid, uuid, text, uuid, text, text, text),
  platform_auth.money_rails(uuid),
  platform_auth.money_wallet_board(uuid, text, text, text, int, int),
  platform_auth.money_wallet_detail(uuid, uuid),
  platform_auth.money_escrow_board(uuid, text, text, text, int, int),
  platform_auth.money_escrow_detail(uuid, uuid),
  platform_auth.money_payout_board(uuid, text, text, text, text, text, text, int, int),
  platform_auth.money_payout_detail(uuid, uuid),
  platform_auth.money_payout_batch_board(uuid, text, text, text, int, int),
  platform_auth.money_payout_batch_detail(uuid, uuid),
  platform_auth.money_payable(uuid),
  platform_auth.money_payees(uuid, text, text, int),
  platform_auth.money_subjects(uuid, text, text, int)
to app_runtime;

-- `create or replace function` hands EXECUTE back to PUBLIC, so every door is revoked after it is
-- granted — 114's sweep, 121, 126, 129, 131 and 133 all list this and none of them trust the order.
revoke all on function
  platform_auth.open_money_wallet(uuid, uuid, text, text, uuid, text, text, text),
  platform_auth.fund_money_wallet(uuid, uuid, numeric, text, text, date, uuid, text, text, text, text),
  platform_auth.move_money_wallet(uuid, uuid, uuid, numeric, text, date, uuid, text, text, text, text),
  platform_auth.freeze_money_wallet(uuid, uuid, text, uuid, boolean, text, text, text),
  platform_auth.raise_money_escrow(uuid, text, uuid, numeric, text, uuid, text, text, text, date,
                                   uuid, text, text, text, text),
  platform_auth.propose_escrow_discharge(uuid, uuid, text, numeric, numeric, numeric, uuid, text,
                                         uuid, text, text, text),
  platform_auth.refuse_escrow_discharge(uuid, uuid, text, uuid, text, text, text),
  platform_auth.apply_escrow_discharge(uuid, uuid, text, text),
  platform_auth.raise_money_payout(uuid, text, uuid, text, text, bytea, text, text, numeric, numeric,
                                   text, text, uuid, text, text, uuid, uuid, text, text, text),
  platform_auth.open_money_payout_batch(uuid, text, text, uuid, text, text, text),
  platform_auth.propose_money_payout(uuid, uuid, text, uuid, text, text, text),
  platform_auth.propose_money_payout_batch(uuid, uuid, text, uuid, text, text, text),
  platform_auth.decline_money_payout(uuid, uuid, text, uuid, text, text, text),
  platform_auth.decline_money_payout_batch(uuid, uuid, text, uuid, text, text, text),
  platform_auth.apply_payout_release(uuid, uuid, text, text),
  platform_auth.mark_money_payout_paid(uuid, uuid, text, date, uuid, text, text, text),
  platform_auth.mark_money_payout_failed(uuid, uuid, text, uuid, text, text, text),
  platform_auth.close_money_payout_batch(uuid, uuid, text, uuid, text, text, text),
  platform_auth.money_rails(uuid),
  platform_auth.money_wallet_board(uuid, text, text, text, int, int),
  platform_auth.money_wallet_detail(uuid, uuid),
  platform_auth.money_escrow_board(uuid, text, text, text, int, int),
  platform_auth.money_escrow_detail(uuid, uuid),
  platform_auth.money_payout_board(uuid, text, text, text, text, text, text, int, int),
  platform_auth.money_payout_detail(uuid, uuid),
  platform_auth.money_payout_batch_board(uuid, text, text, text, int, int),
  platform_auth.money_payout_batch_detail(uuid, uuid),
  platform_auth.money_payable(uuid),
  platform_auth.money_payees(uuid, text, text, int),
  platform_auth.money_subjects(uuid, text, text, int)
from public, anon, authenticated, service_role;

-- The three numbers a paper is minted from. A sequence left granted to PUBLIC is a way for any
-- client role to burn a payout ref it will never use: the register would not gain a row, but it would
-- gain a hole in the numbering, and a ref that skips is a ref an office has to explain to somebody.
revoke all on sequence escrow_hold_number_seq, payout_batch_number_seq, payout_number_seq
  from public, anon, authenticated, app_runtime, service_role;

-- ============================================================
-- 11. say what this leaves the office in
-- ============================================================

do $$ declare
  v_rails     int;
  v_retired   int;
  v_usd       int;
  v_wrongkind int;
  v_papers    int;
  v_triggers  int;
  v_tables    int;
  v_writers   int;
  v_public    int;
  v_readers   int;
  v_missing   int;
  v_private   int;
  v_leaks     int;
  v_unswept   int;
  v_burners   int;
  v_duties    int;
  v_seats     int;
  v_doors     text[] := array[
    'open_money_wallet', 'fund_money_wallet', 'move_money_wallet', 'freeze_money_wallet',
    'raise_money_escrow', 'propose_escrow_discharge', 'refuse_escrow_discharge',
    'apply_escrow_discharge', 'raise_money_payout', 'open_money_payout_batch',
    'propose_money_payout', 'propose_money_payout_batch', 'decline_money_payout',
    'decline_money_payout_batch', 'apply_payout_release', 'mark_money_payout_paid',
    'mark_money_payout_failed', 'close_money_payout_batch',
    'money_rails', 'money_wallet_board', 'money_wallet_detail', 'money_escrow_board',
    'money_escrow_detail', 'money_payout_board', 'money_payout_detail',
    'money_payout_batch_board', 'money_payout_batch_detail', 'money_payable', 'money_payees',
    'money_subjects'];
  v_internal  text[] := array[
    'money_wallet_holder_is_a_company', 'money_wallet_owns_its_line',
    'money_wallet_identity_is_kept', 'escrow_names_its_subject',
    'escrow_wallets_hold_the_same_money', 'escrow_plan_is_kept', 'escrow_needs_two_seats',
    'escrow_is_not_deleted', 'payout_names_its_payee', 'payout_line_fits_its_rail',
    'payout_source_is_a_real_paper', 'payout_accounts_are_honest', 'payout_line_fits_its_batch',
    'payout_frozen_after_signature', 'payout_needs_two_seats', 'payout_is_not_deleted',
    'payout_batch_figures_are_kept', 'payout_batch_is_not_deleted',
    'money_figure', 'money_move_is_the_office', 'money_leg', 'money_audit',
    'money_wallet_balance', 'money_inflow_account', 'money_payout_accounts', 'money_approval'];
  v_walls     text[] := array['money_payout_rails', 'money_wallets', 'money_escrow_holds',
                              'money_payout_batches', 'money_payouts'];
begin
  -- The rails are the whole vocabulary a payout can be written in, and this file is their only
  -- author. Six, none of them retired, with a cash rail that needs no line and two families that
  -- do: a desk that cannot name the rail cannot be refused for the shape of the number it typed.
  select count(*)::int into v_rails from money_payout_rails;
  select count(*)::int into v_retired from money_payout_rails where retired;
  if v_rails <> 6 or v_retired <> 0 then
    raise exception '134: the payout rails came to % row(s) of which % retired — this file seeds '
      'six and retires none', v_rails, v_retired;
  end if;
  if (select count(*)::int from money_payout_rails where needs = 'none') <> 1 then
    raise exception '134: exactly one rail may pay without a number, and it is the desk''s cash';
  end if;

  -- 133's book is TZS-only apart from OPS-USD. A USD wallet, hold or payout would have no line to
  -- point at and 133's own leg trigger would refuse it, so these six are not a convenience: without
  -- them the second money is a promise the desk cannot keep.
  select count(*)::int into v_usd
    from money_accounts
   where currency = 'USD'
     and code in ('WALLET-USD','ESCROW-USD','PAYOUT-DUE-USD','REFUND-DUE-USD',
                  'FEE-INCOME-USD','COST-OPS-USD','OPS-USD');
  if v_usd <> 7 then
    raise exception '134: the USD chart came to % line(s) of the 7 a second money needs', v_usd;
  end if;

  -- The one correction to 133's chart, asserted rather than assumed: company money held by the office
  -- is what the office owes, not what it owns. An account with legs would have made this a rewrite of
  -- history, and §6 only touches it while it is empty.
  select count(*)::int into v_wrongkind
    from money_accounts where code = 'WALLET-TZS' and kind <> 'liability';
  if v_wrongkind <> 0 then
    raise exception '134: WALLET-TZS is still filed as an asset — the office does not own the money '
      'it holds for a company';
  end if;

  -- Four registers, no papers: this file opens the desks, it does not fill them. A wallet, hold or
  -- payout that exists before the first seat signs in is a row somebody wrote by hand.
  select (select count(*)::int from money_wallets)
       + (select count(*)::int from money_escrow_holds)
       + (select count(*)::int from money_payout_batches)
       + (select count(*)::int from money_payouts) into v_papers;
  if v_papers <> 0 then
    raise exception '134: the new registers already hold % paper(s), and only 134''s doors may '
      'write them', v_papers;
  end if;

  -- Eighteen guards. None of them is deferrable: 133's balance rule is deferred because a posting is
  -- half a movement until its last leg lands, but a payout that names a rail it cannot travel by is
  -- wrong before the row exists. A guard that became deferrable would let a signed paper through and
  -- refuse it at commit — after the signature had already been spent.
  select count(*)::int into v_triggers
    from pg_trigger
   where tgname in ('money_wallets_name_their_holder', 'money_wallets_own_their_lines',
                    'money_wallets_keep_their_identity', 'money_escrow_names_its_job',
                    'money_escrow_wallets_match', 'money_escrow_plan_kept',
                    'money_escrow_holds_two_seats', 'money_escrow_holds_are_kept',
                    'money_payouts_name_their_payee', 'money_payouts_fit_their_rails',
                    'money_payouts_stand_on_real_papers', 'money_payouts_name_honest_lines',
                    'money_payouts_fit_their_batches', 'money_payouts_keep_their_signed_figure',
                    'money_payouts_two_seats', 'money_payouts_are_kept',
                    'money_payout_batches_keep_their_totals', 'money_payout_batches_are_kept')
     and not tgisinternal and tgenabled = 'O' and not tgdeferrable;
  if v_triggers <> 18 then
    raise exception '134: % of the 18 guards are live, enabled and immediate', v_triggers;
  end if;

  -- The five registers are read-only for every client role. A desk that could INSERT a payout would
  -- be a desk that could name a payee nobody signed, aim money at an account nobody derived, and
  -- leave `accrual_posting_id` NULL — a paper that owes the book nothing.
  select coalesce(count(*)::int, 0) into v_writers
    from pg_class c cross join aclexplode(c.relacl) a
   where c.relkind = 'r' and c.relname = any (v_walls)
     and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
     and a.grantee <> 0 and a.grantee <> c.relowner;
  if v_writers <> 0 then
    raise exception '134: % non-owner role(s) hold a write grant on the new registers', v_writers;
  end if;
  select coalesce(count(*)::int, 0) into v_public
    from pg_class c cross join aclexplode(c.relacl) a
   where c.relname = any (v_walls) and a.grantee = 0;
  if v_public <> 0 then
    raise exception '134: PUBLIC still holds % privilege line(s) on 134''s tables', v_public;
  end if;
  select coalesce(count(*)::int, 0) into v_readers
    from pg_class c cross join aclexplode(c.relacl) a
   where c.relname = any (v_walls) and a.privilege_type = 'SELECT'
     and a.grantee = (select oid from pg_roles where rolname = 'app_runtime');
  if v_readers <> 5 then
    raise exception '134: the app role reads % of the five registers — the boards are RLS-bound and '
      'must read all of them', v_readers;
  end if;
  if (select count(*)::int from pg_class where relkind = 'r' and relname = any (v_walls)
        and relrowsecurity) <> 5 then
    raise exception '134: one of the five registers came up without row-level security on';
  end if;
  select count(*)::int into v_tables from pg_class where relkind = 'r' and relname = any (v_walls);
  if v_tables <> 5 then
    raise exception '134: % of 134''s five tables exist', v_tables;
  end if;

  -- Every door answers the app role and no client role, and every internal body answers nobody.
  -- `has_function_privilege` is asked rather than the ACL rows because it also resolves the default
  -- EXECUTE that PUBLIC holds until a migration takes it away: a door whose ACL is still NULL was
  -- never swept, and that is a leak with a clean-looking grant table.
  select count(*)::int into v_missing
    from unnest(v_doors) d(fn)
   where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'platform_auth' and p.proname = d.fn
                        and has_function_privilege('app_runtime', p.oid, 'EXECUTE'));
  if v_missing <> 0 then
    raise exception '134: % of the 30 doors are not executable by the app role', v_missing;
  end if;
  select count(*)::int into v_unswept
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth'
     and p.proname = any (v_doors || v_internal) and p.proacl is null;
  select count(*)::int into v_private
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth' and p.proname = any (v_internal)
     and has_function_privilege('app_runtime', p.oid, 'EXECUTE');
  if v_private <> 0 then
    raise exception '134: % of 134''s 18 guards and 8 helpers still answer a caller — a body that '
      'writes an audit row or names a liability line must not be a door', v_private;
  end if;
  select count(*)::int into v_leaks
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth'
     and p.proname = any (v_doors || v_internal)
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE')
          or has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if v_leaks <> 0 or v_unswept <> 0 then
    raise exception '134: % door(s) answer a client role and % still carry the default grantable ACL',
      v_leaks, v_unswept;
  end if;

  -- Nobody outside the doors may mint a number.
  select count(*)::int into v_burners
    from unnest(array['escrow_hold_number_seq','payout_batch_number_seq','payout_number_seq']) s(sq)
   where has_sequence_privilege('app_runtime', s.sq, 'USAGE')
      or has_sequence_privilege('authenticated', s.sq, 'USAGE');
  if v_burners <> 0 then
    raise exception '134: % sequence(s) can still be advanced by a client role', v_burners;
  end if;

  -- Three duties, held by the seats that need them and by nobody else. `control.money.reveal` is
  -- narrow on purpose: it is the key that opens a person's bank account.
  select count(*)::int into v_duties from permissions
   where key in ('control.money.pay', 'control.money.escrow', 'control.money.reveal');
  if v_duties <> 3 then
    raise exception '134: % of the three money duties are registered', v_duties;
  end if;
  select count(*)::int into v_seats
    from role_permissions rp join roles r on r.id = rp.role_id
   where r.tenant_id is null
     and ((r.key in ('super_admin','billing_admin','finance_officer')
           and rp.permission_key = 'control.money.pay')
       or (r.key in ('super_admin','finance_officer','compliance_officer')
           and rp.permission_key = 'control.money.escrow')
       or (r.key in ('super_admin','finance_officer')
           and rp.permission_key = 'control.money.reveal'));
  if v_seats <> 8 then
    raise exception '134: the three duties are held by % platform role line(s) instead of the 8 this '
      'file hands them out as', v_seats;
  end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id
              join permissions p on p.key = rp.permission_key
             where r.tenant_id is null and p.key like 'control.money.%'
               and r.key in ('platform_analyst', 'auditor')
               and p.key <> 'control.money.view') then
    raise exception '134: an analyst or an auditor was handed a pen on the money desks; they read, '
      'they do not pay';
  end if;

  raise notice '134: the office can now hold, park and pay — % rails, % USD chart line(s), the '
    'registers empty of paper, 18 guards live, 30 doors swept and 3 duties out', v_rails, v_usd;
end $$;

commit;
