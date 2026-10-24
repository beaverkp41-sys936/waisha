-- 133: The book that balances itself.
--
-- 126 wrote the refund paper and said, in its own header, that it is not the ledger: "the double-entry
-- book will add the paid state and settle against this row". Half of the office's money already has a
-- register — 005's payments and invoices, 029's freight invoices, 031's expenses, 052's quotations,
-- 072's payroll, 090's tax returns, 094's trip pay, 126's refunds — and every one of them stores a
-- figure on the thing it belongs to. That is how a company ends up owing an amount nobody can name a
-- source for: `ledger.routes.ts` is called the ledger and reads two tables and edits `amount_paid`
-- in place, so the office cannot answer "where did this money come from and where did it go" at all,
-- and `api/src/billing/reconcile.ts` has nothing to reconcile against.
--
-- This is the book those registers settle into. The rule it exists to hold is the one rule double
-- entry has: a movement is recorded as at least two legs, the debits equal the credits, and the
-- equality is not a promise the writer makes but a fact the database checks when the transaction
-- commits. So:
--
--   * `money_accounts` — whose book, what the account is (asset / liability / equity / income /
--                        expense), one currency per account, and a freeze that cannot be opened
--                        without the sentence that explains it. A frozen account takes no leg.
--   * `money_postings`  — one movement: the day it belongs to, the words on it, one currency for the
--                        whole posting, the figure it moved (copied by trigger from its own legs, so a
--                        register read does not have to walk them), who raised it, and an
--                        idempotency key unique per book — the shape 098 gave `payments`, which is how
--                        a retried request is answered with the posting it already made rather than a
--                        second one.
--   * `money_entries`   — the legs. Append-only twice over: no DELETE/UPDATE grant to `app_runtime`,
--                        and a trigger that refuses an update or a delete whoever attempts it, the
--                        way 001 guards `audit_logs`. A wrong movement is not edited, it is answered
--                        by a mirror posting that points back at it.
--   * `platform_auth.posting_balances_at_commit()` — a DEFERRED constraint trigger, fired on the leg
--                        and on the header, that at commit time insists: two legs or more, both sides
--                        present, debits equal credits, and the header's figure equal to the debits.
--                        A posting that does not balance never becomes visible.
--   * cached totals on the account, kept by trigger and re-checked by `money_book()`, which returns
--                        the recomputed figure beside the cached one so the desk can say whether the
--                        book still agrees with itself instead of asserting that it does.
--
-- Money is `numeric(14,2)` with a positive CHECK, the house shape since 072 and 090 — never a float,
-- and the currency is a CHECKed constant in the pair the newest register uses (126: TZS, USD). The
-- chart is seeded empty of movement: nine accounts for the platform's own book and one in USD, with
-- no opening balance, because an opening figure is the office's to declare on the desk and this
-- migration has no business inventing one.
--
-- Deliberately NOT here: wallets, escrow holds and payouts. Each of those is a state machine that
-- must be signed by a second seat through 121's register, and bolting an unsigned one-seat money move
-- onto the book would put the weakest door on the strongest table. They come next, on top of this.
begin;

-- ============================================================
-- 1. the accounts: whose book, what it is, in what currency
-- ============================================================

create table if not exists money_accounts (
  id uuid primary key default gen_random_uuid(),
  -- The book's owner, exactly as 101/125/126 do it: for the office's own book this is the platform
  -- tenant, never the company. A company's book is a later row set, not a later column.
  tenant_id uuid not null references tenants(id),
  -- OPS-CASH, ESCROW-TZS. Uppercase because it is quoted on paper and read over a counter.
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  label text not null check (char_length(trim(label)) between 3 and 80),
  -- The five classical kinds. A desk that can only name a number cannot tell which side is up; the
  -- natural sign is derived from this, never typed.
  kind text not null check (kind in ('asset','liability','equity','income','expense')),
  currency text not null default 'TZS' check (currency in ('TZS','USD')),
  note text check (note is null or char_length(trim(note)) between 8 and 600),
  -- Frozen is not a colour on a chart. It carries its reason in the row, and the CHECK below makes
  -- the pair agree in both directions so a desk cannot open an account with a warning attached.
  status text not null default 'open' check (status in ('open','frozen')),
  frozen_reason text check (frozen_reason is null
                            or char_length(trim(frozen_reason)) between 8 and 600),
  -- The totals the register shows without walking every leg. `money_book()` recomputes them and
  -- prints the two side by side, so drift is a number on a screen rather than a rumour.
  debit_total numeric(14,2) not null default 0 check (debit_total >= 0),
  credit_total numeric(14,2) not null default 0 check (credit_total >= 0),
  entry_count int not null default 0 check (entry_count >= 0),
  last_posted_at timestamptz,
  opened_at timestamptz not null default now(),
  frozen_by uuid references users(id),
  frozen_at timestamptz,
  constraint money_accounts_code_per_book unique (tenant_id, code),
  constraint money_account_freeze_is_explained
    check ((status = 'frozen') = (frozen_reason is not null))
);

create index if not exists money_accounts_book_idx on money_accounts (tenant_id, kind, code);

alter table money_accounts enable row level security;

create policy money_accounts_tenant on money_accounts for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The book is read by the app role and written by the doors below: an account is opened by a named
-- act with a named actor, not by an INSERT that skips the reason.
grant select on money_accounts to app_runtime;
revoke all on money_accounts from public, anon, authenticated, service_role;

-- ============================================================
-- 2. the postings: one movement, one currency, one idempotency key
-- ============================================================

create sequence if not exists money_posting_number_seq;
grant usage, select on sequence money_posting_number_seq to app_runtime;

create table if not exists money_postings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- PST-2026-00001, minted from its own global sequence the way 126 mints RF- and DP-. A movement
  -- the office can be quoted about has to have a number a person can say out loud.
  ref text not null unique check (ref ~ '^PST-[0-9]{4}-[0-9]{5,}$'),
  -- The day the money moved, not the moment the row was written: a book is kept by day, and a
  -- posting filed on the wrong side of a month is a different month's answer.
  posted_on date not null,
  memo text not null check (char_length(trim(memo)) between 8 and 200),
  -- One currency for a whole posting. A mixed posting is where a book quietly stops balancing,
  -- because "the debits equal the credits" means nothing across two monies.
  currency text not null default 'TZS' check (currency in ('TZS','USD')),
  -- What the movement is standing for. `manual` and `adjustment` are the office's own pen; the rest
  -- name the registers that will settle into this book in the next stages, so a posting can always
  -- say whether a human typed it or a paper made it.
  source_kind text not null check (source_kind in (
    'opening','manual','adjustment','reversal',
    'invoice','payment','refund','payout','fee','escrow','cost','payroll','tax')),
  -- A pointer at the paper, not a foreign key: the papers live in a dozen tables and 129's erasure
  -- must not be able to reach a book row through one of them. It is kept because "which invoice?"
  -- is the first question asked of any posting.
  source_id uuid,
  source_ref text check (source_ref is null or char_length(trim(source_ref)) between 3 and 60),
  -- Copied by the door from its own legs, so the register prints a figure without a subquery per row.
  total numeric(14,2) not null check (total > 0 and total <= 10000000000),
  status text not null default 'posted' check (status in ('posted','reversed')),
  -- The movement that undoes this one, and the sentence that says why. A reversal is a posting, and
  -- a posting that has been reversed says so in its own row.
  reversed_by uuid references users(id),
  reversed_at timestamptz,
  reversal_note text check (reversal_note is null
                            or char_length(trim(reversal_note)) between 8 and 600),
  raised_by uuid not null references users(id),
  raised_at timestamptz not null default now(),
  -- 098's lesson, applied to the book: the key is unique per book, not globally, so two offices
  -- retrying with the same string do not answer for each other.
  idempotency_key text check (idempotency_key is null
                              or char_length(trim(idempotency_key)) between 8 and 140),
  constraint money_posting_reversal_is_explained
    check (status <> 'reversed' or (reversal_note is not null and reversed_by is not null))
);

create unique index if not exists money_postings_idempotency_per_book
  on money_postings (tenant_id, idempotency_key)
  where idempotency_key is not null;

-- The register is cut newest-first, so the index leads with the column the page is ordered by and
-- carries the day beside it: `where tenant_id = ? order by raised_at desc limit 60` walks this in
-- order and stops at the page. A day-only index could not have served it, which is why 133's first
-- draft had an index the desk's hottest read never touched.
create index if not exists money_postings_book_recent_idx
  on money_postings (tenant_id, raised_at desc, posted_on desc);

drop index if exists money_postings_book_day_idx;

alter table money_postings enable row level security;

create policy money_postings_tenant on money_postings for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select on money_postings to app_runtime;
revoke all on money_postings from public, anon, authenticated, service_role;

-- ============================================================
-- 3. the legs: the half of double entry that makes it double
-- ============================================================

create table if not exists money_entries (
  id uuid primary key default gen_random_uuid(),
  posting_id uuid not null references money_postings(id),
  tenant_id uuid not null references tenants(id),
  account_id uuid not null references money_accounts(id),
  -- Debit and credit are the two sides of a leg, not the sign of a number: every amount is positive
  -- and the direction says which way it went. 126's `pay_back = 'credit_note'` is a paper, not this
  -- column, and the two words never meet in a query.
  direction text not null check (direction in ('debit','credit')),
  amount numeric(14,2) not null check (amount > 0 and amount <= 10000000000),
  detail text check (detail is null or char_length(trim(detail)) between 3 and 200),
  created_at timestamptz not null default now()
);

-- Two reads ever ask for a leg: every leg of one movement (the register's side-line, the detail's
-- ledger, the mirror a reversal builds) and every leg of one account (the book's recomputed
-- balance). The book as a whole is aggregated, never walked in day order, so no third index on this
-- table is named by a query — and an index nothing reads is still paid for on every leg written.
create index if not exists money_entries_posting_idx on money_entries (posting_id);
create index if not exists money_entries_account_idx on money_entries (account_id, created_at);

drop index if exists money_entries_book_idx;

alter table money_entries enable row level security;

create policy money_entries_tenant on money_entries for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Read only. A leg is written by `record_money_posting` and by nothing else, and it is never edited.
grant select on money_entries to app_runtime;
revoke all on money_entries from public, anon, authenticated, service_role;

-- ============================================================
-- 4. append-only: a wrong movement is answered, not corrected
-- ============================================================

create or replace function platform_auth.prevent_money_entry_mutation() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_ref text;
begin
  -- A DELETE trigger has no NEW row, and naming one is a plpgsql error rather than a refusal — so
  -- the two halves are written out, and only the side that exists is read.
  v_ref := case when TG_OP = 'DELETE'
                then (select ref from money_postings where id = OLD.posting_id)
                else (select ref from money_postings where id = NEW.posting_id) end;
  raise exception '133: a money leg is never % — post a reversal against % and let the book carry both',
    case when TG_OP = 'DELETE' then 'erased' else 'rewritten' end,
    coalesce(v_ref, 'a posting that is gone');
end $$;

create trigger money_entries_are_kept
  before update or delete on money_entries
  for each row execute function platform_auth.prevent_money_entry_mutation();

-- The header may say one thing more than it could on the day it was written: that it has been
-- reversed. Every other column of a posted movement is frozen, and the row cannot go.
create or replace function platform_auth.money_posting_keeps_its_words() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'DELETE' then
    raise exception '133: posting % is deleted by nobody. Reverse it, and the book keeps both',
      OLD.ref;
  end if;
  if NEW.ref <> OLD.ref or NEW.posted_on <> OLD.posted_on or NEW.memo <> OLD.memo
     or NEW.currency <> OLD.currency or NEW.source_kind <> OLD.source_kind
     or NEW.total <> OLD.total or NEW.raised_by <> OLD.raised_by
     or NEW.raised_at <> OLD.raised_at then
    raise exception '133: posting % was written on % for % and stays that way. Only its reversal '
      'may be added', OLD.ref, OLD.posted_on, OLD.total;
  end if;
  if OLD.status = 'reversed' then
    raise exception '133: posting % is already reversed. A movement is undone once', OLD.ref;
  end if;
  return NEW;
end $$;

create trigger money_postings_keep_their_words
  before update or delete on money_postings
  for each row execute function platform_auth.money_posting_keeps_its_words();

-- ============================================================
-- 5. a leg belongs to the book, the currency and the day it stands in
-- ============================================================

create or replace function platform_auth.money_leg_names_its_own_book() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_posting record;
  v_account record;
begin
  select currency, tenant_id into v_posting from money_postings where id = NEW.posting_id;
  if not found then
    raise exception '133: a leg cannot stand on a posting that is not in the book';
  end if;
  if NEW.tenant_id <> v_posting.tenant_id then
    raise exception '133: that leg names a different book from the posting it stands on';
  end if;
  select tenant_id, code, label, currency, status, frozen_reason into v_account
    from money_accounts where id = NEW.account_id;
  if not found then
    raise exception '133: a leg cannot name an account that does not exist';
  end if;
  if v_account.tenant_id <> NEW.tenant_id then
    raise exception '133: account % is not in that book, so % cannot move money through it',
      v_account.code, NEW.direction;
  end if;
  -- A frozen account takes no leg in either direction. The reason is in the row, so the refusal can
  -- say it instead of the desk having to go and look.
  if v_account.status = 'frozen' then
    raise exception '133: % is frozen — %', v_account.label, v_account.frozen_reason;
  end if;
  if v_account.currency <> v_posting.currency then
    raise exception '133: % is a % account and this posting is in %; a movement that changes '
      'currency is two postings with an exchange line between them, not one',
      v_account.label, v_account.currency, v_posting.currency;
  end if;
  return NEW;
end $$;

create trigger money_legs_belong_to_their_book
  before insert on money_entries
  for each row execute function platform_auth.money_leg_names_its_own_book();

-- ============================================================
-- 6. the totals follow the legs
-- ============================================================

create or replace function platform_auth.money_totals_follow_the_legs() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.direction = 'debit' then
    update money_accounts
       set debit_total = debit_total + NEW.amount,
           entry_count = entry_count + 1,
           last_posted_at = now()
     where id = NEW.account_id;
  else
    update money_accounts
       set credit_total = credit_total + NEW.amount,
           entry_count = entry_count + 1,
           last_posted_at = now()
     where id = NEW.account_id;
  end if;
  return NEW;
end $$;

create trigger money_totals_follow_legs
  after insert on money_entries
  for each row execute function platform_auth.money_totals_follow_the_legs();

-- ============================================================
-- 7. the rule itself: a posting balances, or it is not a posting
-- ============================================================

-- Deferred, so it runs at COMMIT — which is the only moment the whole set of legs exists. Written on
-- both tables: on the leg, because that is how a movement arrives, and on the header, because a
-- posting with no legs at all must fail exactly as loudly as one with one leg.
create or replace function platform_auth.posting_balances_at_commit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_posting uuid;
  v_legs int;
  v_debits numeric(14,2);
  v_credits numeric(14,2);
  v_total numeric(14,2);
  v_ref text;
begin
  v_posting := case when TG_TABLE_NAME = 'money_entries'
                    then (select posting_id from money_entries where id = NEW.id)
                    else NEW.id end;
  -- The header is checked once per posting; a leg is checked for every leg, and a movement with six
  -- legs therefore asks the question six times. That is the cost of having no way to know which leg
  -- is the last one, and it is paid at commit, on a book the office only writes to a few times a day.
  select p.ref, p.total into v_ref, v_total from money_postings p where id = v_posting;
  if not found then
    raise exception '133: the posting a leg stood on is gone from the book';
  end if;
  select count(*)::int,
         coalesce(sum(case when direction = 'debit' then amount else 0 end), 0),
         coalesce(sum(case when direction = 'credit' then amount else 0 end), 0)
    into v_legs, v_debits, v_credits
    from money_entries where posting_id = v_posting;
  if v_legs < 2 then
    raise exception '133: posting % carries % leg(s). Money that moves has to leave one account and '
      'enter another', v_ref, v_legs;
  end if;
  if v_debits = 0 or v_credits = 0 then
    raise exception '133: posting % is all on one side — % debited, % credited',
      v_ref, v_debits, v_credits;
  end if;
  if v_debits <> v_credits then
    raise exception '133: posting % does not balance: debits % against credits % (out by % %)',
      v_ref, v_debits, v_credits, abs(v_debits - v_credits),
      (select currency from money_postings where id = v_posting);
  end if;
  if v_total <> v_debits then
    raise exception '133: posting % says it moved % but its legs add up to % — the figure on a '
      'movement is copied from its legs, never typed', v_ref, v_total, v_debits;
  end if;
  return null;
end $$;

create constraint trigger money_posting_balances
  after insert on money_postings
  deferrable initially deferred
  for each row execute function platform_auth.posting_balances_at_commit();

create constraint trigger money_legs_balance_their_posting
  after insert on money_entries
  deferrable initially deferred
  for each row execute function platform_auth.posting_balances_at_commit();

-- ============================================================
-- 8. the doors: open an account, freeze it, post a movement, reverse it
-- ============================================================

create or replace function platform_auth.open_money_account(
  p_tenant uuid, p_code text, p_label text, p_kind text, p_currency text,
  p_note text, p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_account money_accounts;
begin
  if p_tenant is null or p_actor is null then
    raise exception '133: an account needs a book and a named seat';
  end if;
  -- `raised_by` and `frozen_by` are only a foreign key, so a door that trusted any uuid could book
  -- a movement under a person who never touched it. The seat has to belong to the book it signs.
  if not exists (select 1 from users u
                  where u.id = p_actor and u.tenant_id = p_tenant) then
    raise exception '133: the seat named does not belong to that book, so it cannot open an account '
      'in it';
  end if;
  insert into money_accounts (tenant_id, code, label, kind, currency, note)
    values (p_tenant, upper(trim(p_code)), trim(p_label), p_kind,
            coalesce(nullif(trim(p_currency), ''), 'TZS'),
            nullif(trim(coalesce(p_note, '')), ''))
  returning * into v_account;
  return (select platform_auth.money_account_row(p_tenant, v_account.id));
exception when unique_violation then
  raise exception '133: that book already has an account called %. Two accounts for the same money '
    'is how a book stops meaning anything', upper(trim(p_code));
end $$;

-- `create or replace` with a different argument list makes a SECOND function and leaves the old one
-- in the catalog with whatever grants it was given, so the one-argument reader is dropped by name
-- rather than left behind as a door nobody revokes again.
drop function if exists platform_auth.money_account_row(uuid);

-- The account read is bound to its book like the other eight doors. An account id is handed out on a
-- screen and quoted back at an API, so a reader that took only the id would be a way to ask another
-- company's chart what its lines hold.
create or replace function platform_auth.money_account_row(p_tenant uuid, p_account uuid)
returns jsonb
language sql security definer set search_path = public as $$
  select to_jsonb(a) - 'tenant_id' from money_accounts a
   where a.id = p_account and a.tenant_id = p_tenant
$$;

create or replace function platform_auth.freeze_money_account(
  p_tenant uuid, p_account uuid, p_reason text, p_actor uuid, p_frozen boolean
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v money_accounts;
begin
  if p_tenant is null or p_actor is null then
    raise exception '133: freezing an account names the seat that froze it';
  end if;
  if not exists (select 1 from users u
                  where u.id = p_actor and u.tenant_id = p_tenant) then
    raise exception '133: the seat named does not belong to that book, so it cannot freeze an '
      'account in it';
  end if;
  select * into v from money_accounts
    where id = p_account and tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if p_frozen then
    if v.status = 'frozen' then
      return jsonb_build_object('ok', false, 'error', 'already',
        'label', v.label, 'reason', v.frozen_reason);
    end if;
    if p_reason is null or char_length(trim(p_reason)) < 8 then
      raise exception '133: freezing % needs a sentence a later seat can read', v.label;
    end if;
    update money_accounts
       set status = 'frozen', frozen_reason = trim(p_reason),
           frozen_by = p_actor, frozen_at = now()
     where id = v.id;
  else
    if v.status = 'open' then
      return jsonb_build_object('ok', false, 'error', 'already_open', 'label', v.label);
    end if;
    update money_accounts
       set status = 'open', frozen_reason = null, frozen_by = null, frozen_at = null
     where id = v.id;
  end if;
  return jsonb_build_object('ok', true, 'account', platform_auth.money_account_row(p_tenant, v.id));
end $$;

/**
 * The one way a movement enters the book.
 *
 * Legs arrive as a jsonb array because a posting is not a row — it is a header and two or more sides
 * that have to exist together, and an API that took them one call at a time would leave the book
 * holding a half movement between the calls. The door works the figure out from the legs before the
 * header exists, because the trigger below freezes a posted movement's figure against every later
 * edit; and it refuses the shapes a desk can be told about — a leg with no account, an amount with a
 * comma in it, a movement all on one side — in one sentence naming both numbers. The balance itself
 * is enforced twice over: here for the words, and by the deferred constraint trigger at commit so
 * that a writer which bypasses this door still cannot leave an unbalanced posting in the book. What
 * the door adds besides the sums is the idempotency answer — a retry gets the posting it
 * already made, with `replayed` on it, instead of a second movement with the same words.
 *
 * Params: book, day, memo, currency, source kind, source pointer, source ref, idempotency key,
 * actor, legs [{account, direction, amount, detail}].
 */
create or replace function platform_auth.record_money_posting(
  p_tenant uuid, p_posted_on date, p_memo text, p_currency text, p_source_kind text,
  p_source_id uuid, p_source_ref text, p_idempotency text, p_actor uuid, p_legs jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_existing money_postings;
  v_row record;
  v_posting uuid;
  v_ref text;
  v_currency text;
  v_debits numeric(14,2) := 0;
  v_credits numeric(14,2) := 0;
  v_count int := 0;
begin
  if p_tenant is null or p_actor is null then
    raise exception '133: a movement needs a book and the seat that wrote it';
  end if;
  -- `raised_by` is only a foreign key to `users`, so a door that took any uuid could book a movement
  -- under a person who never wrote it. The seat that signs a movement belongs to the book it is
  -- written in — the office's own pen for the office's book, a company's for a company's.
  if not exists (select 1 from users u
                  where u.id = p_actor and u.tenant_id = p_tenant) then
    raise exception '133: the seat that wrote this movement does not belong to that book';
  end if;
  v_count := case when p_legs is null or jsonb_typeof(p_legs) <> 'array'
                  then 0 else jsonb_array_length(p_legs) end;
  if v_count < 2 then
    raise exception '133: a movement needs two legs or more, and % were given', v_count;
  end if;
  v_currency := coalesce(nullif(trim(p_currency), ''), 'TZS');
  if v_currency not in ('TZS', 'USD') then
    raise exception '133: a book is kept in % or % — "%" is not a money this register holds',
      'TZS', 'USD', v_currency;
  end if;
  if p_source_kind is null or p_source_kind not in (
       'opening','manual','adjustment','reversal',
       'invoice','payment','refund','payout','fee','escrow','cost','payroll','tax') then
    raise exception '133: a movement must say what it stands for, and "%" is not one of the thirteen '
      'kinds the book recognises', coalesce(p_source_kind, '(nothing)');
  end if;

  if nullif(trim(coalesce(p_idempotency, '')), '') is not null then
    select * into v_existing from money_postings
     where tenant_id = p_tenant
       and idempotency_key = trim(p_idempotency);
    if found then
      return jsonb_build_object('ok', true, 'replayed', true,
                                'posting', platform_auth.money_posting_detail(p_tenant, v_existing.id));
    end if;
  end if;

  -- Every leg is read before a row is written, because the header's figure has to be right at the
  -- moment the header exists: the trigger below freezes `total` against later edits, so a door that
  -- filled it in after the legs arrived would be refused by its own guard.
  for v_row in select t.ord, t.j
                  from jsonb_array_elements(p_legs) with ordinality as t(j, ord)
                 order by t.ord loop
    if coalesce(v_row.j ->> 'account', '') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception '133: leg % of a movement must name the account it moves, and it does not',
        v_row.ord;
    end if;
    if lower(trim(coalesce(v_row.j ->> 'direction', ''))) not in ('debit', 'credit') then
      raise exception '133: leg % is on side "%"'
                      ' — a leg is either debited or credited, and the book keeps both sides',
        v_row.ord, coalesce(v_row.j ->> 'direction', '(nothing)');
    end if;
    if coalesce(v_row.j ->> 'amount', '') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$' then
      raise exception '133: leg % carries "%"'
                      ' — an amount is a figure with at most two decimals, never a thousand '
                      'separator and never a float',
        v_row.ord, coalesce(v_row.j ->> 'amount', '(nothing)');
    end if;
    if (v_row.j ->> 'amount')::numeric <= 0 then
      raise exception '133: leg % moves %: a leg that moves nothing is not a leg',
        v_row.ord, (v_row.j ->> 'amount')::numeric;
    end if;
    v_debits := v_debits + case when lower(trim(v_row.j ->> 'direction')) = 'debit'
                                then (v_row.j ->> 'amount')::numeric else 0 end;
    v_credits := v_credits + case when lower(trim(v_row.j ->> 'direction')) = 'credit'
                                  then (v_row.j ->> 'amount')::numeric else 0 end;
  end loop;

  if v_debits = 0 or v_credits = 0 then
    raise exception '133: % leg(s) are all on one side — % debited, % credited. Money that moves '
      'leaves one account and enters another', v_count, v_debits, v_credits;
  end if;
  if v_debits <> v_credits then
    raise exception '133: % legs carry % debited against % credited (out by %). A movement that '
      'does not balance is not posted — name the account the difference sits in',
      v_count, v_debits, v_credits, abs(v_debits - v_credits);
  end if;

  v_ref := 'PST-' || to_char(now(), 'YYYY') || '-' ||
           lpad(nextval('money_posting_number_seq')::text, 5, '0');

  insert into money_postings (tenant_id, ref, posted_on, memo, currency, source_kind,
                              source_id, source_ref, total, raised_by, idempotency_key)
    values (p_tenant, v_ref, p_posted_on, trim(p_memo), v_currency, p_source_kind,
            p_source_id, nullif(trim(coalesce(p_source_ref, '')), ''),
            v_debits, p_actor, nullif(trim(coalesce(p_idempotency, '')), ''))
  returning id into v_posting;

  insert into money_entries (posting_id, tenant_id, account_id, direction, amount, detail)
    select v_posting, p_tenant, (t.j ->> 'account')::uuid,
           lower(trim(t.j ->> 'direction')), (t.j ->> 'amount')::numeric(14,2),
           nullif(trim(coalesce(t.j ->> 'detail', '')), '')
      from jsonb_array_elements(p_legs) as t(j);

  return jsonb_build_object('ok', true, 'replayed', false,
                            'posting', platform_auth.money_posting_detail(p_tenant, v_posting));
exception when unique_violation then
  -- Two requests with the same key can arrive before either commits; the loser finds the winner's
  -- posting here and answers with it, which is the whole point of the key.
  if nullif(trim(coalesce(p_idempotency, '')), '') is not null then
    select * into v_existing from money_postings
     where tenant_id = p_tenant and idempotency_key = trim(p_idempotency);
    if found then
      return jsonb_build_object('ok', true, 'replayed', true,
                                'posting', platform_auth.money_posting_detail(p_tenant, v_existing.id));
    end if;
  end if;
  raise;
end $$;

/**
 * A movement is undone by posting its mirror, not by editing it.
 *
 * The mirror carries its own number and points back at the paper it answers, and the original row
 * gains only the two facts that it has been reversed and by whom — which is all the header trigger
 * will let it gain. So the book keeps both sides of the mistake and the office can read the history
 * rather than a corrected figure with no trace of the one it replaced.
 */
create or replace function platform_auth.reverse_money_posting(
  p_tenant uuid, p_posting uuid, p_reason text, p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_orig money_postings;
  v_mirror jsonb;
begin
  select * into v_orig from money_postings
    where id = p_posting and tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_orig.status = 'reversed' then
    return jsonb_build_object('ok', false, 'error', 'already_reversed', 'ref', v_orig.ref);
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 8 then
    raise exception '133: reversing % needs the sentence that says why', v_orig.ref;
  end if;
  if v_orig.source_kind = 'reversal' then
    raise exception '133: % is itself a reversal. Undoing an undoing is a fresh movement, written '
      'out with its own words', v_orig.ref;
  end if;

  select jsonb_agg(jsonb_build_object(
           'account', e.account_id,
           'direction', case when e.direction = 'debit' then 'credit' else 'debit' end,
           'amount', e.amount,
           'detail', 'mirror of ' || v_orig.ref
         ))
    into v_mirror
    from money_entries e where e.posting_id = v_orig.id;

  if v_mirror is null or jsonb_array_length(v_mirror) < 2 then
    raise exception '133: % carries no legs to mirror, so it cannot be reversed by a mirror',
      v_orig.ref;
  end if;

  v_mirror := platform_auth.record_money_posting(
    p_tenant, current_date,
    'Reversal of ' || v_orig.ref || ': ' || left(v_orig.memo, 140),
    v_orig.currency, 'reversal', v_orig.id, v_orig.ref, null, p_actor, v_mirror);

  update money_postings
     set status = 'reversed', reversal_note = trim(p_reason),
         reversed_by = p_actor, reversed_at = now()
   where id = v_orig.id;

  return jsonb_build_object('ok', true, 'reversal', v_mirror -> 'posting',
                            'original_ref', v_orig.ref);
end $$;

-- ============================================================
-- 9. the reads: the book, the register, one movement
-- ============================================================

/**
 * The accounts, their cached totals, and the same totals recomputed from the legs.
 *
 * `cached` and `recomputed` are printed as a pair on purpose. A ledger that only ever shows its own
 * running column is a ledger that cannot be audited, and the trigger that keeps that column is code
 * someone can get wrong. So the desk shows both and says whether they agree, and the office has a
 * number that means something rather than a claim that the book is fine.
 */
create or replace function platform_auth.money_book(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_accounts jsonb;
  v_totals jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ac.id, 'code', ac.code, 'label', ac.label, 'kind', ac.kind,
    'currency', ac.currency, 'status', ac.status, 'note', ac.note,
    'frozen_reason', ac.frozen_reason, 'frozen_at', ac.frozen_at,
    'opened_at', ac.opened_at, 'last_posted_at', ac.last_posted_at,
    'entry_count', ac.entry_count,
    'cached', jsonb_build_object('debit', ac.debit_total, 'credit', ac.credit_total),
    'recomputed', jsonb_build_object('debit', r.debit, 'credit', r.credit),
    'drift', (r.debit <> ac.debit_total or r.credit <> ac.credit_total),
    'balance', case when ac.kind in ('asset','expense')
                    then ac.debit_total - ac.credit_total
                    else ac.credit_total - ac.debit_total end,
    'recomputed_balance', case when ac.kind in ('asset','expense')
                               then r.debit - r.credit
                               else r.credit - r.debit end,
    -- Which side a balance is printed on is a fact about the kind of account, not a choice the
    -- desk makes: assets and expenses are debited when they grow, the other three are credited.
    'natural_side', case when ac.kind in ('asset','expense') then 'debit' else 'credit' end
  ) order by ac.kind, ac.code), '[]'::jsonb)
    into v_accounts
    from money_accounts ac
    -- One lateral per account, and the planner drives it from money_entries_account_idx. The office's
    -- book is ten accounts and a few hundred movements; the day it is thousands is the day this read
    -- becomes a grouped join, and `money_book` is only ever called once per desk load.
    left join lateral (
      select coalesce(sum(e.amount) filter (where e.direction = 'debit'), 0)::numeric(14,2) as debit,
             coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2) as credit
        from money_entries e
       where e.account_id = ac.id
    ) r on true
   where ac.tenant_id = p_tenant;

  select jsonb_build_object(
    'accounts', a.accounts, 'frozen_accounts', a.frozen,
    'postings', p.postings, 'movements_reversed', p.reversed,
    'tzs_postings', p.tzs, 'usd_postings', p.usd,
    'legs', e.legs, 'debited', e.debited, 'credited', e.credited,
    'out_by', e.debited - e.credited,
    'square', (e.debited = e.credited)
  ) into v_totals
    from (select count(*)::int as accounts,
                 coalesce(sum((status = 'frozen')::int), 0)::int as frozen
            from money_accounts where tenant_id = p_tenant) a,
         (select count(*)::int as postings,
                 coalesce(sum((status = 'reversed')::int), 0)::int as reversed,
                 coalesce(sum((currency = 'TZS')::int), 0)::int as tzs,
                 coalesce(sum((currency = 'USD')::int), 0)::int as usd
            from money_postings where tenant_id = p_tenant) p,
         (select count(*)::int as legs,
                 coalesce(sum(amount) filter (where direction = 'debit'), 0)::numeric(14,2) as debited,
                 coalesce(sum(amount) filter (where direction = 'credit'), 0)::numeric(14,2) as credited
            from money_entries where tenant_id = p_tenant) e;

  return jsonb_build_object('accounts', v_accounts, 'totals', v_totals);
end $$;

/**
 * The register: movements, newest first, with their sides folded into one line.
 *
 * The counterparty text is what makes a register readable — "1 000 000.00 out of OPS-CASH into
 * ESCROW-TZS" answers the question a list of amounts does not. Filters are the four an office
 * actually asks with: open or reversed, which currency, which account touched, and a free-text
 * search over the movement's number and its words. The book itself is bound by the caller, because
 * a definer runs as its owner and RLS would not bind it for them.
 */
create or replace function platform_auth.money_register(
  p_tenant uuid, p_status text, p_currency text, p_account uuid, p_search text,
  p_limit int, p_offset int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows jsonb;
  v_count int;
  v_limit int := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  select count(*)::int into v_count
    from money_postings p
   where p.tenant_id = p_tenant
     and (p_status is null or p.status = p_status)
     and (p_currency is null or p.currency = p_currency)
     and (p_account is null or exists (select 1 from money_entries e
                                        where e.posting_id = p.id and e.account_id = p_account))
     and (p_search is null or p.ref ilike '%' || p_search || '%' or p.memo ilike '%' || p_search || '%');

  -- The page is cut first, in its own subquery, so the sides are only built for the rows the desk
  -- actually receives: a register of six hundred movements would otherwise aggregate twelve hundred
  -- legs to throw five hundred and forty of them away.
  select coalesce(jsonb_agg(row_json order by raised_at desc, ref desc), '[]'::jsonb) into v_rows
    from (
      select p.raised_at, p.ref, jsonb_build_object(
        'id', p.id, 'ref', p.ref,
        'posted_on', to_char(p.posted_on, 'YYYY-MM-DD'),
        'memo', p.memo, 'currency', p.currency, 'total', p.total,
        'source_kind', p.source_kind, 'source_ref', p.source_ref, 'source_id', p.source_id,
        'status', p.status, 'reversal_note', p.reversal_note, 'raised_at', p.raised_at,
        'raised_by', (select u.full_name from users u where u.id = p.raised_by),
        'reversed_by', (select u.full_name from users u where u.id = p.reversed_by),
        'sides', s.sides, 'moved', s.moved, 'debited', s.debited, 'credited', s.credited
      ) as row_json
      from (
        select p2.id, p2.raised_at
          from money_postings p2
         where p2.tenant_id = p_tenant
           and (p_status is null or p2.status = p_status)
           and (p_currency is null or p2.currency = p_currency)
           and (p_account is null or exists (select 1 from money_entries e2
                                              where e2.posting_id = p2.id and e2.account_id = p_account))
           and (p_search is null or p2.ref ilike '%' || p_search || '%'
                             or p2.memo ilike '%' || p_search || '%')
         order by p2.raised_at desc
         limit v_limit offset v_offset
      ) page
      join money_postings p on p.id = page.id
      left join lateral (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'direction', e.direction, 'amount', e.amount,
                 'account', ac.code, 'label', ac.label, 'account_id', ac.id,
                 'kind', ac.kind, 'detail', e.detail
               ) order by e.direction desc, ac.code), '[]'::jsonb) as sides,
               coalesce(string_agg(ac.code || ' ' || case when e.direction = 'debit'
                                                          then 'out' else 'in' end,
                        ', ' order by e.direction desc, ac.code), '') as moved,
               coalesce(sum(e.amount) filter (where e.direction = 'debit'), 0)::numeric(14,2) as debited,
               coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2) as credited
        from money_entries e
        join money_accounts ac on ac.id = e.account_id
        where e.posting_id = p.id
      ) s on true
    ) x;

  return jsonb_build_object('rows', v_rows, 'count', v_count,
                            'returned', coalesce(jsonb_array_length(v_rows), 0),
                            'limit', v_limit, 'offset', v_offset);
end $$;

create or replace function platform_auth.money_posting_detail(p_tenant uuid, p_posting uuid)
returns jsonb
language sql security definer set search_path = public as $$
  select to_jsonb(p) - 'tenant_id' - 'idempotency_key'
         || jsonb_build_object(
              'raised_by_name', (select u.full_name from users u where u.id = p.raised_by),
              'reversed_by_name', (select u.full_name from users u where u.id = p.reversed_by),
              'legs', (select coalesce(jsonb_agg(jsonb_build_object(
                          'id', e.id, 'direction', e.direction, 'amount', e.amount,
                          'detail', e.detail, 'account_id', e.account_id,
                          'code', ac.code, 'label', ac.label, 'kind', ac.kind,
                          'currency', ac.currency
                        ) order by e.direction desc, ac.code), '[]'::jsonb)
                        from money_entries e
                        join money_accounts ac on ac.id = e.account_id
                       where e.posting_id = p.id),
              'answers', (select jsonb_agg(jsonb_build_object('ref', r.ref, 'posted_on', r.posted_on))
                            from money_postings r
                           where r.source_id = p.id and r.source_kind = 'reversal'),
              'answered_by', (select jsonb_build_object('ref', r.ref, 'posted_on', r.posted_on)
                                from money_postings r
                               where p.status = 'reversed'
                                 and r.source_id = p.id and r.source_kind = 'reversal'
                               limit 1)
            )
    from money_postings p
   where p.id = p_posting and p.tenant_id = p_tenant
$$;

/**
 * The one sentence the desk must not have to work out for itself: does every posting in this book
 * balance, counted from the legs right now?
 *
 * A book with a movement that does not balance is not a book, so the answer is on the screen beside
 * the totals rather than buried in a log. It should always be zero, and when it is not, it names the
 * posting, because "something is wrong somewhere" is not a thing an office can act on.
 */
create or replace function platform_auth.money_book_is_square(p_tenant uuid) returns jsonb
language sql security definer set search_path = public as $$
  with s as (
    select p.id, p.ref, p.total,
           count(e.id)::int                                                                       as legs,
           coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)::numeric(14,2)        as debits,
           coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2)        as credits
      from money_postings p
      left join money_entries e on e.posting_id = p.id
     where p.tenant_id = p_tenant
     group by p.id, p.ref, p.total
  )
  select jsonb_build_object(
    'postings', coalesce((select count(*)::int from s), 0),
    'short_legged', coalesce((select count(*)::int from s where s.legs < 2), 0),
    'one_sided', coalesce((select count(*)::int from s where s.debits = 0 or s.credits = 0), 0),
    'unbalanced', coalesce((select count(*)::int from s where s.debits <> s.credits), 0),
    'figure_disagrees', coalesce((select count(*)::int from s where s.total <> s.debits), 0),
    'refs', coalesce((select jsonb_agg(b.ref order by b.ref) from (
             select s.ref from s
              where s.legs < 2 or s.debits = 0 or s.credits = 0
                 or s.debits <> s.credits or s.total <> s.debits
              limit 8) b), '[]'::jsonb),
    -- The one word the desk prints: the book either agrees with itself or it does not, and this is
    -- counted from the legs, not from the cached columns it is checking.
    'square', not exists (select 1 from s
                           where s.legs < 2 or s.debits = 0 or s.credits = 0
                              or s.debits <> s.credits or s.total <> s.debits)
  )
$$;

-- ============================================================
-- 10. the duties
-- ============================================================

-- Reading the book and writing in it are different jobs, and freezing an account is a third: it is
-- the act that stops somebody else's movement, so it is charged to the seat that settles disputes
-- rather than to whoever holds a pen. Asking for a signature on a money movement still costs
-- `control.payments.manage` and signing one still costs `control.approvals.decide` — 126's keys, no
-- new ones invented for money.
insert into permissions (key, description) values
  ('control.money.view',
   'Control - Read the double-entry book: accounts, balances, movements and whether they are square'),
  ('control.money.post',
   'Control - Post a movement, open an account and reverse a posting that was written wrong'),
  ('control.money.freeze',
   'Control - Freeze an account with a reason, and unfreeze it')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.money.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','billing_admin','finance_officer','compliance_officer',
                 'platform_analyst','auditor')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.money.post'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','billing_admin','finance_officer')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.money.freeze'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','compliance_officer')
on conflict do nothing;

-- ============================================================
-- 11. the chart: the platform's own book, empty of movement
-- ============================================================

-- Nine TZS accounts and one in USD, each one naming the money the office already holds somewhere
-- else — 005's payments, 126's refunds, 114's single live rail. No opening balance: an opening figure
-- is declared by the office on the desk, under `opening`, and a migration that invents one hands the
-- book a number nothing was ever owed.
insert into money_accounts (tenant_id, code, label, kind, currency, note)
select t.id, c.code, c.label, c.kind, c.currency, c.note
  from (select id from tenants where type = 'platform' and deleted_at is null) t
 cross join (values
   ('OPS-CASH',    'Treasury cash (TZS)',              'asset',     'TZS',
    'Money the platform holds and can spend today.'),
   ('OPS-BANK',    'Bank account (TZS)',               'asset',     'TZS',
    'The company bank line the office pays people out of.'),
   ('OPS-USD',     'Bank account (USD)',               'asset',     'USD',
    'Foreign currency held separately: a USD movement is never mixed into a TZS posting.'),
   ('GATE-WAIT',   'Gateway money not yet confirmed',  'asset',     'TZS',
    'Rail money a provider has told us about and we have not settled. 114''s webhook lands here.'),
   ('WALLET-TZS',  'Company balances held (TZS)',      'asset',     'TZS',
    'Money that is the companies'' and not ours to spend. The wallet book sits on this account.'),
   ('ESCROW-TZS',  'Escrow held against a job',        'liability', 'TZS',
    'Held until the job is done; released to one side and returned to the other.'),
   ('FEE-INCOME',  'Platform fee income (TZS)',        'income',    'TZS',
    'What the platform earns. 088 allocates it by module; this is where it is actually booked.'),
   ('REFUND-DUE',  'Refunds owed (TZS)',               'liability', 'TZS',
    'The papers 126 signs, one line each, until the money leaves.'),
   ('PAYOUT-DUE',  'Payouts payable (TZS)',            'liability', 'TZS',
    'Money agreed out to a company or a driver and not yet paid.'),
   ('COST-OPS',    'Platform costs (TZS)',             'expense',   'TZS',
    'Infrastructure, staff and office cost — 066 and 072 settle against this.')
 ) c(code, label, kind, currency, note)
where not exists (select 1 from money_accounts m where m.tenant_id = t.id and m.code = c.code);

-- ============================================================
-- 12. grants on the doors
-- ============================================================

-- A trigger body is fired, never called: the owner holds these and the app role does not (110, 121,
-- 125, 126).
revoke all on function
  platform_auth.prevent_money_entry_mutation(),
  platform_auth.money_posting_keeps_its_words(),
  platform_auth.money_leg_names_its_own_book(),
  platform_auth.money_totals_follow_the_legs(),
  platform_auth.posting_balances_at_commit()
from public, anon, authenticated, app_runtime;

grant execute on function
  platform_auth.open_money_account(uuid, text, text, text, text, text, uuid),
  platform_auth.freeze_money_account(uuid, uuid, text, uuid, boolean),
  platform_auth.record_money_posting(uuid, date, text, text, text, uuid, text, text, uuid, jsonb),
  platform_auth.reverse_money_posting(uuid, uuid, text, uuid),
  platform_auth.money_account_row(uuid, uuid),
  platform_auth.money_book(uuid),
  platform_auth.money_register(uuid, text, text, uuid, text, int, int),
  platform_auth.money_posting_detail(uuid, uuid),
  platform_auth.money_book_is_square(uuid)
to app_runtime;

-- `create or replace function` hands EXECUTE back to PUBLIC, so every door is revoked after it is
-- granted — the sweep 114 lists and every stage since has honoured.
revoke all on function
  platform_auth.open_money_account(uuid, text, text, text, text, text, uuid),
  platform_auth.freeze_money_account(uuid, uuid, text, uuid, boolean),
  platform_auth.record_money_posting(uuid, date, text, text, text, uuid, text, text, uuid, jsonb),
  platform_auth.reverse_money_posting(uuid, uuid, text, uuid),
  platform_auth.money_account_row(uuid, uuid),
  platform_auth.money_book(uuid),
  platform_auth.money_register(uuid, text, text, uuid, text, int, int),
  platform_auth.money_posting_detail(uuid, uuid),
  platform_auth.money_book_is_square(uuid)
from public, anon, authenticated, service_role;

-- ============================================================
-- 13. say what this leaves the platform in
-- ============================================================

do $$ declare
  v_accounts int;
  v_seeded int;
  v_postings int;
  v_entries int;
  v_writers int;
  v_public int;
  v_readers int;
  v_leaks int;
  v_trigger_grants int;
begin
  select count(*)::int into v_accounts from money_accounts;
  select count(*)::int into v_postings from money_postings;
  select count(*)::int into v_entries from money_entries;

  -- The chart is the whole point of the register existing before the money arrives: an office cannot
  -- post into an account that has not been named yet.
  if v_accounts < 10 then
    raise exception '133: the platform book left with only % account(s) seeded', v_accounts;
  end if;
  if v_postings <> 0 or v_entries <> 0 then
    raise exception '133: a fresh book must be empty of movement — % posting(s), % leg(s)',
      v_postings, v_entries;
  end if;

  -- What can be proved without writing a row is proved here, because the balance guard is DEFERRED —
  -- it fires when the transaction closes, so an unbalanced probe inside this migration would abort
  -- the migration's own commit rather than be caught here, and a caught probe that had to be deleted
  -- afterwards would be refused by the delete guard it was testing. `api/scripts/verify-money-ledger-
  -- sql.ts` commits and rolls back real postings and proves every refusal a desk would be told.
  if (select count(*)::int from pg_trigger
       where tgname in ('money_posting_balances', 'money_legs_balance_their_posting')
         and tgdeferrable and tginitdeferred and not tgisinternal) <> 2 then
    raise exception '133: the balance rule must be a deferred constraint trigger on both the posting '
      'and its legs, so a half movement is refused when the transaction closes';
  end if;
  if (select count(*)::int from pg_trigger
       where tgname in ('money_entries_are_kept', 'money_postings_keep_their_words')
         and not tgdeferrable and tgenabled = 'O' and not tgisinternal) <> 2 then
    raise exception '133: the append-only guards are missing or have become deferrable';
  end if;

  -- The book is written through doors. Anything that leaves a plain INSERT on the three registers
  -- for a client role is a way to post a movement without an actor, a reason or a balance check.
  select coalesce(count(*)::int, 0) into v_writers
    from pg_class c cross join aclexplode(c.relacl) a
   where c.relkind = 'r'
     and c.relname in ('money_accounts', 'money_postings', 'money_entries')
     and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
     and a.grantee <> 0 and a.grantee <> c.relowner;
  if v_writers <> 0 then
    raise exception '133: % non-owner role(s) hold a write grant on the book — the doors below are '
      'the only way a movement is allowed in', v_writers;
  end if;
  select coalesce(count(*)::int, 0) into v_public
    from pg_class c cross join aclexplode(c.relacl) a
   where c.relname in ('money_accounts', 'money_postings', 'money_entries')
     and a.grantee = 0;
  if v_public <> 0 then
    raise exception '133: PUBLIC still holds % privilege line(s) on the book', v_public;
  end if;
  select coalesce(count(*)::int, 0) into v_readers
    from pg_class c cross join aclexplode(c.relacl) a
   where c.relname in ('money_accounts', 'money_postings', 'money_entries')
     and a.privilege_type = 'SELECT'
     and a.grantee = (select oid from pg_roles where rolname = 'app_runtime');
  if v_readers <> 3 then
    raise exception '133: the app role must be able to read all three registers and write none of '
      'them, and it holds % select grant(s)', v_readers;
  end if;

  select coalesce(count(*)::int, 0) into v_leaks
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join aclexplode(p.proacl) a
   where n.nspname = 'platform_auth'
     and p.proname in ('open_money_account', 'money_account_row', 'freeze_money_account',
                       'record_money_posting', 'reverse_money_posting', 'money_book',
                       'money_register', 'money_posting_detail', 'money_book_is_square')
     and (a.grantee = 0
          or a.grantee = any (select oid from pg_roles
                               where rolname in ('anon', 'authenticated', 'service_role')));
  if v_leaks <> 0 then
    raise exception '133: % of the book''s doors are still grantable to a client role or to PUBLIC',
      v_leaks;
  end if;
  select coalesce(count(*)::int, 0) into v_trigger_grants
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join aclexplode(p.proacl) a
   where n.nspname = 'platform_auth'
     and p.proname in ('prevent_money_entry_mutation', 'money_posting_keeps_its_words',
                       'money_leg_names_its_own_book', 'money_totals_follow_the_legs',
                       'posting_balances_at_commit')
     and (a.grantee = 0 or a.grantee = (select oid from pg_roles where rolname = 'app_runtime'));
  if v_trigger_grants <> 0 then
    raise exception '133: a trigger body is fired, never called, and % of 133''s five still answer '
      'a caller', v_trigger_grants;
  end if;
  if not exists (select 1 from pg_roles r
                  where r.rolname = 'app_runtime'
                    and has_function_privilege(r.oid,
                          'platform_auth.record_money_posting(uuid, date, text, text, text, uuid, text, text, uuid, jsonb)',
                          'EXECUTE')) then
    raise exception '133: the door that posts a movement is not executable by the app role';
  end if;

  select count(*)::int into v_seeded from money_accounts where currency = 'USD';
  raise notice '133: the book is open — % account(s) in the platform chart (% of them in USD), % '
    'movement(s) on it, and a posting that does not balance cannot be committed by anybody',
    v_accounts, v_seeded, v_postings;
end $$;

commit;
