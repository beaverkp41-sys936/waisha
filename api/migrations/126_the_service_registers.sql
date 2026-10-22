-- 126 — the service registers: what the office does after the call (task #341).
--
-- 101 put every call in a book, 123 gave the desks a week and two promises, 125 made the book
-- one inbox for every source. What the spec's Service module still asks for is the work that
-- happens *after* a call is settled, and the recon says four of its six lines do not exist yet:
--
--   the call log       already ships — `next_ticket_number` (123:365), the desk's own `dept_ref`,
--                      `after_hours` (123:322) and the caller's history read. Not rebuilt here.
--   the workload board already ships — per-seat workload (`WORKLOAD_SQL`, control-staff.routes)
--                      and per-desk KPI percentiles (control-departments.routes + the desk's
--                      detail page). Not rebuilt here.
--   the dispute        HERE. A caller who says "you got this wrong and I want it put right" is
--                      today answered by a note on a closed call, which nobody can count.
--   the satisfaction   HERE. CSAT after closure, asked once per call, with the answer optional.
--   the quality review HERE. A supervisor grading how a call was handled, against the six things
--                      the office says a good call does.
--   the refund paper   HERE. The request that money goes back — and, because it is money, it
--                      cannot be released by the hand that wrote it (121's rule, extended).
--
-- The shape all four share: the register is platform-owned exactly as 101's is (the platform
-- tenant in `tenant_id`, the company the paper is about kept beside it), every guard is a CHECK
-- or a trigger rather than a convention in a route file, and no figure a desk prints is one a
-- caller can hand-write into a column the database already knows how to work out.
--
-- Two things this migration deliberately does not do, stated rather than left to be found:
--
-- 1. **It is not the ledger.** A released refund paper says the office agreed and a second seat
--    signed; it does not say money moved. #344's double-entry book will add the paid state and
--    settle against this row, and the desk says so on the paper. A `refunded` payment status
--    (005:105) is not the same thing and stays what it is.
-- 2. **It is not the tenant's dispute book.** 033's `incidents` are transport incidents inside
--    one company. These are disputes *with the platform's own office* — a company ringing WAISHA
--    about what WAISHA did — so they sit on the platform register beside the calls.
begin;

-- ============================================================
-- 1. the dispute: a call the office is being asked to put right
-- ============================================================

create sequence if not exists service_dispute_number_seq;
create sequence if not exists service_refund_number_seq;
grant usage, select on sequence service_dispute_number_seq to app_runtime;
grant usage, select on sequence service_refund_number_seq to app_runtime;

create table if not exists service_disputes (
  id uuid primary key default gen_random_uuid(),
  -- The platform tenant that owns the register, as in 101 and 125. Not the company.
  tenant_id uuid not null references tenants(id),
  -- DP-2026-00001. Quoted on the phone the way CS- is, from its own global sequence.
  ref text not null unique check (ref ~ '^DP-[0-9]{4}-[0-9]{5,}$'),
  -- A dispute is always about a call that was handled. The link is required because "which
  -- call?" is the first question anybody asks of a dispute, and a register that can answer it
  -- only out of a prose sentence cannot be counted.
  ticket_id uuid not null references support_tickets(id),
  -- Copied by a trigger below, never typed: a register read two years from now has to say
  -- which incidence it stands on without trusting that the row still looks the same.
  ticket_ref text not null,
  company_tenant_id uuid references tenants(id) on delete set null,
  company_name text not null check (char_length(trim(company_name)) between 2 and 140),
  -- The ground, in the office's words rather than the caller's, so the queue can be read as
  -- "everything we were challenged on a promise for". `fee_dispute` is the argument about a
  -- charge; `overcharge` is the office agreeing the figure was wrong.
  ground text not null check (ground in (
    'wrong_advice','missed_promise','unanswered_call','fee_dispute','overcharge',
    'lost_paperwork','discourtesy','other')),
  -- The caller's side, in full. Ten characters is 101's floor for a body, for the same reason:
  -- below that it belongs in the ground and the desk is left with nothing to read.
  claim text not null check (char_length(trim(claim)) between 10 and 4000),
  -- What the caller says is owed. NULL is honest — a discourtesy dispute has no figure — and
  -- the pair with the currency is kept whole, so a bare number can never be totalled across
  -- two currencies by whoever reads it later.
  amount numeric(14,2) check (amount is null or (amount > 0 and amount <= 10000000000)),
  currency text check (currency in ('TZS','USD')),
  status text not null default 'open' check (status in (
    'open','investigating','upheld','rejected','settled','withdrawn')),
  -- The finding, in a sentence. Required by the CHECK the moment the line claims to be
  -- decided: a dispute that is `rejected` with no words is a status, not a decision.
  outcome text check (outcome is null or char_length(trim(outcome)) between 8 and 2000),
  decided_by uuid references users(id),
  decided_at timestamptz,
  -- The paper the settlement stands on, when money is what was decided. Its own foreign key is
  -- added in section 3, after the table it points at exists.
  refund_request_id uuid,
  opened_by uuid not null references users(id),
  opened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references users(id),

  check ((amount is null) = (currency is null)),
  check (char_length(trim(ticket_ref)) between 6 and 40),
  check (status not in ('upheld','rejected','settled','withdrawn')
         or (char_length(trim(coalesce(outcome, ''))) >= 8
             and decided_by is not null and decided_at is not null)),
  check (decided_at is null or decided_by is not null),
  -- A figure that was upheld has to be settled on paper: `upheld` is the office conceding it
  -- owes something, and if nothing has been asked for then nothing will be paid.
  check (status <> 'upheld' or amount is null or refund_request_id is not null)
);

create index service_disputes_queue on service_disputes (tenant_id, status, opened_at desc)
  where deleted_at is null;
create index service_disputes_ticket on service_disputes (ticket_id) where deleted_at is null;
create index service_disputes_company on service_disputes (company_tenant_id, opened_at desc)
  where deleted_at is null and company_tenant_id is not null;

alter table service_disputes enable row level security;
create policy service_disputes_tenant on service_disputes for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Closed, never deleted: a dispute is the evidence about a decision, and a register that can
-- lose its arguments can only tell the story the office chose.
grant select, insert, update on service_disputes to app_runtime;
revoke all on service_disputes from public, anon, authenticated, service_role;

comment on column service_disputes.ticket_ref is
  'The incidence number, copied by a trigger at write time. Never typed by a caller.';
comment on column service_disputes.amount is
  'What the caller says is owed. Kept apart by currency; never totalled across one.';

-- ============================================================
-- 2. the line for everything done to a dispute
-- ============================================================

create table if not exists service_dispute_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ts timestamptz not null default now(),
  dispute_id uuid not null references service_disputes(id),
  ref text not null,
  actor_user_id uuid references users(id),
  actor_role text,
  ip text,
  action text not null check (action in (
    'opened','paper_filed','paper_retired','status_changed','refund_raised','decided','note')),
  from_label text,
  to_label text,
  reason text not null check (char_length(trim(reason)) between 4 and 300),
  detail jsonb not null default '{}'::jsonb
);
create index service_dispute_events_dispute on service_dispute_events (dispute_id, ts);
create index service_dispute_events_recent on service_dispute_events (tenant_id, ts desc);

alter table service_dispute_events enable row level security;
create policy service_dispute_events_select on service_dispute_events
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy service_dispute_events_insert on service_dispute_events
  for insert to app_runtime
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert on service_dispute_events to app_runtime;
revoke all on service_dispute_events from public, anon, authenticated, service_role;

-- 101's append-only guard, by the same function: a decision register that can be edited
-- afterwards is not evidence of anything.
do $$ begin
  create trigger service_dispute_events_no_mutation
    before update or delete on service_dispute_events
    for each row execute function platform_auth.prevent_job_mutation();
exception when others then null;
end $$;

-- ============================================================
-- 3. the refund paper, and the second seat that releases it
-- ============================================================

create table if not exists service_refund_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ref text not null unique check (ref ~ '^RF-[0-9]{4}-[0-9]{5,}$'),
  ticket_id uuid not null references support_tickets(id),
  ticket_ref text not null,
  dispute_id uuid references service_disputes(id),
  company_tenant_id uuid references tenants(id) on delete set null,
  company_name text not null check (char_length(trim(company_name)) between 2 and 140),
  -- Not null and not zero: "refund everything" is written as a figure or not at all, and a zero
  -- paper is how a register ends up with a paid line nobody was owed.
  amount numeric(14,2) not null check (amount > 0 and amount <= 10000000000),
  currency text not null default 'TZS' check (currency in ('TZS','USD')),
  -- How the money goes back. The office keeps mobile money apart from a bank line because the
  -- two are settled by different people, and a credit note is not a refund at all — it is the
  -- paper that says the caller may be owed against the next invoice.
  pay_back text not null check (pay_back in (
    'original_channel','mpesa','telwa','airtel','bank','credit_note')),
  reason text not null check (char_length(trim(reason)) between 8 and 600),
  status text not null default 'raised' check (status in (
    'raised','pending_signature','released','declined','void')),
  raised_by uuid not null references users(id),
  raised_at timestamptz not null default now(),
  -- The signature this paper is waiting on, or was released by. 121's register is the only
  -- place a release can come from, and the trigger in section 7 reads it.
  approval_id uuid references platform_approvals(id),
  released_by uuid references users(id),
  released_at timestamptz,
  declined_by uuid references users(id),
  declined_at timestamptz,
  declined_note text check (declined_note is null
                            or char_length(trim(declined_note)) between 8 and 600),
  void_note text check (void_note is null or char_length(trim(void_note)) between 8 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (char_length(trim(ticket_ref)) between 6 and 40),
  check ((released_by is null) = (released_at is null)),
  check ((declined_by is null) = (declined_at is null)),
  -- A paper cannot claim to be waiting on a signature it never asked for, and cannot claim to
  -- be released without the two names the rule needs.
  check (status <> 'pending_signature' or approval_id is not null),
  check (status <> 'released'
         or (approval_id is not null and released_by is not null and released_at is not null)),
  check (status <> 'declined'
         or (declined_by is not null and declined_at is not null
             and char_length(trim(coalesce(declined_note, ''))) >= 8)),
  check (status <> 'void' or char_length(trim(coalesce(void_note, ''))) >= 8)
);

create index service_refunds_queue on service_refund_requests (tenant_id, status, raised_at desc);
create index service_refunds_ticket on service_refund_requests (ticket_id);
create index service_refunds_dispute on service_refund_requests (dispute_id)
  where dispute_id is not null;

alter table service_refund_requests enable row level security;
create policy service_refunds_tenant on service_refund_requests for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on service_refund_requests to app_runtime;
revoke all on service_refund_requests from public, anon, authenticated, service_role;

-- The dispute's own link now that the paper exists: a settled figure is tied to one paper.
alter table service_disputes
  add constraint service_disputes_refund_paper foreign key (refund_request_id)
  references service_refund_requests(id) on delete set null;

comment on column service_refund_requests.approval_id is
  'The two-person signature this paper stands on. A release without one is refused by trigger.';

-- ============================================================
-- 4. the CSAT, which is asked only after the call is settled
-- ============================================================

create table if not exists service_satisfaction (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- One survey per incidence. A caller who rings twice is unhappy twice, and the second call
  -- gets its own line and its own answer — averaging two answers onto one call would hide the
  -- thing the office needs to see.
  ticket_id uuid not null unique references support_tickets(id),
  ticket_ref text not null,
  asked_by uuid not null references users(id),
  asked_at timestamptz not null default now(),
  asked_channel text not null default 'phone_call' check (asked_channel in (
    'phone_call','whatsapp','email','walk_in','other')),
  -- The answer is the caller's to give, so the whole right-hand half is nullable. A register
  -- that forced an answer would be filled with 3s, and 3 is the number that means nothing.
  answered_at timestamptz,
  score int check (score between 1 and 5),
  word text check (word is null or char_length(trim(word)) between 2 and 600),
  -- The second half of the question the office actually asks on the phone.
  recommends boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The answer comes as a whole: a mark with no time is a row somebody edited, and a time with
  -- no mark says a caller was asked and gave nothing.
  check ((score is null) = (answered_at is null)),
  check (word is null or answered_at is not null),
  check (recommends is null or answered_at is not null),
  -- An answer cannot arrive before the question was asked. Cheap to state, and it is exactly
  -- the kind of row a back-dated import produces.
  check (answered_at is null or answered_at >= asked_at)
);

create index service_satisfaction_board on service_satisfaction (tenant_id, asked_at desc);
create index service_satisfaction_answers on service_satisfaction (score) where score is not null;

alter table service_satisfaction enable row level security;
create policy service_satisfaction_tenant on service_satisfaction for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on service_satisfaction to app_runtime;
revoke all on service_satisfaction from public, anon, authenticated, service_role;

-- Asked only after the call is settled, and about the call that is really on the book.
--
-- Doing this in a trigger rather than in a route is the point of the rule: a desk that asks how
-- satisfied a caller is about a call it has not finished is measuring a promise it has not kept,
-- and the average it publishes afterwards is a number about work in progress. The same statement
-- copies the incidence number and the register's tenant out of the call, so neither can be
-- typed against the wrong line.
create or replace function platform_auth.csat_is_asked_after_the_call()
returns trigger language plpgsql set search_path = public as $$ declare
  v_ref text;
  v_tenant uuid;
  v_status text;
begin
  select t.ref, t.tenant_id, t.status into v_ref, v_tenant, v_status
    from support_tickets t where t.id = new.ticket_id;
  if v_ref is null then
    raise exception 'service_satisfaction: % is not a call on the register',
      new.ticket_id using errcode = '23514';
  end if;
  if v_status not in ('resolved','closed') then
    raise exception
      'service_satisfaction: % is still % - satisfaction is asked after the desk has settled the call',
      v_ref, v_status using errcode = '23514';
  end if;
  new.ticket_ref := v_ref;
  new.tenant_id := v_tenant;
  return new;
end $$;

create trigger service_satisfaction_needs_a_settled_call
  before insert on service_satisfaction
  for each row execute function platform_auth.csat_is_asked_after_the_call();

-- ============================================================
-- 5. the quality review: six things the office says a good call does
-- ============================================================

create table if not exists service_quality_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ticket_id uuid not null references support_tickets(id),
  ticket_ref text not null,
  -- The seat whose handling is graded, and the seat doing the grading. Kept apart in a CHECK
  -- because the office's rule for anything that judges a person is that the person does not do
  -- it: 121 put `decided_by <> proposed_by` on a ban, and a mark a colleague gives themselves
  -- is worth less than no mark at all.
  reviewed_seat uuid not null references users(id),
  reviewed_by uuid not null references users(id),
  reviewed_at timestamptz not null default now(),
  -- The six answers, and nothing else. The key list is held twice on purpose — this CHECK and
  -- the trigger below — so a review that invents a seventh "everything else fine" cannot be
  -- scored at all, and a review that omits one is refused by name.
  checks jsonb not null default '{}'::jsonb,
  score int not null default 0 check (score between 0 and 100),
  result text not null check (result in ('met','partly_met','below')),
  -- The coach's line. Required the moment the mark is short of the promise: `below` with no
  -- sentence tells the seat nothing and cannot be argued with.
  note text check (note is null or char_length(trim(note)) between 8 and 1200),
  check (result = 'met' or char_length(trim(coalesce(note, ''))) >= 8),
  -- The graded seat answers once, in their own words, on the row that carries the mark — so an
  -- appeal can never be read apart from the thing it appeals.
  agent_response text check (agent_response is null
                             or char_length(trim(agent_response)) between 4 and 1200),
  responded_at timestamptz,
  check (responded_at is null or agent_response is not null),
  withdrawn_at timestamptz,
  withdrawn_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (char_length(trim(ticket_ref)) between 6 and 40),
  check (reviewed_seat <> reviewed_by),
  check ((withdrawn_at is null) = (withdrawn_by is null))
);

create index service_quality_reviews_board on service_quality_reviews (tenant_id, reviewed_at desc);
create index service_quality_reviews_seat on service_quality_reviews (reviewed_seat, reviewed_at desc);
-- One reviewer grades a call once. Two marks on one call from one seat is a second attempt at
-- the same number, and this register keeps attempts rather than overwriting them.
create unique index service_quality_reviews_one_per_pair
  on service_quality_reviews (ticket_id, reviewed_by);

alter table service_quality_reviews enable row level security;
create policy service_quality_reviews_tenant on service_quality_reviews for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on service_quality_reviews to app_runtime;
revoke all on service_quality_reviews from public, anon, authenticated, service_role;

-- ============================================================
-- 6. the guards, in SQL
-- ============================================================

-- The six words, named once for the table and once for the trigger that reads them. The desk
-- prints them in this order; verify-service-sql.ts asserts the live constraint still holds
-- exactly this set, because a seventh key would score against six and a renamed one would
-- refuse every review the desk writes.
alter table service_quality_reviews
  drop constraint if exists service_quality_reviews_checks_are_the_six;
alter table service_quality_reviews
  add constraint service_quality_reviews_checks_are_the_six check (
    jsonb_typeof(checks) = 'object'
    and checks ?& array['answered_the_caller','identity_confirmed','right_desk',
                        'action_offered','words_suitable','settled_with_answer']);

-- The paper always names the call it is about, in both registers.
create or replace function platform_auth.service_paper_names_its_call()
returns trigger language plpgsql set search_path = public as $$ begin
  select t.ref, t.tenant_id into new.ticket_ref, new.tenant_id
    from support_tickets t where t.id = new.ticket_id;
  if new.ticket_ref is null then
    raise exception '%: % is not a call on the register',
      TG_TABLE_NAME, new.ticket_id using errcode = '23514';
  end if;
  return new;
end $$;

create trigger service_disputes_names_its_call
  before insert or update of ticket_id on service_disputes
  for each row execute function platform_auth.service_paper_names_its_call();

create trigger service_refunds_names_its_call
  before insert or update of ticket_id on service_refund_requests
  for each row execute function platform_auth.service_paper_names_its_call();

-- A mark always names the call it was earned on, for the same reason and by the same statement:
-- a grade that points at CS-2026-00004 has to be about the incidence numbered that, and the
-- desk that reads the register two years later cannot be asked to trust a typed string.
create trigger service_quality_reviews_names_its_call
  before insert or update of ticket_id on service_quality_reviews
  for each row execute function platform_auth.service_paper_names_its_call();

-- The mark is read out of the six answers, never typed beside them.
--
-- 119's rule for a register that prints a figure: the figure is maintained and a hand-written
-- one cannot survive. Here the same rule decides a person's grade — a seat marked 100 by a
-- reviewer who ticked two boxes is exactly the argument the office would have to settle later,
-- so the score is computed from the checks and the word has to agree with it.
create or replace function platform_auth.quality_mark_is_read_from_its_checks()
returns trigger language plpgsql set search_path = public as $$ declare
  v_true int;
  v_keys text[];
  v_missing text[];
begin
  if jsonb_typeof(new.checks) <> 'object' then
    raise exception 'service_quality_reviews: the six answers must be an object of booleans'
      using errcode = '23514';
  end if;
  select array_agg(k order by k) into v_keys from jsonb_object_keys(new.checks) k;
  if v_keys is distinct from
     (select array_agg(k order by k) from unnest(
        array['answered_the_caller','identity_confirmed','right_desk',
              'action_offered','words_suitable','settled_with_answer']) k)
  then
    -- Name what is wrong rather than printing the whole set: the desk fixes the one word.
    select array_agg(k) into v_missing from unnest(
      array['answered_the_caller','identity_confirmed','right_desk',
            'action_offered','words_suitable','settled_with_answer']) k
      where not (new.checks ? k);
    if coalesce(array_length(v_missing, 1), 0) > 0 then
      raise exception
        'service_quality_reviews: a review answers all six checks - missing %',
        array_to_string(v_missing, ', ') using errcode = '23514';
    end if;
    raise exception
      'service_quality_reviews: a review answers exactly the six named checks - % is not one of them',
      array_to_string((select array_agg(k) from unnest(v_keys) k
                        where k <> 'answered_the_caller' and k <> 'identity_confirmed'
                          and k <> 'right_desk' and k <> 'action_offered'
                          and k <> 'words_suitable' and k <> 'settled_with_answer'),
        ', ') using errcode = '23514';
  end if;
  -- Counted as booleans, not as text: a "true" typed as a string scores nothing and shows up as
  -- a wrong answer rather than as a tick.
  select count(*) into v_true from jsonb_each(new.checks) e where e.value = 'true'::jsonb;
  new.score := round(100.0 * v_true / 6.0)::int;

  -- The bands, stated once. Six checks give marks of 100, 83, 67, 50, 33, 17 or 0, so 80 and 40
  -- fall exactly between them: met is five or six, partly_met three or four, below two or fewer.
  -- A word that contradicts its own ticks is refused rather than quietly re-scaled, because the
  -- ticks are the evidence and the word is only the summary of them.
  if new.result = 'met' and new.score < 80 then
    raise exception
      'service_quality_reviews: the ticks score % - met needs five of the six',
      new.score using errcode = '23514';
  end if;
  if new.result = 'partly_met' and (new.score < 40 or new.score >= 80) then
    raise exception
      'service_quality_reviews: the ticks score % - partly_met is three or four of the six',
      new.score using errcode = '23514';
  end if;
  if new.result = 'below' and new.score >= 40 then
    raise exception
      'service_quality_reviews: the ticks score % - below is two or fewer',
      new.score using errcode = '23514';
  end if;
  return new;
end $$;

create trigger service_quality_reviews_mark
  before insert or update on service_quality_reviews
  for each row execute function platform_auth.quality_mark_is_read_from_its_checks();

-- A mark cannot be re-ticked after the seat has answered it, and an answer is given once.
--
-- The first rule is the one the office would otherwise end up arguing about: an appeal that
-- finishes with the grade changed underneath it is not an appeal. Withdrawing is a door, not a
-- corridor — once a review is off the board it stays off, and a second look is a second review.
create or replace function platform_auth.review_answer_is_kept()
returns trigger language plpgsql set search_path = public as $$ begin
  if old.responded_at is not null
     and (new.checks is distinct from old.checks or new.result is distinct from old.result) then
    raise exception
      'service_quality_reviews: the mark on % was already answered by the seat - a grade is not rewritten under an appeal; withdraw it and raise a new review',
      old.ticket_ref using errcode = '23514';
  end if;
  if old.responded_at is not null and new.agent_response is distinct from old.agent_response then
    raise exception 'service_quality_reviews: a seat answers a mark once (on %)',
      old.ticket_ref using errcode = '23514';
  end if;
  if old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at then
    raise exception 'service_quality_reviews: a withdrawn review stays withdrawn'
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger service_quality_reviews_answer_kept
  before update on service_quality_reviews
  for each row execute function platform_auth.review_answer_is_kept();

-- A dispute upheld, or settled, stands on paper.
--
-- "The office agreed" is the easiest sentence in a register and the hardest one to prove a month
-- later. So the transition into `upheld` or `settled` is refused unless a file is on the dispute
-- — the quotation, the weighing note, the screenshot of the message. It costs the desk one
-- upload and it is the difference between a finding and an opinion.
create or replace function platform_auth.dispute_is_upheld_on_paper()
returns trigger language plpgsql set search_path = public as $$ declare
  v_files int;
begin
  if new.status not in ('upheld','settled') or old.status = new.status then return new; end if;
  -- Live rows only: a photograph taken off the file is still evidence of why it was taken off,
  -- but it is no longer something the desk can show the caller.
  select count(*) into v_files from documents d
    where d.entity_type = 'service_dispute' and d.entity_id = new.id and d.deleted_at is null;
  if v_files = 0 then
    raise exception
      'service_disputes: % cannot be % with nothing on it - file the paper the finding stands on first',
      new.ref, new.status using errcode = '23514';
  end if;
  return new;
end $$;

create trigger service_disputes_upheld_on_paper
  before update on service_disputes
  for each row execute function platform_auth.dispute_is_upheld_on_paper();

-- A settled figure is the same figure as the paper.
--
-- The standing rule for every money register here is that a figure never copies itself from one
-- screen into another column, and that two numbers about one thing must agree. Here the two
-- numbers are the caller's claim and the refund request, and the guard sits at the moment the
-- office closes the argument: `settled` on a claim of 400,000 TZS against a paper for 4,000 TZS
-- is refused, because one of them was typed wrong and the payment would be made from the wrong
-- one.
create or replace function platform_auth.dispute_settles_on_its_figure()
returns trigger language plpgsql set search_path = public as $$ declare
  v_amount numeric;
  v_currency text;
begin
  if new.status <> 'settled' or old.status = new.status then return new; end if;
  if new.amount is null then return new; end if;
  select r.amount, r.currency into v_amount, v_currency
    from service_refund_requests r where r.id = new.refund_request_id;
  if v_amount is null then
    raise exception
      'service_disputes: % was claimed at % % but there is no refund paper to settle it on',
      new.ref, new.amount, new.currency using errcode = '23514';
  end if;
  if v_amount <> new.amount or v_currency is distinct from new.currency then
    raise exception
      'service_disputes: % claims % % and its refund paper says % % - the two figures have to be one sentence before it is settled',
      new.ref, new.amount, new.currency, v_amount, v_currency using errcode = '23514';
  end if;
  return new;
end $$;

create trigger service_disputes_settled_figure
  before update on service_disputes
  for each row execute function platform_auth.dispute_settles_on_its_figure();

-- The decision, once written, is kept. An outcome already signed is not edited and a settled
-- line cannot be argued back open — the second thought gets its own dispute, the way a second
-- call gets its own incidence. The figure is the caller's claim: re-typing it mid-flight would
-- change what is being disputed, and a different number is a different argument.
create or replace function platform_auth.dispute_decision_is_kept()
returns trigger language plpgsql set search_path = public as $$ begin
  if old.decided_at is not null
     and (new.outcome is distinct from old.outcome
          or new.decided_by is distinct from old.decided_by) then
    raise exception
      'service_disputes: % was decided on % - a finding is not rewritten; open a second dispute against it',
      old.ref, old.decided_at::date using errcode = '23514';
  end if;
  if old.status in ('settled','withdrawn') and new.status in ('open','investigating') then
    raise exception
      'service_disputes: % is already % and stays that way - the way back in is a new line',
      old.ref, old.status using errcode = '23514';
  end if;
  if old.amount is not null and new.amount is distinct from old.amount then
    raise exception
      'service_disputes: % was opened at % % - a claim is not re-typed; the new figure belongs in the finding',
      old.ref, old.amount, old.currency using errcode = '23514';
  end if;
  return new;
end $$;

create trigger service_disputes_decision_kept
  before update on service_disputes
  for each row execute function platform_auth.dispute_decision_is_kept();

-- No release without a second seat.
--
-- 121's rule, in the register that pays money out rather than the one that shuts a company: the
-- office's own sentence is "Money, prices, bans and permission changes need a two-person
-- approval", and a refund is money. So the same shape applies — a paper cannot move into
-- `released` unless a real signature stands behind it, raised by one seat and released by
-- another, naming this row. A route that forgets to ask gets an exception from the table, not a
-- quiet release.
--
-- Two facts the ban's trigger had no reason to carry. The seat named on the paper must be the
-- seat that released the signature, so a spent approval cannot be walked around the office to a
-- second paper; and the check runs on INSERT as well as UPDATE, so a row cannot be born already
-- released by whoever writes the next handler.
create or replace function platform_auth.refund_release_needs_two_seats()
returns trigger language plpgsql set search_path = public as $$ declare
  v_signed int;
begin
  if new.status <> 'released' then return new; end if;
  select count(*) into v_signed from platform_approvals a
    where a.id = new.approval_id
      and a.status in ('approved','applied')
      and a.action = 'service.refund'
      and a.target_kind = 'refund_request'
      and a.target_id = new.id::text
      and a.decided_by = new.released_by;
  if v_signed = 0 then
    raise exception
      'service_refund_requests: % cannot be released without a second seat''s signature on this paper (approval_id)',
      new.ref using errcode = '23514';
  end if;
  return new;
end $$;

create trigger service_refunds_two_seats
  before insert or update on service_refund_requests
  for each row execute function platform_auth.refund_release_needs_two_seats();

-- The released paper is kept: the figure, the way back and the call it answers cannot be
-- retyped after the signature, and a declined or void paper is finished. The only thing a
-- release may become is `void` with its own sentence — because a released refund that was never
-- actually paid is exactly what a later audit asks about, and the answer has to be on the row.
create or replace function platform_auth.released_paper_is_kept()
returns trigger language plpgsql set search_path = public as $$ begin
  if old.status in ('released','declined','void')
     and (new.amount is distinct from old.amount or new.currency is distinct from old.currency
          or new.pay_back is distinct from old.pay_back
          or new.ticket_id is distinct from old.ticket_id) then
    raise exception
      'service_refund_requests: % is already % - the paper is not edited; raise a new one',
      old.ref, old.status using errcode = '23514';
  end if;
  if old.status = 'pending_signature' and new.amount is distinct from old.amount then
    raise exception
      'service_refund_requests: % is waiting on a signature for % % - the figure the second seat signed cannot move under it',
      old.ref, old.amount, old.currency using errcode = '23514';
  end if;
  if old.status in ('declined','void') and new.status is distinct from old.status then
    raise exception 'service_refund_requests: % is % and stays %',
      old.ref, old.status, old.status using errcode = '23514';
  end if;
  if old.status = 'released' and new.status not in ('released','void') then
    raise exception 'service_refund_requests: a released paper can only be voided with a reason, not un-released'
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger service_refunds_paper_kept
  before update on service_refund_requests
  for each row execute function platform_auth.released_paper_is_kept();

-- One signature per paper: the same approval cannot be spent on two rows.
create unique index if not exists service_refunds_one_open
  on service_refund_requests (approval_id) where approval_id is not null;

-- ============================================================
-- 7. the doors
-- ============================================================

-- Ask for the second seat on a refund paper.
--
-- The payload is read out of the row, never taken from the request: the bytes the second seat
-- signs are then provably the paper, which is the property 121 bought with `payload_sha256` and
-- is worth more here, where the payload is a figure somebody is about to be paid. The proposer's
-- right to ask for money at all is checked by the route (`control.payments.manage`); who may
-- sign it, and that they are not the proposer, stays inside the register's own CHECKs.
create or replace function platform_auth.propose_refund_release(
  p_request_id uuid,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_actor_ip text,
  p_actor_ua text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_name text;
  v_r service_refund_requests%rowtype;
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

  select * into v_r from service_refund_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_r.status not in ('raised','pending_signature') then
    return jsonb_build_object('status','conflict', 'request_status', v_r.status,
      'message','This paper is finished.');
  end if;
  -- A paper whose window passed can be asked again — that is the only way out of a lapse, since
  -- the register keeps one open proposal per act per target and an expired row is not a
  -- signature anybody can give (121's note on the same trap). A paper whose signature was
  -- REFUSED can be asked too, for the same reason and by the same statement: the second seat's
  -- "no" closes that approval row, and unless the paper could be re-asked it would sit at
  -- `pending_signature` waiting forever on a signature that is already dead. Refusing a paper is
  -- what `decline_refund` is for; asking a second time is what this branch is for. The figure
  -- cannot move while the paper waits, so a re-ask is the same sentence to the same reader and
  -- not a fresh number after a refusal.
  if v_r.status = 'pending_signature' then
    select * into v_a from platform_approvals where id = v_r.approval_id;
    if found and v_a.status not in ('lapsed','rejected') then
      return jsonb_build_object('status','conflict', 'approval_status', v_a.status,
        'open_id', v_a.id,
        'message','This paper already stands open on a signature.');
    end if;
  end if;

  v_payload := jsonb_build_object('request_id', v_r.id, 'ref', v_r.ref,
    'ticket_id', v_r.ticket_id, 'ticket_ref', v_r.ticket_ref,
    'amount', v_r.amount, 'currency', v_r.currency, 'pay_back', v_r.pay_back,
    'company_name', v_r.company_name, 'reason', v_r.reason);
  -- Qualified because pgcrypto lives in `extensions` on this database and a definer that pins
  -- its search path cannot see a bare digest(). 121's lesson, kept.
  v_sha := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');
  v_expiry := now() + interval '7 days';

  -- The nested block turns a two-desks-at-once unique_violation into the same answer as a
  -- deliberate second proposal, naming the signature that already stands.
  begin
    insert into platform_approvals (id, action, target_kind, target_id, payload, payload_sha256,
        reason, status, proposed_by, proposed_role, proposed_ip, proposed_ua, expires_at)
    values (gen_random_uuid(), 'service.refund', 'refund_request', v_r.id::text, v_payload, v_sha,
        v_reason, 'pending', p_actor_user_id, p_actor_role, p_actor_ip,
        left(coalesce(p_actor_ua, ''), 300), v_expiry)
    returning id into v_id;
  exception when unique_violation then
    select a.id into v_open from platform_approvals a
     where a.action = 'service.refund' and a.target_kind = 'refund_request'
       and a.target_id = v_r.id::text and a.status = 'pending'
     order by a.created_at desc limit 1;
    return jsonb_build_object('status','conflict',
      'message','A signature for this paper is already open and waiting for a second seat.',
      'open_id', v_open);
  end;

  update service_refund_requests
     set status = 'pending_signature', approval_id = v_id, updated_at = now()
   where id = v_r.id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, user_agent,
      entity, entity_id, action, before, after)
  values (gen_random_uuid(), v_r.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      left(coalesce(p_actor_ua, ''), 300),
      'service_refund_requests', v_r.id, 'refund.proposed',
      jsonb_build_object('status', v_r.status, 'approval_id', v_r.approval_id),
      jsonb_build_object('ref', v_r.ref, 'amount', v_r.amount, 'currency', v_r.currency,
        'ticket_ref', v_r.ticket_ref, 'reason', v_reason, 'approval_id', v_id,
        'payload_sha256', v_sha, 'status', 'pending_signature', 'expires_at', v_expiry,
        'proposed_name', v_name));

  return jsonb_build_object('status','ok', 'approval_id', v_id, 'action', 'service.refund',
    'target_kind', 'refund_request', 'target_id', v_r.id, 'ref', v_r.ref,
    'amount', v_r.amount, 'currency', v_r.currency, 'payload_sha256', v_sha,
    'request_status', 'pending_signature', 'expires_at', v_expiry);
end $$;

-- Spend the signature the paper was released on.
--
-- Called inside the same transaction as `decide_approval` and `claim_approval`, exactly as the
-- ban's apply step is (121's order: decide -> claim -> apply -> settle). It expects the
-- approval already spent by the seat calling it, and section 6's trigger re-reads the signature
-- from the row — so a handler that skipped the claim finds nothing to spend, and a signature
-- released against a different paper cannot be used here.
create or replace function platform_auth.apply_refund_release(
  p_approval_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_actor_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_a platform_approvals%rowtype;
  v_r service_refund_requests%rowtype;
begin
  select * into v_a from platform_approvals where id = p_approval_id;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_a.action <> 'service.refund' or v_a.target_kind <> 'refund_request' then
    return jsonb_build_object('status','invalid', 'message','That signature is not a refund paper.');
  end if;
  if v_a.status <> 'applied' then
    return jsonb_build_object('status','conflict', 'approval_status', v_a.status,
      'message','The signature was not spent by this call.');
  end if;
  if v_a.decided_by <> p_actor_user_id then
    return jsonb_build_object('status','unauthorised',
      'message','Only the seat that released a signature may spend it.');
  end if;

  select * into v_r from service_refund_requests where id = v_a.target_id::uuid for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_r.status = 'released' then
    return jsonb_build_object('status','conflict', 'request_id', v_r.id, 'ref', v_r.ref,
      'message','This paper was already released by its signature.');
  end if;
  if v_r.status <> 'pending_signature' then
    return jsonb_build_object('status','conflict', 'request_status', v_r.status,
      'message','This paper is not waiting for that signature.');
  end if;

  update service_refund_requests
     set status = 'released', approval_id = v_a.id, released_by = p_actor_user_id,
         released_at = now(), updated_at = now()
   where id = v_r.id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), v_r.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      'service_refund_requests', v_r.id, 'refund.released',
      jsonb_build_object('status', v_r.status, 'raised_by', v_r.raised_by),
      jsonb_build_object('status', 'released', 'ref', v_r.ref, 'amount', v_r.amount,
        'currency', v_r.currency, 'pay_back', v_r.pay_back, 'ticket_ref', v_r.ticket_ref,
        'company_name', v_r.company_name, 'approval_id', v_a.id,
        'raised_by', v_r.raised_by, 'released_by', p_actor_user_id,
        'payload_sha256', v_a.payload_sha256));

  return jsonb_build_object('status','ok', 'request_id', v_r.id, 'ref', v_r.ref,
    'amount', v_r.amount, 'currency', v_r.currency, 'pay_back', v_r.pay_back,
    'ticket_id', v_r.ticket_id, 'ticket_ref', v_r.ticket_ref, 'dispute_id', v_r.dispute_id,
    'company_name', v_r.company_name, 'company_tenant_id', v_r.company_tenant_id,
    'request_status', 'released', 'approval_id', v_a.id,
    'raised_by', v_r.raised_by, 'released_by', p_actor_user_id);
end $$;

-- Refuse the paper. One call, both registers: the signature is answered first and the paper
-- stamped from the answer, so a desk cannot mark a refund declined while the second seat's
-- proposal still stands open waiting to be spent. A paper that never asked is declined by the
-- desk that read it — saying no to money is not the act the two-person rule names.
create or replace function platform_auth.decline_refund(
  p_request_id uuid,
  p_note text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_actor_ip text,
  p_actor_ua text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_name text;
  v_r service_refund_requests%rowtype;
  v_a platform_approvals%rowtype;
  v_note text;
  v_dec jsonb;
begin
  v_name := platform_auth.approval_seat(p_actor_user_id);
  if v_name is null then
    return jsonb_build_object('status','invalid',
      'message','Only a live platform seat can refuse a paper.');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('status','invalid',
      'message','Say why in 8-600 characters: it is the sentence the caller is given.');
  end if;

  select * into v_r from service_refund_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_r.status in ('released','declined','void') then
    return jsonb_build_object('status','conflict', 'request_status', v_r.status,
      'message','This paper is already finished.');
  end if;

  if v_r.approval_id is not null then
    select * into v_a from platform_approvals where id = v_r.approval_id;
    if v_a.status = 'pending' then
      v_dec := platform_auth.decide_approval(v_a.id, 'reject', v_note, p_actor_user_id,
        p_actor_role, p_actor_ip, left(coalesce(p_actor_ua, ''), 300));
      if v_dec ->> 'status' <> 'ok' then return v_dec; end if;
    elsif v_a.status in ('approved','applied') then
      return jsonb_build_object('status','conflict',
        'message','The signature on this paper was released - void the paper with a reason instead.');
    end if;
  end if;

  update service_refund_requests
     set status = 'declined', declined_by = p_actor_user_id, declined_at = now(),
         declined_note = v_note, updated_at = now()
   where id = v_r.id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, user_agent,
      entity, entity_id, action, before, after)
  values (gen_random_uuid(), v_r.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip,
      left(coalesce(p_actor_ua, ''), 300),
      'service_refund_requests', v_r.id, 'refund.declined',
      jsonb_build_object('status', v_r.status, 'amount', v_r.amount,
        'approval_id', v_r.approval_id),
      jsonb_build_object('status', 'declined', 'ref', v_r.ref, 'amount', v_r.amount,
        'currency', v_r.currency, 'note', v_note, 'declined_by', p_actor_user_id,
        'declined_name', v_name));

  return jsonb_build_object('status','ok', 'request_id', v_r.id, 'ref', v_r.ref,
    'amount', v_r.amount, 'currency', v_r.currency, 'request_status', 'declined',
    'note', v_note, 'declined_name', v_name);
end $$;

-- The refund board, with the signature attached.
--
-- The approval register is reachable only through definers (121), so the desk that has to
-- answer "waiting on whom, since when, for what figure" asks here rather than selecting
-- `platform_approvals` from a route that has no business holding that table.
create or replace function platform_auth.service_refunds_board(
  p_tenant_id uuid,
  p_status text,
  p_search text,
  p_limit int,
  p_offset int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_rows jsonb;
  v_counts jsonb;
begin
  select coalesce(jsonb_agg(json_build_object(
      'id', q.id, 'ref', q.ref, 'amount', q.amount, 'currency', q.currency,
      'pay_back', q.pay_back, 'reason', q.reason, 'request_status', q.status,
      'ticket_id', q.ticket_id, 'ticket_ref', q.ticket_ref, 'dispute_id', q.dispute_id,
      'company_name', q.company_name, 'company_tenant_id', q.company_tenant_id,
      'raised_name', q.raised_name, 'raised_at', q.raised_at,
      'approval_id', q.approval_id, 'approval_status', q.approval_status,
      'signed_name', q.signed_name, 'signed_at', q.signed_at,
      'approval_proposed_name', q.approval_proposed_name,
      'approval_expires_at', q.approval_expires_at, 'payload_sha256', q.payload_sha256,
      'released_name', q.released_name, 'released_at', q.released_at,
      'declined_note', q.declined_note, 'void_note', q.void_note, 'total', q.total)
      order by q.raised_at desc), '[]'::jsonb)
    into v_rows
    from (
      select r.id, r.ref, r.amount, r.currency, r.pay_back, r.reason, r.status,
             r.ticket_id, r.ticket_ref, r.dispute_id, r.company_name, r.company_tenant_id,
             r.raised_at, r.approval_id, r.declined_note, r.void_note, r.released_at,
             -- How many papers the filter matched, not how many are on this page: a desk that
             -- pages through 30 of 214 waiting papers has to be able to say the 214.
             count(*) over ()::int as total,
             ru.full_name as raised_name,
             lu.full_name as released_name,
             au.status as approval_status, au.expires_at as approval_expires_at,
             au.payload_sha256, au.decided_at as signed_at,
             du.full_name as signed_name, pu.full_name as approval_proposed_name
        from service_refund_requests r
        left join platform_approvals au on au.id = r.approval_id
        left join users ru on ru.id = r.raised_by
        left join users lu on lu.id = r.released_by
        left join users du on du.id = au.decided_by
        left join users pu on pu.id = au.proposed_by
       where r.tenant_id = p_tenant_id
         and (p_status is null or p_status = 'all' or r.status = p_status)
         and (p_search is null or btrim(p_search) = ''
              or r.ref ilike '%' || btrim(p_search) || '%'
              or r.company_name ilike '%' || btrim(p_search) || '%'
              or r.reason ilike '%' || btrim(p_search) || '%'
              or r.ticket_ref ilike '%' || btrim(p_search) || '%')
       order by r.raised_at desc
       limit least(greatest(coalesce(p_limit, 30), 1), 100)
      offset greatest(coalesce(p_offset, 0), 0)) q;

  -- Totals kept apart by currency, as 118/119 do everywhere else on this platform: a dollar
  -- paper is shown beside a shilling one, never folded into it.
  select jsonb_build_object(
           'raised',   count(*) filter (where status = 'raised'),
           'awaiting', count(*) filter (where status = 'pending_signature'),
           'released', count(*) filter (where status = 'released'),
           'declined', count(*) filter (where status = 'declined'),
           'void',     count(*) filter (where status = 'void'),
           'released_tzs', coalesce(sum(amount) filter (
             where status = 'released' and currency = 'TZS'), 0),
           'released_usd', coalesce(sum(amount) filter (
             where status = 'released' and currency = 'USD'), 0),
           'total', count(*))
    into v_counts
    from service_refund_requests
   where tenant_id = p_tenant_id;

  return jsonb_build_object('rows', coalesce(v_rows, '[]'::jsonb), 'counts', v_counts);
end $$;

-- ============================================================
-- 8. the paper on a dispute
-- ============================================================

-- 125 opened `documents` to the platform's register with 'support_ticket'; a dispute is the same
-- kind of file on the same register, and section 6 makes one of them mandatory before a finding
-- can be upheld. Restated whole, the way 125 restated the channel list.
alter table documents
  drop constraint if exists documents_entity_type_check;
alter table documents
  add constraint documents_entity_type_check check (entity_type in (
    'tenant','user','vessel','driver','trip','shipment','message','licence','employee',
    'office_cost','quotation','cargo_intake','work_order','warehouse_stay','support_ticket',
    'service_dispute'));

-- ============================================================
-- 9. the numbers the desk prints
-- ============================================================

-- One read for the whole Service board: disputes by ground, the satisfaction mean and its
-- response rate, the marks by band, the papers waiting for a signature.
--
-- A definer rather than four statements in a route because the four halves must be measured
-- against the same `now()` and against the same rows — a mean taken before a reload and a count
-- taken after it are the two numbers that always disagree on one page (122's tie, in another
-- shape). The `clock` key is what the desk prints beside them.
create or replace function platform_auth.service_board(p_tenant_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'disputes', coalesce((
      select jsonb_build_object(
        'open', count(*) filter (where s.status = 'open'),
        'investigating', count(*) filter (where s.status = 'investigating'),
        'upheld', count(*) filter (where s.status = 'upheld'),
        'rejected', count(*) filter (where s.status = 'rejected'),
        'settled', count(*) filter (where s.status = 'settled'),
        'withdrawn', count(*) filter (where s.status = 'withdrawn'),
        'awaiting_paper', count(*) filter (where s.status in ('open','investigating')
                                              and coalesce(f.n, 0) = 0),
        'claimed_tzs', coalesce(sum(s.amount) filter (where s.currency = 'TZS'
                                  and s.status in ('open','investigating','upheld','settled')), 0),
        'claimed_usd', coalesce(sum(s.amount) filter (where s.currency = 'USD'
                                  and s.status in ('open','investigating','upheld','settled')), 0))
      from service_disputes s
      left join lateral (
        select count(*)::int as n from documents d
         where d.entity_type = 'service_dispute' and d.entity_id = s.id
           and d.deleted_at is null) f on true
      where s.tenant_id = p_tenant_id and s.deleted_at is null), '{}'::jsonb),
    'satisfaction', coalesce((
      select jsonb_build_object(
        'asked', count(*),
        'answered', count(*) filter (where c.score is not null),
        'mean', round(avg(c.score) filter (where c.score is not null), 2),
        'happy', count(*) filter (where c.score in (4,5)),
        'unhappy', count(*) filter (where c.score in (1,2)),
        'would_recommend', count(*) filter (where c.recommends),
        'open_words', count(*) filter (where c.score is not null and c.word is not null))
      from service_satisfaction c where c.tenant_id = p_tenant_id), '{}'::jsonb),
    'quality', coalesce((
      select jsonb_build_object(
        'reviews', count(*) filter (where q.withdrawn_at is null),
        'met', count(*) filter (where q.result = 'met' and q.withdrawn_at is null),
        'partly_met', count(*) filter (where q.result = 'partly_met'
                                       and q.withdrawn_at is null),
        'below', count(*) filter (where q.result = 'below' and q.withdrawn_at is null),
        'answered', count(*) filter (where q.responded_at is not null
                                     and q.withdrawn_at is null),
        'mean', round(avg(q.score) filter (where q.withdrawn_at is null), 1))
      from service_quality_reviews q where q.tenant_id = p_tenant_id), '{}'::jsonb),
    'refunds', coalesce((
      select jsonb_build_object(
        'raised', count(*) filter (where r.status = 'raised'),
        'awaiting_signature', count(*) filter (where r.status = 'pending_signature'),
        'released', count(*) filter (where r.status = 'released'),
        'declined', count(*) filter (where r.status = 'declined'),
        'void', count(*) filter (where r.status = 'void'),
        'waiting_tzs', coalesce(sum(r.amount) filter (where r.status = 'pending_signature'
                                 and r.currency = 'TZS'), 0),
        'waiting_usd', coalesce(sum(r.amount) filter (where r.status = 'pending_signature'
                                 and r.currency = 'USD'), 0))
      from service_refund_requests r where r.tenant_id = p_tenant_id), '{}'::jsonb),
    'clock', now());
$$;

-- ============================================================
-- 10. three duties, and who is allowed to hold them
-- ============================================================
--
-- `control.service.view` reads the four registers — an analyst asked "how are we doing" needs the
-- numbers without the authority to change any of them. `control.service.manage` opens and
-- settles a dispute, asks the question and files the paper: the queue's own job.
-- `control.service.review` grades a colleague's call and is kept separate from manage on
-- purpose — a seat that can raise a dispute should not also be able to publish a mark on
-- somebody else's work unless the office hands it that key as well.
--
-- Asking for a signature on a refund paper costs the money duty the office already has
-- (`control.payments.manage`, 005) and releasing it costs `control.approvals.decide` — the two
-- keys 121 uses for a ban. No key is invented for money here, and nothing in this section
-- touches `control.approvals.decide`: the seats that can already sign a company out of trading
-- are the seats that may sign money back out of the platform, and widening who can sign a ban
-- would be the price of that shortcut.
insert into permissions (key, description) values
  ('control.service.view',
   'Control - Read the service registers: disputes, satisfaction, quality marks and refund papers'),
  ('control.service.manage',
   'Control - Open and settle a dispute, ask for satisfaction, file the paper, raise a refund'),
  ('control.service.review',
   'Control - Grade how a call was handled and answer an appeal against a mark')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.service.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','customer_service_agent','support_engineer',
                 'compliance_officer','platform_analyst')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.service.manage'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','customer_service_agent','support_engineer')
on conflict do nothing;

-- super_admin, and the two desks that exist to check other people's work. An agent can still
-- grade a colleague — the CHECK that forbids self-grading is the guard, not the role list.
insert into role_permissions (role_id, permission_key)
select r.id, 'control.service.review'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','compliance_officer','customer_service_agent')
on conflict do nothing;

-- ============================================================
-- 11. grants on the doors
-- ============================================================

-- A trigger body is fired, never called: the owner alone holds these (110, 121, 125).
revoke all on function
  platform_auth.csat_is_asked_after_the_call(),
  platform_auth.quality_mark_is_read_from_its_checks(),
  platform_auth.review_answer_is_kept(),
  platform_auth.service_paper_names_its_call(),
  platform_auth.dispute_is_upheld_on_paper(),
  platform_auth.dispute_settles_on_its_figure(),
  platform_auth.dispute_decision_is_kept(),
  platform_auth.refund_release_needs_two_seats(),
  platform_auth.released_paper_is_kept()
from public, anon, authenticated, app_runtime;

grant execute on function
  platform_auth.propose_refund_release(uuid, text, uuid, text, text, text),
  platform_auth.apply_refund_release(uuid, uuid, text, text),
  platform_auth.decline_refund(uuid, text, uuid, text, text, text),
  platform_auth.service_refunds_board(uuid, text, text, int, int),
  platform_auth.service_board(uuid)
to app_runtime;

revoke all on function
  platform_auth.propose_refund_release(uuid, text, uuid, text, text, text),
  platform_auth.apply_refund_release(uuid, uuid, text, text),
  platform_auth.decline_refund(uuid, text, uuid, text, text, text),
  platform_auth.service_refunds_board(uuid, text, text, int, int),
  platform_auth.service_board(uuid)
from public, anon, authenticated, service_role;

-- ============================================================
-- 12. say what this leaves the platform in
-- ============================================================

do $$ declare
  v_disputes int;
  v_papers int;
  v_signed int;
  v_reviewers int;
  v_early int;
begin
  select count(*)::int into v_disputes from service_disputes where deleted_at is null;
  select count(*)::int into v_papers from service_refund_requests;
  select count(*)::int into v_signed from service_refund_requests where status = 'released';
  select count(*)::int into v_early from service_refund_requests
    where status in ('pending_signature','released') and approval_id is null;
  select count(distinct rp.role_id)::int into v_reviewers from role_permissions rp
    join roles r on r.id = rp.role_id
   where rp.permission_key = 'control.service.review' and r.tenant_id is null;
  raise notice '126: the service registers are live — % dispute(s), % refund paper(s), % already '
    'released on a second seat''s signature, % unsigned paper(s) already past a release '
    '(the table refuses such a row, so this must be nought); % role(s) may grade a call',
    v_disputes, v_papers, v_signed, v_early, v_reviewers;
end $$;

commit;
