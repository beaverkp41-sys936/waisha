-- 129 — the copy an account asks for, and the erasure a second seat signs (task #342, part B's
-- last act).
--
-- 128 shipped two of the Customers module's three remaining acts and named the third as the one
-- that could not be written in a hurry. This is it. The spec asks for "GDPR-style export and
-- erasure requests", and the honest version of that sentence has three parts, all of them here:
--
--   a copy   — everything the platform holds about one account, read out of the registers that
--              already exist, as a bundle the office can hand over and the account can keep.
--   an erasure — the categories it may mask, chosen on the paper, signed by a second seat, and
--              applied by the hand that signed.
--   the accounting — what cannot be erased, with the register and the guard that keeps it named
--              in the same record as the erasure. Without this third part, a button labelled
--              "erase" is a lie the platform tells the person it is helping.
--
-- Why an erasure masks and never deletes. The recon walked this schema and counted: 109 tables
-- point at `tenants(id)`, and 114 of those foreign keys are `NO ACTION` — the database refuses to
-- let a company row go while a cargo file, an invoice or a warehouse slip names it. `audit_logs`
-- refuses even an UPDATE by anybody (001's `audit_no_mutation`, and 066 answers a read by
-- redacting rather than by rewriting). 078's action register, 121's signatures, 126's released
-- papers and 127's answered checks are each frozen by a trigger written so that a decision cannot
-- be edited after the fact. Deleting a company would mean disabling all of that. Masking in place
-- means the row stays where the history put it, the person's data stops being recoverable, and
-- every guard above keeps holding. That is also the shape the law describes: erasure of the
-- personal data, retention of the record that the data was erased, and a stated reason for
-- whatever is kept.
--
-- Why the account has to be closed first. An erasure that leaves a live company trading under a
-- tombstoned name would break the platform's own references — the seat that cannot sign in, the
-- invoice that cannot be matched, the file whose consignee is gone. Closing is 078's act and it
-- already needs 121's second signature, so the office's answer to "erase everything" is the same
-- sentence 128 wrote for a duplicate claim: shut the account first, with a second seat, then come
-- back. The refusal says so and names the desk.
--
-- What two seats buy here that they do not buy on a ban. A ban's payload is a reason and a note.
-- An erasure's payload is a **list of categories** — the same ten words the desk ticked — read out
-- of the row and hashed in SQL (121's `payload_sha256`, 126's precedent for a payload the caller
-- cannot type). The seat that signs is therefore signing exactly the categories that get masked,
-- and `apply_data_erasure` will not run for a signature that is not the one it is spending, nor
-- by a hand other than the one that released it. The categories cannot move while the paper waits,
-- because the guard that keeps the paper refuses an edit to the list.
--
-- One rule this file does not bend: nothing here edits a register another migration froze. Not
-- one of the mask statements touches 127's answered checks or notes, 126's papers, 078's actions,
-- 121's signatures or 001's audit rows. Where the office is owed a record — statutory KYC
-- evidence, an invoice, a payroll line — the erasure leaves it and says so in `keeps`, with the
-- count. A desk that has to explain what was kept should not have to go and find out.
--
-- 001's audit register is written by the erasure itself, inside the same transaction as the
-- masking, and carries counts and category names — never the values it destroyed. An audit row
-- that copied the NIDA number it had just erased would undo the act it records.
begin;

-- ============================================================
-- 1. the ten categories an erasure may touch
-- ============================================================
--
-- A closed vocabulary, and one author for it: the CHECK below is the list, the preview reads the
-- columns it names, and the mask statement for a category is the only thing that can write them.
-- `api/src/customers/data-request.ts` exports the same ten words with the labels the desk prints;
-- 129's smoke reads the CHECK out of `pg_constraint` and insists the two still agree, which is
-- how 127's five check kinds and 128's carry list are held to each other.
--
-- The list is deliberately short of two things a caller might expect. Answers the office has
-- already given (`kyc_checks`) and the office's own words (`notes`) are not erasable — 127's
-- guards would refuse the write, and the reason they exist is the reason the erasure should not
-- route around them. Both are in the keeps record instead, with the statute that keeps them.

-- ============================================================
-- 2. the register
-- ============================================================

create sequence if not exists customer_data_request_number_seq;

create table if not exists customer_data_requests (
  id uuid primary key default gen_random_uuid(),
  -- The office's register, as 127 and 128 keep theirs. Never the company's own tenant: a data
  -- request is a record the platform makes about a company, not one the company edits.
  tenant_id uuid not null references tenants(id),
  company_tenant_id uuid not null references tenants(id),
  -- DR-2026-00041. Numbered from the sequence with the year, the way 101's incidences, 109's work
  -- orders and 126's papers are: a caller phones and says a number, not a uuid.
  ref text not null unique check (ref ~ '^DR-[0-9]{4}-[0-9]{5,}$'),
  kind text not null check (kind in ('export','erase')),
  status text not null default 'raised'
    check (status in ('raised','pending_signature','delivered','erased','refused')),
  -- An export is not a menu: Article 15 is a copy of everything, so choosing what to hand over
  -- would be choosing what to withhold, and that decision belongs in the manifest, not in a body.
  -- An erasure IS a menu, because what may be erased is decided category by category. The two
  -- halves of this CHECK are the whole difference between the kinds.
  categories text[] not null default '{}'::text[]
    check ((categories <@ array['account','seats','sessions','profile','contacts','drivers',
                                 'cargo_people','calls','messages','papers'])
      and (kind = 'erase' or categories = '{}'::text[])
      and (kind <> 'erase' or categories <> '{}'::text[])),
  -- Why the office is doing this, in 8-600 characters the second seat reads. Same floor as 121's
  -- reason and 078's note: "gdpr" is not a reason, "director telephoned, cited Article 17, we
  -- verified the caller against the filed TIN" is.
  reason text not null check (char_length(trim(reason)) between 8 and 600),
  -- How the ask reached the desk — a call, an email, a letter handed over the counter. It is a
  -- field rather than a sentence inside `reason` because the office gets asked "how do you know
  -- this person is who they say" and the answer has to be readable off the row.
  asked_in text check (asked_in is null or char_length(trim(asked_in)) between 3 and 80),

  raised_by uuid not null references users(id),
  raised_role text,
  raised_at timestamptz not null default now(),

  -- The signature an erasure is spent on. Set when the paper asks; checked again by the trigger
  -- below when the paper says it was erased.
  approval_id uuid references platform_approvals(id),
  erased_by uuid references users(id),
  erased_at timestamptz,
  -- Rows reached per category, counted by the mask itself, not estimated before it.
  erased jsonb not null default '{}'::jsonb,
  -- What was kept, with the count and the register that keeps it. Written at the same moment.
  keeps jsonb not null default '[]'::jsonb,

  -- The bundle the copy produced. A re-download regenerates the archive, so the facts stamped
  -- here are the *first* hand-over — the one that can be quoted back — and `deliveries` counts
  -- the rest. `bundle_sha256` is of the whole ZIP as it left the API.
  bundle_sha256 text check (bundle_sha256 is null or bundle_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_bytes bigint check (bundle_bytes is null or bundle_bytes between 0 and 1099511627776),
  bundle_entries int check (bundle_entries is null or bundle_entries between 0 and 5000),
  delivered_by uuid references users(id),
  delivered_at timestamptz,
  deliveries int not null default 0 check (deliveries >= 0),

  refused_by uuid references users(id),
  refused_at timestamptz,
  refused_note text check (refused_note is null
                           or char_length(trim(refused_note)) between 8 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The kind decides which statuses the row may hold. A copy is never `pending_signature` — it
  -- asks no second seat — and an erasure is never `delivered`.
  check ((kind = 'export' and status in ('raised','delivered','refused'))
      or (kind = 'erase'  and status in ('raised','pending_signature','erased','refused'))),
  check (status not in ('pending_signature','erased') or approval_id is not null),
  check (erased_at is null or (erased_by is not null and status = 'erased')),
  check (delivered_at is null or (delivered_by is not null and status = 'delivered')),
  check (refused_at is null or (refused_by is not null and status = 'refused'
                                and refused_note is not null)),
  check (company_tenant_id <> tenant_id)
);

-- One open ask per account per kind: a second copy request raised while the first is still
-- unanswered is the same request twice, and a second erasure paper means two signatures that
-- could spend each other's row. Finishing one — delivered, erased or refused — frees the slot,
-- exactly as 121's `approvals_one_open` works for a proposal.
create unique index if not exists customer_data_requests_one_open
  on customer_data_requests (company_tenant_id, kind)
  where status in ('raised','pending_signature');
create index if not exists customer_data_requests_register
  on customer_data_requests (tenant_id, raised_at desc);
create index if not exists customer_data_requests_account
  on customer_data_requests (company_tenant_id, raised_at desc);
create index if not exists customer_data_requests_queue
  on customer_data_requests (kind, status, raised_at desc);
-- One paper, one signature — as 126's index on a refund paper. Two requests spending the same
-- signature is the double-spend this stops at the index level rather than in a handler.
create unique index if not exists customer_data_requests_one_approval
  on customer_data_requests (approval_id) where approval_id is not null;

drop trigger if exists trg_customer_data_requests_updated on customer_data_requests;
create trigger trg_customer_data_requests_updated before update on customer_data_requests
  for each row execute function public.set_updated_at();

alter table customer_data_requests enable row level security;
drop policy if exists customer_data_requests_tenant on customer_data_requests;
create policy customer_data_requests_tenant on customer_data_requests for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Insert and update only, no delete: a refused request and an erased one are both the record that
-- the office answered a data subject, which is the thing a supervisory authority asks to see.
grant select, insert, update on customer_data_requests to app_runtime;
revoke all on customer_data_requests from public, anon, authenticated, service_role;

comment on column customer_data_requests.categories is
  'The erasure menu, frozen at the raise. 121 hashes the payload that carries it, so the second seat signs these words and no others.';
comment on column customer_data_requests.keeps is
  'What the erasure did not erase, counted, with the register and the ground that keep it. Written by the mask, never typed.';
comment on column customer_data_requests.erased is
  'Rows reached per category, counted by the statements that reached them.';

-- ============================================================
-- 3. the guards
-- ============================================================
--
-- Three, for the three ways this register could be made to say something that did not happen: an
-- ask aimed at the wrong account, a signed list edited afterwards, an erasure with no signature
-- behind it. Each is in the database because 128's lesson is that the fourth route somebody
-- writes in a hurry is the one that forgets.

create or replace function platform_auth.data_request_names_a_closed_account()
returns trigger language plpgsql set search_path = public as $$ declare
  v_lost tenants;
  v_reg text;
begin
  select t.type into v_reg from tenants t where t.id = new.tenant_id;
  if v_reg is null or v_reg <> 'platform' then
    raise exception 'customer_data_requests: a data request is kept on the office''s own register'
      using errcode = '23514';
  end if;

  select * into v_lost from tenants where id = new.company_tenant_id;
  if v_lost.id is null then
    raise exception 'customer_data_requests: no account %', new.company_tenant_id::text
      using errcode = '23503';
  end if;
  if v_lost.type = 'platform' then
    raise exception 'customer_data_requests: the office does not make requests about itself'
      using errcode = '23514';
  end if;
  -- A copy may be asked for a live account — that is the ordinary case, and it destroys nothing.
  -- An erasure may not, and says where to go instead of just refusing.
  if new.kind = 'erase' and v_lost.deleted_at is null then
    raise exception 'customer_data_requests: % is still a live account. An erasure masks the name '
      'the platform''s own files point at, so the account has to be closed first, and closing is a '
      'two-seat act on the tenants desk — raise it there, bring the second signature, then ask '
      'here', v_lost.name using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists customer_data_request_names_a_closed_account on customer_data_requests;
create trigger customer_data_request_names_a_closed_account
  before insert or update on customer_data_requests
  for each row execute function platform_auth.data_request_names_a_closed_account();

-- The paper is kept. Everything the second seat was shown — the account, the kind, the category
-- list, the reason, the hand and the hour — is refused on the way past, so a signature cannot be
-- spent on a paper that changed under it. The states a row may move through, and the stamps each
-- one must arrive with, are the rest of this function.
create or replace function platform_auth.data_request_is_kept_not_rewritten()
returns trigger language plpgsql set search_path = public as $$ begin
  if new.company_tenant_id is distinct from old.company_tenant_id
     or new.kind is distinct from old.kind
     or new.ref is distinct from old.ref
     or new.raised_by is distinct from old.raised_by
     or new.raised_at is distinct from old.raised_at
     or new.categories is distinct from old.categories
     or new.reason is distinct from old.reason
     or new.asked_in is distinct from old.asked_in then
    raise exception 'customer_data_requests: % was raised at % on % and the list it signed is kept '
      '— refuse it and raise another', old.ref, old.raised_at, old.kind
      using errcode = '23514';
  end if;
  -- A copy's first hand-over is the record. A second download may differ byte for byte (the
  -- manifest carries its own timestamp), so it counts rather than restamping.
  if old.bundle_sha256 is not null
     and (new.bundle_sha256 is distinct from old.bundle_sha256
          or new.bundle_bytes is distinct from old.bundle_bytes
          or new.bundle_entries is distinct from old.bundle_entries) then
    raise exception 'customer_data_requests: % was handed over once and its bundle facts are kept',
      old.ref using errcode = '23514';
  end if;
  if old.deliveries > new.deliveries then
    raise exception 'customer_data_requests: % has been handed over % time(s); the count does not go '
      'back', old.ref, old.deliveries using errcode = '23514';
  end if;
  if old.status = 'erased' then
    raise exception 'customer_data_requests: % is erased. An erasure is not undone by editing the '
      'row that records it — the data is gone and this register is the proof it was'
      , old.ref using errcode = '23514';
  end if;
  if old.status in ('delivered','refused')
     and new.status is distinct from old.status then
    raise exception 'customer_data_requests: % is % and stays %', old.ref, old.status, old.status
      using errcode = '23514';
  end if;
  -- A signature cannot be swapped while the paper waits, and the stamps have to arrive whole.
  if old.approval_id is not null and new.approval_id is distinct from old.approval_id then
    raise exception 'customer_data_requests: % already stands open on a signature; refuse the paper '
      'rather than aim it at another', old.ref using errcode = '23514';
  end if;
  if new.status = 'pending_signature'
     and (new.approval_id is null or old.status <> 'raised') then
    raise exception 'customer_data_requests: % cannot wait on a signature it was not given', old.ref
      using errcode = '23514';
  end if;
  if new.status = 'erased'
     and (new.erased_at is null or new.erased_by is null
          or coalesce(new.erased, '{}'::jsonb) = '{}'::jsonb
          or coalesce(new.keeps, '[]'::jsonb) = '[]'::jsonb) then
    raise exception 'customer_data_requests: an erasure arrives with the hand, the hour, the counts '
      'it reached and the list of what it kept' using errcode = '23514';
  end if;
  if new.status = 'delivered'
     and (new.delivered_at is null or new.delivered_by is null) then
    raise exception 'customer_data_requests: a copy that says it was handed over names the hand and '
      'the hour' using errcode = '23514';
  end if;
  if new.status = 'refused'
     and (new.refused_at is null or new.refused_by is null
          or char_length(trim(coalesce(new.refused_note, ''))) < 8) then
    raise exception 'customer_data_requests: refusing a data subject needs the same sentence as '
      'granting it' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists customer_data_request_is_kept_not_rewritten on customer_data_requests;
drop trigger if exists customer_data_request_is_kept_not_rewritten on customer_data_requests;
create trigger customer_data_request_is_kept_not_rewritten
  before update on customer_data_requests
  for each row execute function platform_auth.data_request_is_kept_not_rewritten();

-- The same rule 126 put on a released refund paper, in the register where an erasure is written:
-- a row may only say `erased` if a real, matching, *spent* second signature stands behind it, and
-- the hand that erased is the hand that signed.
--
-- This trigger is the reason the route cannot get this wrong. A handler that set the status by
-- hand — without `claim_approval`, without a proposal, with its own id in `erased_by` — would be
-- writing an erasure that no second seat agreed to, into a register whose whole purpose is to be
-- able to say otherwise.
create or replace function platform_auth.data_erase_needs_two_seats()
returns trigger language plpgsql set search_path = public as $$ declare
  v_a platform_approvals%rowtype;
begin
  if new.status <> 'erased' then return new; end if;
  if new.approval_id is null then
    raise exception 'customer_data_requests: % cannot be erased without a second seat''s signature '
      'on this paper (approval_id is null)', new.ref using errcode = '23514';
  end if;
  select * into v_a from platform_approvals where id = new.approval_id;
  if not found then
    raise exception 'customer_data_requests: % names approval % and there is no such signature',
      new.ref, new.approval_id::text using errcode = '23514';
  end if;
  if not (v_a.action = 'customer.erase' and v_a.target_kind = 'data_request'
          and v_a.target_id = new.id::text and v_a.status = 'applied'
          and v_a.decided_by = new.erased_by) then
    raise exception 'customer_data_requests: % is not erased on its own spent signature: the paper '
      'must be a customer.erase against this request, applied, and released by the hand that erased '
      '(approval % is action %/%, status %, signed by %)',
      new.ref, v_a.id::text, v_a.action, v_a.target_kind, v_a.status,
      coalesce(v_a.decided_by::text, 'nobody') using errcode = '23514';
  end if;
  -- The bytes that were signed are the bytes that were run. The payload carries the category list
  -- as a sorted array; a paper whose list no longer matches was not the one this signature gave.
  if coalesce(v_a.payload -> 'categories', '[]'::jsonb)
     <> to_jsonb(array(select unnest(new.categories) order by 1)) then
    raise exception 'customer_data_requests: % was signed for [%] and is being erased for [%]',
      new.ref,
      coalesce((select string_agg(t, ', ') from unnest(
        array(select jsonb_array_elements_text(v_a.payload -> 'categories'))) t), ''),
      coalesce((select string_agg(t, ', ') from unnest(new.categories) t), '')
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists customer_data_requests_two_seats on customer_data_requests;
drop trigger if exists customer_data_requests_two_seats on customer_data_requests;
create trigger customer_data_requests_two_seats
  before insert or update on customer_data_requests
  for each row execute function platform_auth.data_erase_needs_two_seats();

-- ============================================================
-- 4. the preview: what would be masked, and what is kept whatever the desk ticks
-- ============================================================
--
-- This is the read the desk shows twice: before the paper is raised, so the office knows what it
-- is promising, and again beside the signature, so the second seat is not asked to sign a word it
-- cannot see the shape of. It is also the migration gate's proof that every column the mask
-- writes exists: each category counts on the columns its own UPDATE will set, so a typo here is a
-- failed migration rather than a failed erasure two weeks later.
create or replace function platform_auth.data_request_preview(
  p_company uuid, p_kind text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v tenants;
  v_masks jsonb := '[]'::jsonb;
  v_keeps jsonb := '[]'::jsonb;
  v_live int;
begin
  select * into v from tenants where id = p_company;
  if v.id is null then
    return jsonb_build_object('status', 'not_found', 'company_id', p_company);
  end if;
  if v.type = 'platform' then
    return jsonb_build_object('status', 'invalid', 'message',
      'The office does not make data requests about itself. Its staff records are on the staff desk.');
  end if;
  if p_kind not in ('export','erase') then
    return jsonb_build_object('status', 'invalid', 'message',
      'A data request is either a copy (export) or an erasure (erase).');
  end if;

  -- Each block below counts on the columns the matching UPDATE in section 6 writes. The counts are
  -- what the desk prints beside the category name; it is the reason the copy is worth asking for.
  select jsonb_build_object('account', jsonb_build_object(
      'rows', 1,
      'name_copies', (select count(*)::int from (
                        select 1 from company_profiles c where c.tenant_id = v.id
                        union all select 1 from support_tickets s
                           where s.company_tenant_id = v.id
                        union all select 1 from service_disputes d
                           where d.company_tenant_id = v.id
                        union all select 1 from service_refund_requests r
                           where r.company_tenant_id = v.id
                        union all select 1 from subscription_cancellations c
                           where c.tenant_id = v.id
                        union all select 1 from directory_listings l
                           where l.tenant_id = v.id) n),
      'with_tin', (case when v.tin_encrypted is null then 0 else 1 end),
      'with_phone', (case when v.phone_encrypted is null then 0 else 1 end),
      'with_email', (case when v.email is null then 0 else 1 end),
      'with_slug', (case when v.slug is null then 0 else 1 end)))
    into v_masks;
  v_masks := v_masks || jsonb_build_object(
    'seats', (select jsonb_build_object('rows', count(*)::int,
              'with_email', count(*) filter (where email is not null)::int,
              'with_phone', count(*) filter (where phone_encrypted is not null)::int,
              'with_nida', count(*) filter (where nida_encrypted is not null)::int,
              'with_totp', count(*) filter (where totp_secret_encrypted is not null)::int,
              'active', count(*) filter (where status = 'active' and deleted_at is null)::int)
              from users u
             where u.tenant_id = v.id and u.user_type <> 'platform'),
    'sessions', (select jsonb_build_object('rows', count(*)::int,
              'live', count(*) filter (where revoked_at is null)::int,
              'with_ip', count(*) filter (where ip is not null)::int,
              'with_device', count(*) filter (where user_agent is not null)::int)
              from sessions s where s.tenant_id = v.id),
    'profile', (select jsonb_build_object('rows', count(*)::int,
              'with_tin', count(*) filter (where tin_display is not null)::int,
              'with_brela', count(*) filter (where brela_number is not null)::int,
              'with_vat', count(*) filter (where vat_number is not null)::int,
              'with_licence', count(*) filter (where transport_licence_no is not null)::int,
              'with_pay_bank', count(*) filter (where pay_bank_account is not null)::int,
              'with_pay_mobile', count(*) filter (where pay_mobile_money is not null)::int)
              from company_profiles c where c.tenant_id = v.id)
              || (select jsonb_build_object('listings', count(*)::int,
                    'withdrawn_from_board', count(*) filter (where status = 'live')::int,
                    'with_contact', count(*) filter (where contact_channel is not null)::int)
                    from directory_listings l where l.tenant_id = v.id),
    'contacts', (select jsonb_build_object('rows', count(*)::int,
              'with_email', count(*) filter (where email is not null)::int,
              'with_phone', count(*) filter (where phone_encrypted is not null)::int,
              'with_tin', count(*) filter (where tin is not null)::int,
              'with_address', count(*) filter (where address is not null)::int)
              from clients c where c.tenant_id = v.id)
              || jsonb_build_object('offices', (select count(*)::int from branches b
                                                 where b.tenant_id = v.id
                                                   and b.deleted_at is null)),
    'drivers', (select jsonb_build_object('rows', count(*)::int,
              'with_nida', count(*) filter (where nida_encrypted is not null)::int,
              'with_phone', count(*) filter (where phone_encrypted is not null)::int,
              'with_dob', count(*) filter (where date_of_birth is not null)::int,
              'with_next_of_kin', count(*) filter (where next_of_kin is not null)::int)
              from drivers d where d.tenant_id = v.id),
    'cargo_people', (select jsonb_build_object('rows', count(*)::int,
              'with_consignee', count(*) filter (where consignee_name is not null)::int,
              'with_consignor', count(*) filter (where consignor_name is not null)::int,
              'with_notes', count(*) filter (where notes is not null)::int)
              from cargo_shipments c where c.tenant_id = v.id),
    'calls', (select jsonb_build_object('rows', count(*)::int,
              'with_reporter_name', count(*) filter (where reporter_name is not null)::int,
              'with_reporter_email', count(*) filter (where reporter_email is not null)::int,
              'with_reporter_phone', count(*) filter (where reporter_phone_encrypted is not null)::int,
              'with_words', count(*) filter (where body is not null)::int,
              'with_resolution', count(*) filter (where resolution is not null)::int)
              from support_tickets s where s.company_tenant_id = v.id),
    'messages', (select jsonb_build_object('rows', count(*)::int,
              'with_words', count(*) filter (where body is not null)::int)
              from messages m where m.tenant_id = v.id),
    'papers', (select jsonb_build_object('rows', count(*)::int,
              'with_names', count(*) filter (where file_name is not null)::int)
              from documents d
             where d.deleted_at is null
               and ((d.entity_type = 'tenant' and d.entity_id = v.id)
                 or (d.entity_type = 'shipment' and exists (select 1 from cargo_shipments c
                          where c.id = d.entity_id and c.tenant_id = v.id))
                 or (d.entity_type = 'driver' and exists (select 1 from drivers r
                          where r.id = d.entity_id and r.tenant_id = v.id))
                 or (d.entity_type = 'message' and exists (select 1 from messages m
                          where m.id = d.entity_id and m.tenant_id = v.id))
                 or (d.entity_type = 'support_ticket' and exists (select 1 from support_tickets s
                          where s.id = d.entity_id and s.company_tenant_id = v.id)))));

  -- What stays whatever the desk ticks, with the count and the thing that keeps it. This is built
  -- here rather than in a page of documentation so that the erasure's own record and the screen
  -- the signature is read from carry the same words.
  select jsonb_build_array(
    jsonb_build_object('key', 'kyc_checks', 'label', 'The checks the office answered',
      'rows', (select count(*)::int from customer_verifications c
                 where c.company_tenant_id = v.id),
      'because', '127 freezes an answered check''s number, its expiry and its paper so that a '
        'decision once taken cannot be rewritten, and keeps every line on a closed account; '
        'KYC evidence is also held under Tanzania''s anti-money-laundering record-keeping duty.'),
    jsonb_build_object('key', 'office_notes', 'label', 'The office''s notes on the account',
      'rows', (select count(*)::int from customer_notes n
                 where n.company_tenant_id = v.id and n.voided_at is null),
      'because', '127 keeps a note and its author — a note is withdrawn with a reason, never '
        'rewritten. The author is a colleague''s record, not the account''s to erase.'),
    jsonb_build_object('key', 'labels', 'label', 'Labels on the account',
      'rows', (select count(*)::int from customer_taggings t
                 where t.company_tenant_id = v.id and t.deleted_at is null),
      'because', 'a label is the office''s own queue, withdrawn rather than deleted (127).'),
    jsonb_build_object('key', 'money', 'label', 'Invoices, payments and tax records',
      'rows', (select count(*)::int from invoices i where i.tenant_id = v.id
                 and i.deleted_at is null)
             + (select count(*)::int from payments p where p.tenant_id = v.id)
             + (select count(*)::int from tax_returns t where t.tenant_id = v.id),
      'because', 'a billing and tax record is kept by law after the account closes; it outlives '
        'the request. Payments carry the payer''s phone as a search value only after the erasure '
        'of the seat that paid.'),
    jsonb_build_object('key', 'service_papers', 'label', 'Disputes and refund papers',
      'rows', (select count(*)::int from service_disputes d
                 where d.company_tenant_id = v.id and d.deleted_at is null)
             + (select count(*)::int from service_refund_requests r
                  where r.company_tenant_id = v.id),
      'because', '126 keeps a paper once it is decided or released — the figure a second seat '
        'signed is not editable afterwards. The account''s name on them is masked with the '
        'account; the finding is not.'),
    jsonb_build_object('key', 'actions', 'label', 'Blocks, closures and notices (078)',
      'rows', (select count(*)::int from tenant_actions a where a.tenant_id = v.id),
      'because', 'the register of what the office did to the account is the account''s proof of '
        'why it was stopped; erasing it would leave a closure no one can explain.'),
    jsonb_build_object('key', 'signatures', 'label', 'Second-seat signatures (121)',
      'rows', (select count(*)::int from platform_approvals a
                 where a.target_kind = 'tenant' and a.target_id = v.id::text
                    or a.target_kind = 'data_request'
                   and a.target_id in (select r.id::text from customer_data_requests r
                                        where r.company_tenant_id = v.id)),
      'because', 'a signature is the record of who agreed to what; 121 keeps it and 001''s audit '
        'register keeps the decision beside it.'),
    jsonb_build_object('key', 'claims', 'label', 'Duplicate claims (128)',
      'rows', (select count(*)::int from customer_duplicate_claims c
                 where c.loser_tenant_id = v.id or c.survivor_tenant_id = v.id),
      'because', 'a claim names two accounts and what moved between them; 128 keeps it, voided or '
        'not, as the record of the office''s decision.'),
    jsonb_build_object('key', 'call_events', 'label', 'The office''s moves on each call',
      'rows', (select count(*)::int from support_ticket_events e
                 where e.ticket_id in (select s.id from support_tickets s
                                        where s.company_tenant_id = v.id)),
      'because', '042/125 make this log append-only — it is the register that answers "who moved '
        'this call, when, from which desk to which".'),
    jsonb_build_object('key', 'paper_bytes', 'label', 'The stored files themselves',
      'rows', (select count(*)::int from documents d
                 where d.deleted_at is null and d.entity_type = 'tenant'
                   and d.entity_id = v.id),
      'because', 'the register row is masked here; the bytes in storage are destroyed by the '
        'retention sweep, which needs the storage key and is a separate, logged act. The path is '
        'kept so that the file can still be found and destroyed.'),
    jsonb_build_object('key', 'counterparty_papers', 'label', 'Other companies'' files naming this one',
      'rows', (select count(*)::int from transport_requests t
                 where t.company_name = v.name or t.booked_company_name = v.name)
             + (select count(*)::int from transport_bookings b where b.company_name = v.name),
      'because', 'a booking or a request is the counterparty''s record of a trade that happened; '
        'erasing the name there would destroy someone else''s file.'),
    jsonb_build_object('key', 'audit', 'label', 'The audit register (001)',
      'rows', (select count(*)::int from (select 1 from audit_logs a
                   where a.tenant_id = v.id limit 5000) x),
      'because', 'audit_logs is append-only to everybody including its owner, and 066 redacts a '
        'read rather than rewriting a row. Counted to 5000. This erasure writes its own row here.')
  ) into v_keeps;

  v_live := (select count(*)::int from sessions s
               where s.tenant_id = v.id and s.revoked_at is null);

  return jsonb_build_object(
    'status', 'ok',
    'kind', p_kind,
    'company', jsonb_build_object('id', v.id, 'name', v.name, 'type', v.type,
      'account_status', v.status, 'closed_at', v.deleted_at),
    'eligible', (v.deleted_at is not null or p_kind = 'export'),
    'refusal', case
      when p_kind = 'erase' and v.deleted_at is null
        then v.name || ' is still a live account. Closing it is a two-seat act on the tenants '
          'desk — shut it there, bring the second signature back, and the erasure can be raised.'
      else null end,
    'masks', v_masks,
    'keeps', v_keeps,
    'sessions_live', v_live,
    'clock', now());
end $$;

-- ============================================================
-- 5. the raise
-- ============================================================
--
-- One definer for both kinds, because the row is the same row and the difference is a CHECK, not
-- a code path. Nothing is read out and handed back as a promise: the counts the desk saw came
-- from the preview, and the counts the erasure reports come from the mask.
create or replace function platform_auth.raise_data_request(
  p_register uuid, p_company uuid, p_kind text, p_categories text[],
  p_reason text, p_asked_in text, p_actor uuid, p_role text, p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_reg text;
  v_company tenants;
  v_cats text[];
  v_reason text;
  v_id uuid;
  v_open uuid;
  v_ref text;
begin
  select t.type into v_reg from tenants t where t.id = p_register;
  if v_reg is null or v_reg <> 'platform' then
    return jsonb_build_object('status', 'invalid', 'message',
      'A data request is kept on the office''s own register. This session is not one.');
  end if;
  if p_kind not in ('export','erase') then
    return jsonb_build_object('status', 'invalid', 'message',
      'A data request is either a copy (export) or an erasure (erase).');
  end if;

  select * into v_company from tenants where id = p_company;
  if v_company.id is null then
    return jsonb_build_object('status', 'not_found', 'company_id', p_company);
  end if;
  if v_company.type = 'platform' then
    return jsonb_build_object('status', 'invalid', 'message',
      'The office does not make data requests about itself. Its staff records are on the staff desk.');
  end if;
  if p_company = p_register then
    return jsonb_build_object('status', 'invalid', 'message',
      'A request cannot be filed on the register it is filed to.');
  end if;
  if p_kind = 'erase' and v_company.deleted_at is null then
    return jsonb_build_object('status', 'invalid', 'message',
      v_company.name || ' is still a live account. An erasure masks the name the platform''s own '
      || 'files point at, so the account is closed first — and closing is a two-seat act on the '
      || 'tenants desk. Raise that, bring the second signature, then ask here.');
  end if;

  -- The copy takes no list; the erasure must have one, and only the ten words this file knows.
  v_cats := case when p_kind = 'erase'
                 then coalesce((select array_agg(distinct k order by k)
                                  from unnest(coalesce(p_categories, '{}'::text[])) k
                                 where k in ('account','seats','sessions','profile','contacts',
                                             'drivers','cargo_people','calls','messages','papers')),
                               '{}'::text[])
                 else '{}'::text[] end;
  if p_kind = 'erase' and v_cats = '{}'::text[] then
    return jsonb_build_object('status', 'invalid', 'message',
      'An erasure has to name what it erases. Nothing at all is a refusal, and a refusal is its '
      || 'own answer with its own reason.');
  end if;
  if p_kind = 'export' and coalesce(array_length(p_categories, 1), 0) > 0 then
    return jsonb_build_object('status', 'invalid', 'message',
      'A copy is not a menu: it carries everything the registers hold, and says in its manifest '
      || 'what each part withheld. Choosing the parts would be choosing what to hide.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('status', 'invalid', 'message',
      'The reason must be 8-600 characters: it is the sentence the second seat reads, and the one '
      || 'quoted back if this is ever asked about.');
  end if;

  v_ref := 'DR-' || to_char(now(), 'YYYY') || '-'
    || lpad(nextval('customer_data_request_number_seq')::text, 5, '0');

  -- Two desks raising the same ask in the same second: the partial unique index is the answer,
  -- and the desk gets the number of the request that already stands rather than a rollback.
  begin
    insert into customer_data_requests
        (tenant_id, company_tenant_id, ref, kind, categories, reason, asked_in,
         raised_by, raised_role)
    values (p_register, p_company, v_ref, p_kind, v_cats, v_reason,
            nullif(trim(coalesce(p_asked_in, '')), ''), p_actor, p_role)
      returning id into v_id;
  exception when unique_violation then
    select r.id into v_open from customer_data_requests r
     where r.company_tenant_id = p_company and r.kind = p_kind
       and r.status in ('raised','pending_signature')
     order by r.raised_at desc limit 1;
    return jsonb_build_object('status', 'conflict', 'open_id', v_open,
      'message', 'That account already has an open ' || p_kind
        || ' request. Finish it — hand the copy over, erase it, or refuse it — before raising '
        || 'another.');
  end;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), p_register, p_actor, p_role, p_ip,
      'customer_data_requests', v_id, 'data_request.raised',
      '{}'::jsonb,
      jsonb_build_object('ref', v_ref, 'kind', p_kind,
        'company_tenant_id', p_company, 'company_name', v_company.name,
        'categories', v_cats, 'reason', v_reason,
        'asked_in', nullif(trim(coalesce(p_asked_in, '')), '')));

  return jsonb_build_object('status', 'ok', 'request', platform_auth.data_request_detail(v_id),
    'preview', platform_auth.data_request_preview(p_company, p_kind));
end $$;

-- ============================================================
-- 6. the two-seat door
-- ============================================================
--
-- 126's pattern, kept exactly: the payload is read out of the row and hashed in SQL, so what the
-- second seat signs is provably this paper — the account, the closed date, and the category list.
-- The desk cannot type a payload, and a payload reordered by a different client hashes the same
-- because the array is sorted on the way in.
create or replace function platform_auth.propose_data_erasure(
  p_request_id uuid, p_reason text, p_actor uuid, p_role text, p_actor_ip text, p_actor_ua text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_name text;
  v_r customer_data_requests%rowtype;
  v_a platform_approvals%rowtype;
  v_company tenants;
  v_reason text;
  v_payload jsonb;
  v_sha text;
  v_expiry timestamptz;
  v_id uuid;
  v_open uuid;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('status', 'invalid', 'message',
      'Only a live platform seat can ask for a signature.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('status', 'invalid', 'message',
      'The reason must be 8-600 characters: it is the sentence the second seat signs.');
  end if;

  select * into v_r from customer_data_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_r.kind <> 'erase' then
    return jsonb_build_object('status', 'invalid', 'message',
      'A copy asks no second seat: it hands over what the account already holds. Only an erasure '
      || 'is signed.');
  end if;
  if v_r.status not in ('raised','pending_signature') then
    return jsonb_build_object('status', 'conflict', 'request_status', v_r.status,
      'message', 'This paper is finished.');
  end if;
  -- The account has to still be the closed one the guard accepted at the raise. A request raised
  -- the day an account was reopened would otherwise sign an erasure of a trading company.
  select * into v_company from tenants where id = v_r.company_tenant_id;
  if v_company.deleted_at is null then
    return jsonb_build_object('status', 'conflict', 'message',
      v_company.name || ' is trading again. An erasure is not raised against a live account — '
      || 'close it on the tenants desk with a second signature first.');
  end if;
  -- A lapsed or refused signature is not a signature anybody can give, so the paper has to be
  -- able to ask again — 126's branch for the same trap, and the same reason.
  if v_r.status = 'pending_signature' then
    select * into v_a from platform_approvals where id = v_r.approval_id;
    if found and v_a.status not in ('lapsed','rejected') then
      return jsonb_build_object('status', 'conflict', 'approval_status', v_a.status,
        'open_id', v_a.id,
        'message', 'This paper already stands open on a signature.');
    end if;
  end if;

  v_payload := jsonb_build_object('request_id', v_r.id, 'ref', v_r.ref,
    'kind', v_r.kind, 'register_tenant_id', v_r.tenant_id,
    'company_tenant_id', v_r.company_tenant_id, 'company_name', v_company.name,
    'closed_at', v_company.deleted_at, 'categories',
    (select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
       from unnest(v_r.categories) k));
  v_sha := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');
  v_expiry := now() + interval '7 days';

  begin
    insert into platform_approvals (id, action, target_kind, target_id, payload, payload_sha256,
        reason, status, proposed_by, proposed_role, proposed_ip, proposed_ua, expires_at)
    values (gen_random_uuid(), 'customer.erase', 'data_request', v_r.id::text, v_payload, v_sha,
        v_reason, 'pending', p_actor, p_role, p_actor_ip,
        left(coalesce(p_actor_ua, ''), 300), v_expiry)
      returning id into v_id;
  exception when unique_violation then
    select a.id into v_open from platform_approvals a
     where a.action = 'customer.erase' and a.target_kind = 'data_request'
       and a.target_id = v_r.id::text and a.status = 'pending'
     order by a.created_at desc limit 1;
    return jsonb_build_object('status', 'conflict', 'open_id', v_open,
      'message', 'A signature for this paper is already open and waiting for a second seat.');
  end;

  update customer_data_requests
     set status = 'pending_signature', approval_id = v_id, updated_at = now()
   where id = v_r.id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, user_agent,
      entity, entity_id, action, before, after)
  values (gen_random_uuid(), v_r.tenant_id, p_actor, p_role, p_actor_ip,
      left(coalesce(p_actor_ua, ''), 300),
      'customer_data_requests', v_r.id, 'data_request.erasure_proposed',
      jsonb_build_object('status', v_r.status, 'approval_id', v_r.approval_id),
      jsonb_build_object('ref', v_r.ref, 'categories', to_jsonb(v_r.categories),
        'company_tenant_id', v_r.company_tenant_id, 'company_name', v_company.name,
        'reason', v_reason, 'approval_id', v_id, 'payload_sha256', v_sha,
        'expires_at', v_expiry, 'proposed_name', v_name));

  return jsonb_build_object('status', 'ok', 'approval_id', v_id, 'action', 'customer.erase',
    'target_kind', 'data_request', 'target_id', v_r.id, 'ref', v_r.ref,
    'categories', to_jsonb(v_r.categories), 'payload_sha256', v_sha,
    'request_status', 'pending_signature', 'expires_at', v_expiry);
end $$;

-- The mask itself.
--
-- Reached only from `releaseAndApply`, in the same transaction that decided and spent the
-- signature, and only by the seat that signed. Every statement below masks in place — nothing
-- deletes a row, because 109 tables would refuse and because the history is the account's proof.
-- Each category counts the rows it reached, and the whole walk is one atomic act: if any
-- statement raises, the signature is not spent and the paper stays pending, exactly as 121 made
-- true for a ban.
create or replace function platform_auth.apply_data_erasure(
  p_approval_id uuid, p_actor uuid, p_role text, p_actor_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_a platform_approvals%rowtype;
  v_r customer_data_requests%rowtype;
  v tenants;
  v_cats text[];
  v_name text;
  v_seat_name text;
  v_paper text;
  v_n int := 0;
  v_m int;
  v_counts jsonb := '{}'::jsonb;
  v_keeps jsonb;
begin
  select * into v_a from platform_approvals where id = p_approval_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_a.action <> 'customer.erase' or v_a.target_kind <> 'data_request' then
    return jsonb_build_object('status', 'invalid', 'message',
      'That signature is not a data erasure.');
  end if;
  if v_a.status <> 'applied' then
    return jsonb_build_object('status', 'conflict', 'approval_status', v_a.status,
      'message', 'The signature was not spent by this call.');
  end if;
  if v_a.decided_by <> p_actor then
    return jsonb_build_object('status', 'unauthorised',
      'message', 'Only the seat that released a signature may spend it.');
  end if;

  select * into v_r from customer_data_requests where id = v_a.target_id::uuid for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_r.approval_id is distinct from v_a.id then
    return jsonb_build_object('status', 'conflict', 'message',
      v_r.ref || ' is not the paper this signature was given for.');
  end if;
  if v_r.status = 'erased' then
    return jsonb_build_object('status', 'conflict', 'request_id', v_r.id, 'ref', v_r.ref,
      'message', 'This paper was already erased by its signature.');
  end if;
  if v_r.kind <> 'erase' or v_r.status <> 'pending_signature' then
    return jsonb_build_object('status', 'conflict', 'request_status', v_r.status,
      'message', 'This paper is not waiting for that signature.');
  end if;

  select * into v from tenants where id = v_r.company_tenant_id;
  if v.id is null or v.type = 'platform' then
    return jsonb_build_object('status', 'invalid', 'message',
      'The account this paper names is not one the platform can erase.');
  end if;
  if v.deleted_at is null then
    return jsonb_build_object('status', 'conflict', 'message',
      v.name || ' is trading again. Nothing was masked: an erasure is not run against a live '
      || 'account.');
  end if;
  -- The list the signature carried, not the list the row happens to hold. They are equal by the
  -- guard above and the trigger below proves it a third time; reading it from the payload is what
  -- makes the mask a replay of what was signed.
  select coalesce(array_agg(k order by k), '{}'::text[]) into v_cats
    from jsonb_array_elements_text(v_a.payload -> 'categories') k;

  v_name := 'Erased account ' || left(v.id::text, 8);
  v_seat_name := 'Erased seat ' || left(v.id::text, 8);

  -- 1. account — the name the platform holds, and every copy of it on this account's own files.
  if 'account' = any (v_cats) then
    update tenants
       set name = v_name, slug = null, email = null,
           tin_encrypted = null, tin_search = null,
           phone_encrypted = null, phone_search = null
     where id = v.id;
    v_n := 0;
    update company_profiles c set company_name = v_name where c.tenant_id = v.id;
    get diagnostics v_m = row_count; v_n := v_n + v_m;
    update support_tickets s set company_name = v_name where s.company_tenant_id = v.id;
    get diagnostics v_m = row_count; v_n := v_n + v_m;
    update service_disputes d set company_name = v_name where d.company_tenant_id = v.id;
    get diagnostics v_m = row_count; v_n := v_n + v_m;
    update service_refund_requests r set company_name = v_name where r.company_tenant_id = v.id;
    get diagnostics v_m = row_count; v_n := v_n + v_m;
    update subscription_cancellations c set company_name = v_name where c.tenant_id = v.id;
    get diagnostics v_m = row_count; v_n := v_n + v_m;
    update directory_listings l set company_name = v_name where l.tenant_id = v.id;
    get diagnostics v_m = row_count; v_n := v_n + v_m;
    v_counts := v_counts || jsonb_build_object('account', 1 + v_n);
  end if;

  -- 2. seats — the people who could sign in. The row stays, because the roster is the account's
  --    own history; the person in it does not.
  if 'seats' = any (v_cats) then
    update users
       set full_name = case when user_type = 'platform' then full_name
                            else 'Erased seat ' || left(id::text, 8) end,
           email = null, email_normalized_search = null,
           phone_encrypted = null, phone_search = null,
           nida_encrypted = null, nida_search = null,
           password_hash = null, totp_secret_encrypted = null, totp_enabled = false,
           job_title = null, status = 'deactivated', deleted_at = now()
     where tenant_id = v.id and user_type <> 'platform';
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('seats', v_n);
  end if;

  -- 3. sessions — device, address and the token that could still refresh. A seat that cannot be
  --    identified cannot be signed in with; the credential is the thing, not the row.
  if 'sessions' = any (v_cats) then
    update sessions
       set refresh_token_hash = 'erased-' || left(md5(id::text), 40),
           ip = null, user_agent = null,
           revoked_at = coalesce(revoked_at, now()),
           revoked_reason = coalesce(revoked_reason, 'data_erasure')
     where tenant_id = v.id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('sessions', v_n);
  end if;

  -- 4. profile — the trading identity: numbers on paper, the payment details, the public listing.
  --
  -- The listing is withdrawn as it is masked, and not only because the board must not go on
  -- publishing "Erased account 1f3c9a2b — call 07xx…": 061's guard re-tests the tenant on every
  -- write to a `live` row and refuses one whose account is closed, so an erasure that left a
  -- listing live would not merely be wrong on the public site, it could not run at all. The
  -- guard's own first line — `if new.status <> 'live' then return new` — is what makes the
  -- withdrawal the legal way to touch the row. 061:988 says withdrawing is `draft`, not deleting.
  if 'profile' = any (v_cats) then
    update company_profiles
       set tin_display = null, brela_number = null, vat_number = null,
           transport_licence_no = null, services_offered = null, corridors_served = null,
           description = null, website = null, logo_path = null, company_code = null,
           pay_bank_name = null, pay_bank_account = null, pay_account_name = null,
           pay_mobile_money = null
     where tenant_id = v.id;
    get diagnostics v_n = row_count;
    update directory_listings
       set headline = null, description = null, services_offered = null,
           corridors_served = null, home_base = null, website = null,
           contact_name = 'Erased contact',
           contact_channel = 'erased-' || left(id::text, 8),
           company_name = v_name,
           status = case when status = 'live' then 'draft' else status end
     where tenant_id = v.id;
    get diagnostics v_m = row_count;
    v_n := v_n + v_m;
    v_counts := v_counts || jsonb_build_object('profile', v_n);
  end if;

  -- 5. contacts — the people this account wrote down: its own book and its offices. These are
  --    third parties' details held in the account's file, which is the account's data to erase
  --    and the platform's data to have.
  if 'contacts' = any (v_cats) then
    update clients
       set name = 'Erased contact', tin = null, email = null, address = null, notes = null,
           phone_encrypted = null, phone_search = null
     where tenant_id = v.id;
    get diagnostics v_n = row_count;
    update branches
       set contact_person = null, email = null, phone_encrypted = null, phone_search = null
     where tenant_id = v.id;
    get diagnostics v_m = row_count;
    v_counts := v_counts || jsonb_build_object('contacts', v_n + v_m);
  end if;

  -- 6. drivers — the people behind a wheel. The licence class and its expiry are a capability the
  --    transport record needs; the number, the phone and the next of kin are a person's.
  if 'drivers' = any (v_cats) then
    update drivers
       set full_name = 'Erased driver', date_of_birth = null, blood_group = null,
           address = null, next_of_kin = null, notes = null, licence_number = null,
           nida_encrypted = null, nida_search = null,
           phone_encrypted = null, phone_search = null,
           next_of_kin_phone_encrypted = null
     where tenant_id = v.id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('drivers', v_n);
  end if;

  -- 7. cargo_people — the parties named on a file. The file itself is a customs record and its
  --    own number, containers and weights stay: they are what the trade was.
  if 'cargo_people' = any (v_cats) then
    update cargo_shipments
       set consignee_name = 'Erased party', consignor_name = 'Erased party', notes = null
     where tenant_id = v.id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('cargo_people', v_n);
  end if;

  -- 8. calls — who telephoned, and what they said. Free text cannot be scrubbed word by word, so
  --    the words go and the reason they went stays: a reader of the incidence must be able to see
  --    that the blank is an erasure and not a lost note.
  if 'calls' = any (v_cats) then
    update support_tickets
       set reporter_name = 'Erased caller', reporter_email = null, subject = 'Erased subject',
           body = 'The caller''s words were erased under data request ' || v_r.ref
                  || ' on ' || to_char(now(), 'YYYY-MM-DD') || '.',
           resolution = case when resolution is null then null
                             else 'The office''s words on this call were erased under '
                                  || v_r.ref || '.' end,
           reporter_phone_encrypted = null, reporter_phone_search = null
     where company_tenant_id = v.id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('calls', v_n);
  end if;

  -- 9. messages — the thread between the account and the office about a file.
  if 'messages' = any (v_cats) then
    update messages
       set body = 'Erased under data request ' || v_r.ref || ' on '
                  || to_char(now(), 'YYYY-MM-DD') || '.'
     where tenant_id = v.id and deleted_at is null;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('messages', v_n);
  end if;

  -- 10. papers — the register entry for a stored file. `storage_path` stays, on purpose: the
  --     bytes are still in storage, and the row that says where they are is what lets the
  --     retention sweep destroy them. The count lands in `keeps` as `paper_bytes`.
  if 'papers' = any (v_cats) then
    update documents d
       set file_name = 'erased-' || left(d.id::text, 8)
                       || case when d.file_name ~ '\.[A-Za-z0-9]{1,8}$'
                               then right(d.file_name, position('.' in reverse(d.file_name)))
                               else '' end,
           deleted_at = coalesce(d.deleted_at, now())
     where d.deleted_at is null
       and ((d.entity_type = 'tenant' and d.entity_id = v.id)
         or (d.entity_type = 'shipment' and exists (select 1 from cargo_shipments c
                  where c.id = d.entity_id and c.tenant_id = v.id))
         or (d.entity_type = 'driver' and exists (select 1 from drivers r
                  where r.id = d.entity_id and r.tenant_id = v.id))
         or (d.entity_type = 'message' and exists (select 1 from messages m
                  where m.id = d.entity_id and m.tenant_id = v.id))
         or (d.entity_type = 'support_ticket' and exists (select 1 from support_tickets s
                  where s.id = d.entity_id and s.company_tenant_id = v.id)));
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('papers', v_n);
  end if;

  -- The kept half, counted at the same moment as the masked half, in the same transaction, off
  -- the same rows. The preview's list is the words; this is the numbers that were true when the
  -- signature was spent.
  select platform_auth.data_request_preview(v.id, 'erase') -> 'keeps' into v_keeps;

  v_seat_name := coalesce((select full_name from users where id = p_actor), 'a second seat');

  update customer_data_requests
     set status = 'erased', erased_by = p_actor, erased_at = now(),
         erased = v_counts, keeps = v_keeps, updated_at = now()
   where id = v_r.id;

  -- Counts and category names only. The values this act destroyed are not copied into the
  -- register that is supposed to prove they are gone.
  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), v_r.tenant_id, p_actor, p_role, p_actor_ip,
      'customer_data_requests', v_r.id, 'data_request.erased',
      jsonb_build_object('status', v_r.status, 'categories', to_jsonb(v_r.categories)),
      jsonb_build_object('ref', v_r.ref, 'company_tenant_id', v_r.company_tenant_id,
        'categories', to_jsonb(v_r.categories), 'reached', v_counts,
        'kept', (select coalesce(jsonb_agg(k -> 'key'), '[]'::jsonb)
                   from jsonb_array_elements(v_keeps) k),
        'approval_id', v_a.id, 'payload_sha256', v_a.payload_sha256,
        'raised_by', v_r.raised_by, 'erased_by', p_actor, 'erased_name', v_seat_name));

  return jsonb_build_object('status', 'ok', 'request_id', v_r.id, 'ref', v_r.ref,
    'company_tenant_id', v_r.company_tenant_id, 'categories', to_jsonb(v_r.categories),
    'reached', v_counts, 'kept', v_keeps, 'approval_id', v_a.id,
    'payload_sha256', v_a.payload_sha256, 'erased_by', p_actor, 'erased_name', v_seat_name,
    'request_status', 'erased', 'clock', now());
end $$;

-- Refuse the ask. 126's `decline_refund` order, kept: the signature is answered first, so a desk
-- cannot leave a paper refused while a proposal is still open waiting for a second seat to say
-- yes to it.
create or replace function platform_auth.refuse_data_request(
  p_request_id uuid, p_note text, p_actor uuid, p_role text, p_actor_ip text, p_actor_ua text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_name text;
  v_r customer_data_requests%rowtype;
  v_a platform_approvals%rowtype;
  v_note text;
  v_dec jsonb;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('status', 'invalid', 'message',
      'Only a live platform seat can refuse a data request.');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('status', 'invalid', 'message',
      'Say why in 8-600 characters: it is the sentence the account is given.');
  end if;

  select * into v_r from customer_data_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_r.status in ('delivered','erased','refused') then
    return jsonb_build_object('status', 'conflict', 'request_status', v_r.status,
      'message', 'This request is already answered.');
  end if;

  if v_r.approval_id is not null then
    select * into v_a from platform_approvals where id = v_r.approval_id;
    if v_a.status = 'pending' then
      v_dec := platform_auth.decide_approval(v_a.id, 'reject', v_note, p_actor,
        p_role, p_actor_ip, left(coalesce(p_actor_ua, ''), 300));
      if v_dec ->> 'status' <> 'ok' then return v_dec; end if;
    elsif v_a.status in ('approved','applied') then
      return jsonb_build_object('status', 'conflict',
        'message', 'The signature on this paper was released. An erasure that has been signed is '
        || 'spent on Approvals or allowed to lapse; it is not refused from here.');
    end if;
  end if;

  update customer_data_requests
     set status = 'refused', refused_by = p_actor, refused_at = now(), refused_note = v_note,
         updated_at = now()
   where id = v_r.id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, user_agent,
      entity, entity_id, action, before, after)
  values (gen_random_uuid(), v_r.tenant_id, p_actor, p_role, p_actor_ip,
      left(coalesce(p_actor_ua, ''), 300),
      'customer_data_requests', v_r.id, 'data_request.refused',
      jsonb_build_object('status', v_r.status, 'approval_id', v_r.approval_id),
      jsonb_build_object('ref', v_r.ref, 'kind', v_r.kind, 'note', v_note,
        'company_tenant_id', v_r.company_tenant_id, 'refused_by', p_actor,
        'refused_name', v_name));

  return jsonb_build_object('status', 'ok', 'request_id', v_r.id, 'ref', v_r.ref,
    'request_status', 'refused', 'note', v_note, 'refused_name', v_name);
end $$;

-- ============================================================
-- 7. the copy
-- ============================================================
--
-- One read that walks the registers the platform already keeps and hands back what they hold about
-- one account. It is a definer rather than a dozen route queries for the reason 126's board is:
-- the sections have to be measured against the same rows and the same `now()`, and the manifest
-- that says "13 sections, 412 rows, 3 withheld" must be true of the bundle beside it.
--
-- Two kinds of thing do not come out. Credentials never do — a hash, a token or a TOTP secret is
-- not data the account is entitled to copy back, and printing them would only widen the blast of
-- a leaked bundle. And a value stored encrypted comes out as hex ciphertext rather than as the
-- number itself: the API holds the key, so the route that assembles the ZIP decrypts the handful
-- of fields the subject is owed (their own NIDA, TIN, phone) and writes the plain value into the
-- sheet. Doing it in SQL would mean putting the key in the database, which is a decision this
-- platform has not made and this file does not quietly make for it.
--
-- Each section is capped. A cap that says nothing is a silent truncation, so `held` is the true
-- count and `truncated` is stated in the manifest the subject reads.
create or replace function platform_auth.data_export(p_request uuid, p_register uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_r customer_data_requests%rowtype;
  v tenants;
  v_cap int := 400;
  v_sec jsonb := '[]'::jsonb;
begin
  select * into v_r from customer_data_requests where id = p_request;
  if not found then return jsonb_build_object('status', 'not_found', 'request', p_request); end if;
  if v_r.tenant_id <> p_register then
    return jsonb_build_object('status', 'invalid', 'message',
      'That request is not on this office''s register.');
  end if;
  if v_r.kind <> 'export' then
    return jsonb_build_object('status', 'invalid', 'message',
      v_r.ref || ' is an erasure paper. A copy is raised as its own request, so that the '
      || 'signature on the erasure is asked for a mask and not for a download.');
  end if;
  if v_r.status = 'refused' then
    return jsonb_build_object('status', 'refused', 'ref', v_r.ref,
      'message', 'This request was refused: ' || coalesce(v_r.refused_note, 'no note on the row'));
  end if;

  select * into v from tenants where id = v_r.company_tenant_id;
  if v.id is null then
    return jsonb_build_object('status', 'not_found', 'company_id', v_r.company_tenant_id);
  end if;

  v_sec := v_sec || jsonb_build_object('key', 'account', 'label', 'The account',
    'held', 1, 'truncated', false,
    'withheld', 'The TIN and phone are given as ciphertext for the desk to decrypt; the search '
      || 'hashes are not in this copy — they exist only to find a row by a number.',
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('id', t.id, 'name', t.name, 'type', t.type, 'status', t.status,
        'email', t.email, 'tin_hex', encode(t.tin_encrypted, 'hex'),
        'phone_hex', encode(t.phone_encrypted, 'hex'), 'plan', pl.name,
        'seats_licensed', t.seats_licensed, 'created_at', t.created_at,
        'trial_started_at', t.trial_started_at, 'trial_ends_at', t.trial_ends_at,
        'licence_expires_at', t.licence_expires_at, 'closed_at', t.deleted_at) as o
        from tenants t left join plans pl on pl.id = t.plan_id
       where t.id = v.id limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'profile', 'label', 'The trading profile',
    'held', (select count(*)::int from company_profiles c where c.tenant_id = v.id),
    'truncated', false,
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('company_name', c.company_name, 'tin_display', c.tin_display,
        'brela_number', c.brela_number, 'vat_number', c.vat_number,
        'transport_licence_no', c.transport_licence_no,
        'transport_licence_expiry', c.transport_licence_expiry, 'company_code', c.company_code,
        'year_established', c.year_established, 'fleet_size_declared', c.fleet_size_declared,
        'services_offered', c.services_offered, 'corridors_served', c.corridors_served,
        'description', c.description, 'website', c.website, 'logo_path', c.logo_path,
        'pay_bank_name', c.pay_bank_name, 'pay_account_name', c.pay_account_name,
        'pay_bank_account', c.pay_bank_account, 'pay_mobile_money', c.pay_mobile_money,
        'updated_at', c.updated_at) as o
        from company_profiles c where c.tenant_id = v.id limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'seats', 'label', 'The seats that could sign in',
    'held', (select count(*)::int from users u where u.tenant_id = v.id
               and u.user_type <> 'platform'), 'truncated', false,
    'withheld', 'No password hash, no TOTP secret, no session token. NIDA and phone are given as '
      || 'ciphertext for the desk to decrypt: they are the account''s own people.',
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email,
        'user_type', u.user_type, 'job_title', u.job_title, 'status', u.status,
        'phone_hex', encode(u.phone_encrypted, 'hex'), 'nida_hex', encode(u.nida_encrypted, 'hex'),
        'last_login_at', u.last_login_at, 'language', u.language, 'created_at', u.created_at,
        'closed_at', u.deleted_at) as o
        from users u where u.tenant_id = v.id and u.user_type <> 'platform'
       order by u.created_at limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'logins', 'label', 'Every sign-in on record',
    'held', (select count(*)::int from sessions s where s.tenant_id = v.id), 'truncated', true,
    'withheld', 'Only the last ' || v_cap || ' sessions of '
      || (select count(*)::int from sessions s where s.tenant_id = v.id)
      || '. A refresh-token hash is a credential and is never in a copy.',
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('seat', (select u.full_name from users u where u.id = s.user_id),
        'signed_in_at', s.created_at, 'last_seen', s.last_refreshed_at, 'expires_at', s.expires_at,
        'ip', host(s.ip), 'device', left(coalesce(s.user_agent, ''), 120),
        'revoked_at', s.revoked_at, 'revoked_reason', s.revoked_reason,
        'opened_by_office', s.actor_user_id is not null) as o
        from sessions s where s.tenant_id = v.id
       order by s.created_at desc limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'checks', 'label', 'The checks the office ran',
    'held', (select count(*)::int from customer_verifications c
               where c.company_tenant_id = v.id), 'truncated', false,
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('kind', c.kind, 'status', c.status,
        'reference_hex', encode(c.reference_encrypted, 'hex'), 'reference_tail', c.reference_tail,
        'expires_on', to_char(c.expires_on, 'YYYY-MM-DD'), 'reason', c.reason,
        'raised_at', c.raised_at, 'raised_by', (select u.full_name from users u
                                                  where u.id = c.raised_by),
        'decided_at', c.decided_at, 'decided_by', (select u.full_name from users u
                                                    where u.id = c.decided_by),
        'paper', (select d.file_name from documents d where d.id = c.document_id)) as o
        from customer_verifications c where c.company_tenant_id = v.id
       order by c.raised_at limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'notes', 'label', 'The office''s notes',
    'held', (select count(*)::int from customer_notes n where n.company_tenant_id = v.id),
    'truncated', false,
    'withheld', 'The colleague who wrote a note is named by role, not by name: their record is '
      || 'not the account''s to copy.',
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('written_at', n.created_at, 'edited_at', n.edited_at,
        'body', n.body, 'author_role', (select coalesce(r.name, r.key, 'office')
           from users u join user_roles ur on ur.user_id = u.id
           join roles r on r.id = ur.role_id where u.id = n.author limit 1),
        'withdrawn_at', n.voided_at, 'withdrawn_reason', n.void_reason) as o
        from customer_notes n where n.company_tenant_id = v.id
       order by n.created_at limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'labels', 'label', 'Labels on the account',
    'held', (select count(*)::int from customer_taggings t
               where t.company_tenant_id = v.id), 'truncated', false,
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('label', g.name, 'applied_at', t.applied_at,
        'withdrawn_at', t.deleted_at) as o
        from customer_taggings t join customer_tags g on g.id = t.tag_id
       where t.company_tenant_id = v.id order by t.applied_at limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'calls', 'label', 'The calls this office took',
    'held', (select count(*)::int from support_tickets s where s.company_tenant_id = v.id),
    'truncated', false,
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('ref', s.ref, 'desk_ref', s.dept_ref, 'opened_at', s.created_at,
        'channel', s.channel, 'category', s.category, 'subject', s.subject, 'body', s.body,
        'priority', s.priority, 'status', s.status, 'language', s.language,
        'reporter_name', s.reporter_name, 'reporter_email', s.reporter_email,
        'reporter_phone_hex', encode(s.reporter_phone_encrypted, 'hex'),
        'first_response_at', s.first_response_at, 'resolved_at', s.resolved_at,
        'resolution', s.resolution, 'reopens', s.reopen_count,
        'response_due_at', s.response_due_at, 'resolution_due_at', s.resolution_due_at,
        'after_hours', s.after_hours, 'closed_at', s.deleted_at) as o
        from support_tickets s where s.company_tenant_id = v.id
       order by s.created_at limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'call_events',
    'label', 'What the office did on each call',
    'held', (select count(*)::int from support_ticket_events e
               where e.ticket_id in (select s.id from support_tickets s
                                      where s.company_tenant_id = v.id)),
    'truncated', true,
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('at', e.ts, 'call_ref', e.ref, 'action', e.action,
        'from', e.from_label, 'to', e.to_label, 'reason', e.reason,
        'actor_role', e.actor_role) as o
        from support_ticket_events e
       where e.ticket_id in (select s.id from support_tickets s
                              where s.company_tenant_id = v.id)
       order by e.ts limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'cargo', 'label', 'The files this account filed',
    'held', (select count(*)::int from cargo_shipments c where c.tenant_id = v.id),
    'truncated', true,
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('file_number', c.file_number, 'seq', c.seq, 'year', c.file_year,
        'type', c.shipment_type, 'stage', c.stage, 'status', c.status,
        'consignee_name', c.consignee_name, 'consignor_name', c.consignor_name,
        'container_type', c.container_type, 'container_count', c.container_count,
        'container_numbers', c.container_numbers, 'cbm', c.cbm, 'weight_tonnes', c.weight_tonnes,
        'bill_number', c.bill_number, 'tansad_number', c.tansad_number, 'rcn_number', c.rcn_number,
        'hs_code', c.hs_code, 'border_point', c.border_point, 'nominated_icd', c.nominated_icd,
        'order_date', to_char(c.order_date, 'YYYY-MM-DD'), 'eta', to_char(c.eta, 'YYYY-MM-DD'),
        'created_at', c.created_at, 'completed_at', c.completed_at, 'closed_at', c.deleted_at) as o
        from cargo_shipments c where c.tenant_id = v.id
       order by c.created_at limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'papers', 'label', 'The files held on the vault',
    'held', (select count(*)::int from documents d
               where (d.entity_type = 'tenant' and d.entity_id = v.id)
                  or (d.entity_type = 'shipment' and exists (select 1 from cargo_shipments c
                        where c.id = d.entity_id and c.tenant_id = v.id))),
    'truncated', false,
    'withheld', 'The register of each file — its name, kind, size and date. The bytes themselves '
      || 'and the storage path are not in this copy: the path is where the file lives, and a '
      || 'bundle that carried it would be a second place to leak from.',
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('file_name', d.file_name, 'kind', d.kind, 'mime_type', d.mime_type,
        'size_bytes', d.size_bytes, 'filed_against', d.entity_type, 'uploaded_at', d.created_at,
        'filed_away_at', d.deleted_at) as o
        from documents d
       where (d.entity_type = 'tenant' and d.entity_id = v.id)
          or (d.entity_type = 'shipment' and exists (select 1 from cargo_shipments c
                where c.id = d.entity_id and c.tenant_id = v.id))
       order by d.created_at limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'contacts', 'label', 'The account''s own book',
    'held', (select count(*)::int from clients c where c.tenant_id = v.id), 'truncated', true,
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('name', c.name, 'tin', c.tin, 'email', c.email,
        'phone_hex', encode(c.phone_encrypted, 'hex'), 'address', c.address, 'notes', c.notes,
        'created_at', c.created_at, 'closed_at', c.deleted_at) as o
        from clients c where c.tenant_id = v.id order by c.created_at limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'drivers', 'label', 'The drivers on file',
    'held', (select count(*)::int from drivers d where d.tenant_id = v.id), 'truncated', true,
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('full_name', d.full_name,
        'nida_hex', encode(d.nida_encrypted, 'hex'), 'phone_hex', encode(d.phone_encrypted, 'hex'),
        'date_of_birth', to_char(d.date_of_birth, 'YYYY-MM-DD'), 'blood_group', d.blood_group,
        'licence_class', d.licence_class, 'licence_number', d.licence_number,
        'licence_expiry', to_char(d.licence_expiry, 'YYYY-MM-DD'), 'address', d.address,
        'next_of_kin', d.next_of_kin, 'status', d.status, 'created_at', d.created_at,
        'closed_at', d.deleted_at) as o
        from drivers d where d.tenant_id = v.id order by d.created_at limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'money', 'label', 'Invoices and payments',
    'held', (select count(*)::int from invoices i where i.tenant_id = v.id)
           + (select count(*)::int from payments p where p.tenant_id = v.id), 'truncated', false,
    'withheld', 'A payment''s provider payload is not in this copy: it is the gateway''s record of '
      || 'a transaction and it carries card and account data the platform is not entitled to hand '
      || 'out. The payer''s phone is given as ciphertext.',
    'rows', coalesce((select jsonb_agg(s.o) from (
      -- A UNION of two `json_build_object` arms cannot be ordered by the object: json has no
      -- ordering operator, and `order by 1` on this shape throws 42883. The arms carry their own
      -- date as a second column and the union orders on that.
      select json_build_object('kind', 'invoice', 'number', i.number, 'cycle', i.billing_cycle,
        'seats', i.seats, 'subtotal', i.amount_subtotal, 'vat_rate', i.vat_rate,
        'vat_amount', i.vat_amount, 'total', i.amount_total, 'currency', i.currency,
        'status', i.status, 'period_start', to_char(i.period_start, 'YYYY-MM-DD'),
        'period_end', to_char(i.period_end, 'YYYY-MM-DD'), 'issued_at', i.issued_at,
        'due_at', i.due_at, 'paid_at', i.paid_at) as o,
        coalesce(i.paid_at, i.issued_at) as dated
        from invoices i where i.tenant_id = v.id and i.deleted_at is null
       union all
      select json_build_object('kind', 'payment', 'number', p.provider_txn_id, 'cycle', p.provider,
        'seats', null, 'subtotal', p.amount, 'vat_rate', null, 'vat_amount', null,
        'total', p.amount, 'currency', p.currency, 'status', p.status,
        'period_start', null, 'period_end', null, 'issued_at', p.requested_at,
        'due_at', null, 'paid_at', p.completed_at),
        coalesce(p.completed_at, p.requested_at)
        from payments p where p.tenant_id = v.id
       order by 2 nulls last limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'service', 'label', 'Disputes and refund papers',
    'held', (select count(*)::int from service_disputes d where d.company_tenant_id = v.id)
           + (select count(*)::int from service_refund_requests r
                where r.company_tenant_id = v.id), 'truncated', false,
    'rows', coalesce((select jsonb_agg(s.o) from (
      select json_build_object('kind', 'dispute', 'ref', d.ref, 'call_ref', d.ticket_ref,
        'ground', d.ground, 'claim', d.claim, 'amount', d.amount, 'currency', d.currency,
        'status', d.status, 'outcome', d.outcome, 'opened_at', d.opened_at,
        'decided_at', d.decided_at, 'closed_at', d.deleted_at) as o,
        coalesce(d.decided_at, d.opened_at) as dated
        from service_disputes d where d.company_tenant_id = v.id
       union all
      select json_build_object('kind', 'refund', 'ref', r.ref, 'call_ref', r.ticket_ref,
        'ground', r.reason, 'claim', r.pay_back, 'amount', r.amount, 'currency', r.currency,
        'status', r.status, 'outcome', coalesce(r.declined_note, r.void_note),
        'opened_at', r.raised_at, 'decided_at', coalesce(r.released_at, r.declined_at),
        'closed_at', null),
        coalesce(r.released_at, r.declined_at, r.raised_at)
        from service_refund_requests r where r.company_tenant_id = v.id
       order by 2 nulls last limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'actions',
    'label', 'What the office did to the account',
    'held', (select count(*)::int from tenant_actions a where a.tenant_id = v.id),
    'truncated', false,
    'withheld', 'This is the register of two-seat acts: a block, a closure or a deletion keeps the '
      || 'reason it was given, the status either side of it and the name of the seat that signed it. '
      || 'How many sign-in sessions the act ended was written to the platform''s audit trail, not '
      || 'into this row, and the audit trail is the one register this copy is not allowed to hand '
      || 'over (129 keeps it for exactly that reason). Ask for the number and the office reads it '
      || 'out to you.',
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('action', a.action, 'reason_code', a.reason_code, 'note', a.note,
        'from_status', a.prior_status, 'to_status', a.new_status, 'seats_licensed',
        a.seats_licensed, 'at', a.created_at, 'by', a.actor_kind, 'role', a.actor_role,
        'signed_by', (select u.full_name from users u
                       join platform_approvals ap on ap.id = a.approval_id
                      where u.id = ap.decided_by)) as o
        from tenant_actions a where a.tenant_id = v.id
       order by a.created_at limit v_cap) s), '[]'::jsonb));

  v_sec := v_sec || jsonb_build_object('key', 'requests',
    'label', 'Every data request on this account',
    'held', (select count(*)::int from customer_data_requests r
               where r.company_tenant_id = v.id), 'truncated', false,
    'rows', coalesce((select jsonb_agg(o) from (
      select json_build_object('ref', r.ref, 'kind', r.kind, 'status', r.status,
        'categories', to_jsonb(r.categories), 'reason', r.reason, 'asked_in', r.asked_in,
        'raised_at', r.raised_at, 'delivered_at', r.delivered_at, 'deliveries', r.deliveries,
        'bundle_sha256', r.bundle_sha256, 'erased_at', r.erased_at, 'erased', r.erased,
        'kept', r.keeps, 'refused_at', r.refused_at, 'refused_note', r.refused_note) as o
        from customer_data_requests r where r.company_tenant_id = v.id
       order by r.raised_at limit v_cap) s), '[]'::jsonb));

  return jsonb_build_object('status', 'ok',
    'request', jsonb_build_object('id', v_r.id, 'ref', v_r.ref, 'raised_at', v_r.raised_at,
      'raised_by', (select u.full_name from users u where u.id = v_r.raised_by),
      'reason', v_r.reason, 'asked_in', v_r.asked_in, 'status', v_r.status),
    'company', jsonb_build_object('id', v.id, 'name', v.name, 'type', v.type,
      'closed_at', v.deleted_at),
    'cap', v_cap,
    'sections', v_sec,
    'clock', now());
end $$;

-- The copy is delivered by a streaming route, so the facts of the bundle can only be recorded
-- after the bytes left. First hand-over stamps them; every one after counts.
create or replace function platform_auth.mark_data_request_delivered(
  p_request uuid, p_actor uuid, p_role text, p_actor_ip text,
  p_sha text, p_bytes bigint, p_entries int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_r customer_data_requests%rowtype;
begin
  if p_sha is null or p_sha !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid', 'message',
      'A bundle is stamped with the SHA-256 of the bytes that left the API.');
  end if;
  select * into v_r from customer_data_requests where id = p_request for update;
  if not found then return jsonb_build_object('status', 'not_found', 'request', p_request); end if;
  if v_r.kind <> 'export' then
    return jsonb_build_object('status', 'invalid', 'message',
      'Only a copy is handed over. An erasure is signed, not delivered.');
  end if;
  if v_r.status not in ('raised','delivered') then
    return jsonb_build_object('status', 'conflict', 'request_status', v_r.status,
      'message', 'This request was refused, so there is nothing to stamp.');
  end if;

  update customer_data_requests
     set status = 'delivered',
         delivered_by = p_actor, delivered_at = now(),
         deliveries = deliveries + 1,
         bundle_sha256 = coalesce(bundle_sha256, p_sha),
         bundle_bytes = coalesce(bundle_bytes, p_bytes),
         bundle_entries = coalesce(bundle_entries, p_entries),
         updated_at = now()
   where id = p_request;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), v_r.tenant_id, p_actor, p_role, p_actor_ip,
      'customer_data_requests', p_request, 'data_request.delivered',
      jsonb_build_object('status', v_r.status, 'deliveries', v_r.deliveries),
      jsonb_build_object('ref', v_r.ref, 'sha256', p_sha, 'bytes', p_bytes,
        'entries', p_entries, 'first_bundle', v_r.bundle_sha256 is null,
        'deliveries', v_r.deliveries + 1, 'company_tenant_id', v_r.company_tenant_id));

  return jsonb_build_object('status', 'ok', 'request_id', p_request, 'ref', v_r.ref,
    'request_status', 'delivered', 'sha256', p_sha, 'bytes', p_bytes, 'entries', p_entries,
    'deliveries', v_r.deliveries + 1, 'first_bundle', v_r.bundle_sha256 is null);
end $$;

-- ============================================================
-- 8. the reads the desk is built on
-- ============================================================

create or replace function platform_auth.data_request_detail(p_request uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v jsonb;
begin
  select jsonb_build_object('status', 'ok',
      'id', r.id, 'ref', r.ref, 'kind', r.kind, 'status', r.status,
      'categories', to_jsonb(r.categories), 'reason', r.reason, 'asked_in', r.asked_in,
      'company', jsonb_build_object('id', c.id, 'name', c.name, 'type', c.type,
                                    'account_status', c.status, 'closed_at', c.deleted_at),
      'raised_at', r.raised_at, 'raised_name', ru.full_name, 'raised_role', r.raised_role,
      'approval_id', r.approval_id, 'approval_status', a.status,
      'approval_proposed_name', pu.full_name, 'approval_expires_at', a.expires_at,
      'payload_sha256', a.payload_sha256,
      'signed_name', du.full_name, 'signed_at', a.decided_at, 'signed_note', a.decided_note,
      'erased_at', r.erased_at, 'erased_name', eu.full_name,
      'erased', r.erased, 'keeps', r.keeps,
      'bundle_sha256', r.bundle_sha256, 'bundle_bytes', r.bundle_bytes,
      'bundle_entries', r.bundle_entries, 'deliveries', r.deliveries,
      'delivered_at', r.delivered_at, 'delivered_name', lu.full_name,
      'refused_at', r.refused_at, 'refused_note', r.refused_note,
      'refused_name', fu.full_name,
      'open_slot', (r.status in ('raised','pending_signature')),
      'clock', now())
    into v
    from customer_data_requests r
    join tenants c on c.id = r.company_tenant_id
    left join users ru on ru.id = r.raised_by
    left join users eu on eu.id = r.erased_by
    left join users lu on lu.id = r.delivered_by
    left join users fu on fu.id = r.refused_by
    left join platform_approvals a on a.id = r.approval_id
    left join users pu on pu.id = a.proposed_by
    left join users du on du.id = a.decided_by
   where r.id = p_request;
  return coalesce(v, jsonb_build_object('status', 'not_found', 'request', p_request));
end $$;

-- The board. A window count rather than a second query, and `::int` on it: pg answers a bare
-- count(*) as a bigint and JSON hands the page a string, which is how 128's pager came to be
-- wrong until it was read back.
create or replace function platform_auth.data_requests_board(
  p_register uuid, p_status text, p_kind text, p_search text, p_limit int, p_offset int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_rows jsonb;
  v_counts jsonb;
begin
  select coalesce(jsonb_agg(json_build_object(
      'id', q.id, 'ref', q.ref, 'kind', q.kind, 'request_status', q.status,
      'categories', q.categories, 'reason', q.reason, 'asked_in', q.asked_in,
      'company_id', q.company_id, 'company_name', q.company_name,
      'company_closed_at', q.company_closed_at,
      'raised_at', q.raised_at, 'raised_name', q.raised_name,
      'approval_status', q.approval_status, 'approval_expires_at', q.approval_expires_at,
      'payload_sha256', q.payload_sha256, 'signed_name', q.signed_name,
      'erased_at', q.erased_at, 'erased_name', q.erased_name, 'erased_rows', q.erased,
      'kept', q.keeps, 'deliveries', q.deliveries, 'delivered_at', q.delivered_at,
      'bundle_sha256', q.bundle_sha256, 'bundle_bytes', q.bundle_bytes,
      'refused_at', q.refused_at, 'refused_note', q.refused_note, 'total', q.total)
      order by q.raised_at desc), '[]'::jsonb)
    into v_rows
    from (
      select r.id, r.ref, r.kind, r.status, r.categories, r.reason, r.asked_in,
             r.raised_at, r.erased_at, r.erased, r.keeps, r.deliveries, r.delivered_at,
             r.bundle_sha256,
             r.bundle_bytes, r.refused_at, r.refused_note,
             count(*) over ()::int as total,
             c.id as company_id, c.name as company_name, c.deleted_at as company_closed_at,
             ru.full_name as raised_name, eu.full_name as erased_name,
             a.status as approval_status, a.expires_at as approval_expires_at,
             a.payload_sha256, du.full_name as signed_name
        from customer_data_requests r
        join tenants c on c.id = r.company_tenant_id
        left join users ru on ru.id = r.raised_by
        left join users eu on eu.id = r.erased_by
        left join platform_approvals a on a.id = r.approval_id
        left join users du on du.id = a.decided_by
       where r.tenant_id = p_register
         and (p_status is null or p_status = 'all' or r.status = p_status)
         and (p_kind is null or p_kind = 'all' or r.kind = p_kind)
         and (p_search is null or btrim(p_search) = ''
              or r.ref ilike '%' || btrim(p_search) || '%'
              or c.name ilike '%' || btrim(p_search) || '%'
              or r.reason ilike '%' || btrim(p_search) || '%'
              or array_to_string(r.categories, ' ') ilike '%' || btrim(p_search) || '%')
       order by r.raised_at desc
       limit least(greatest(coalesce(p_limit, 30), 1), 100)
      offset greatest(coalesce(p_offset, 0), 0)) q;

  select jsonb_build_object(
           'all', count(*)::int,
           'raised', count(*) filter (where status = 'raised')::int,
           -- Counted under the word the row itself holds, which is the word the board filters on:
           -- a chip that says `awaiting_signature` and sends it back as a filter is a 400, and the
           -- desk reads that as the register being empty.
           'pending_signature', count(*) filter (where status = 'pending_signature')::int,
           'delivered', count(*) filter (where status = 'delivered')::int,
           'erased', count(*) filter (where status = 'erased')::int,
           'refused', count(*) filter (where status = 'refused')::int,
           'export', count(*) filter (where kind = 'export')::int,
           'erase', count(*) filter (where kind = 'erase')::int)
    into v_counts
    from customer_data_requests
   where tenant_id = p_register;

  return jsonb_build_object('rows', coalesce(v_rows, '[]'::jsonb), 'counts', v_counts);
end $$;

-- ============================================================
-- 9. duties
-- ============================================================
--
-- Two keys, and deliberately narrow. `control.customers.gdpr` opens the register, the preview and
-- the copy — a bundle that carries the account's whole contact book, its drivers and the office's
-- notes about it, which is not a duty to hand to the desk that answers the phone.
-- `control.customers.erase` raises the erasure and asks for the signature; spending it belongs to
-- whoever holds `control.approvals.decide`, and the seat that signed is the only seat that can
-- run the mask (121's rule, restated in section 6). A super_admin who both raised and signed is
-- refused by the register, not by this list.
insert into permissions (key, description) values
  ('control.customers.gdpr',
   'Control - Read the data-request register, preview what it holds and hand a copy over'),
  ('control.customers.erase',
   'Control - Raise an erasure paper and ask a second seat to sign it')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.customers.gdpr'
  from roles r
 where r.tenant_id is null and r.key in ('super_admin','compliance_officer')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.customers.erase'
  from roles r
 where r.tenant_id is null and r.key in ('super_admin','compliance_officer')
on conflict do nothing;

-- ============================================================
-- 10. grants on the doors
-- ============================================================
-- A trigger body is fired, never called: the owner alone holds these (110, 121, 125, 126, 127,
-- 128). The sequence is used only inside `raise_data_request`, which runs as its owner, so
-- app_runtime is given nothing on it — 051's lesson about a number anybody could burn. It is
-- revoked rather than merely not granted, because this database seeds default privileges for
-- `service_role` and `app_runtime` (101's and 109's sequences were born holding `rwU` and `rU`
-- without being asked): a sequence created here inherits them, and a desk that could call
-- nextval directly could burn the number a paper is later given.
revoke all on sequence customer_data_request_number_seq
  from public, anon, authenticated, service_role, app_runtime;

revoke all on function
  platform_auth.data_request_names_a_closed_account(),
  platform_auth.data_request_is_kept_not_rewritten(),
  platform_auth.data_erase_needs_two_seats()
from public, anon, authenticated, app_runtime;

grant execute on function
  platform_auth.data_request_preview(uuid, text),
  platform_auth.raise_data_request(uuid, uuid, text, text[], text, text, uuid, text, text),
  platform_auth.propose_data_erasure(uuid, text, uuid, text, text, text),
  platform_auth.apply_data_erasure(uuid, uuid, text, text),
  platform_auth.refuse_data_request(uuid, text, uuid, text, text, text),
  platform_auth.mark_data_request_delivered(uuid, uuid, text, text, text, bigint, int),
  platform_auth.data_export(uuid, uuid),
  platform_auth.data_request_detail(uuid),
  platform_auth.data_requests_board(uuid, text, text, text, int, int)
to app_runtime;

revoke all on function
  platform_auth.data_request_preview(uuid, text),
  platform_auth.raise_data_request(uuid, uuid, text, text[], text, text, uuid, text, text),
  platform_auth.propose_data_erasure(uuid, text, uuid, text, text, text),
  platform_auth.apply_data_erasure(uuid, uuid, text, text),
  platform_auth.refuse_data_request(uuid, text, uuid, text, text, text),
  platform_auth.mark_data_request_delivered(uuid, uuid, text, text, text, bigint, int),
  platform_auth.data_export(uuid, uuid),
  platform_auth.data_request_detail(uuid),
  platform_auth.data_requests_board(uuid, text, text, text, int, int)
from public, anon, authenticated, service_role;

-- ============================================================
-- 11. the gate: run the doors, do not merely create them
-- ============================================================
--
-- 128's rule, kept: "the doors have to run, not merely exist" — 061 shipped a definer that 500'd
-- on every call while the whole suite printed green, and a text grep is not evidence. Nothing here
-- writes a row: every call is a refusal path, a read, or an insert its own subtransaction rolls
-- back, and the count at the end is the proof of that.
--
-- One limit, stated rather than hidden. plpgsql parses an UPDATE the first time it reaches it, so
-- the gate cannot prove the ten mask statements by running them — running them here would mean
-- erasing a real company inside a migration. They are proved three ways instead: every column they
-- write is asserted against `information_schema` below (a misspelled column is a failed migration,
-- not a failed erasure two weeks later); `scripts/verify-data-requests-sql.ts` mints a company,
-- closes it, signs a two-seat erasure of all ten categories and runs the mask inside a transaction
-- it rolls back, which executes and counts every branch; and `scripts/smoke-data-requests.ts` walks
-- the same act over HTTP, through the routes. It was the second of those that `sql%rowcount` hid
-- from the first.
do $$ declare
  v_expect  text[] := array['account','seats','sessions','profile','contacts','drivers',
                            'cargo_people','calls','messages','papers'];
  v_words   text[];
  v_def     text;
  v_missing text;
  v_answer  jsonb;
  v_before  int;
  v_after   int;
  v_office  uuid;
  v_seat    uuid;
  v_closed  uuid;
  v_live    uuid;
  v_none    uuid := gen_random_uuid();
  v_hex     text;
  v_signed  boolean;
  v_keys    int;
  v_keeps   int;
  v_rows    int;
  v_viewers int;
  v_erasers int;
  v_leaks   int;
begin
  select count(*)::int into v_before from customer_data_requests;

  select t.id into v_office from tenants t where t.type = 'platform' order by t.created_at limit 1;
  select u.id into v_seat   from users u where u.user_type = 'platform'
                                 and u.deleted_at is null and u.status = 'active'
                               order by u.created_at limit 1;
  select t.id into v_closed from tenants t where t.type <> 'platform' and t.deleted_at is not null
                               order by t.deleted_at desc limit 1;
  select t.id into v_live   from tenants t where t.type <> 'platform' and t.deleted_at is null
                               order by t.created_at limit 1;

  -- 1. the vocabulary has one author.
  --
  -- Read back out of the constraint rather than trusted from the text above: the same ten words
  -- are in the module's own list, in 121's payload and on the desk's screen, and this is the check
  -- that fails when a later migration extends one and not the others.
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'customer_data_requests'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%categories <@%'
   limit 1;
  if v_def is null then
    raise exception '129: nothing bounds `categories` — the erasure menu would be unbounded';
  end if;
  select array_agg(q.m[1] order by q.m[1]) into v_words
    from regexp_matches(substring(v_def from 'ARRAY\[.*?\]'), '''([a-z_]+)''', 'g') as q(m);
  if v_words is null
     or v_words <> (select array_agg(k order by k) from unnest(v_expect) k) then
    raise exception '129: the register''s CHECK says [%] and this file says [%] — the erasure '
      'menu has two authors',
      coalesce(array_to_string(v_words, ','), 'nothing read out of the constraint'),
      array_to_string(v_expect, ',');
  end if;

  -- 2. every column the mask writes exists; every column it nulls may be null.
  --
  -- `may_be_null` is false only where the mask substitutes a sentence for the value instead of
  -- removing it — a NOT NULL column written with a literal is a CHECK on the sentence, and
  -- section 6 keeps each of those inside its column's own length floor.
  select string_agg(w.t || '.' || w.c
      || case when w.n and h.is_nullable <> 'YES' then ' (not null)' else '' end, ', '
      order by w.t, w.c)
    into v_missing
    from (values
      ('tenants','slug',true),('tenants','email',true),('tenants','tin_encrypted',true),
      ('tenants','tin_search',true),('tenants','phone_encrypted',true),
      ('tenants','phone_search',true),('tenants','name',false),
      ('company_profiles','company_name',false),('company_profiles','tin_display',true),
      ('company_profiles','brela_number',true),('company_profiles','vat_number',true),
      ('company_profiles','transport_licence_no',true),('company_profiles','services_offered',true),
      ('company_profiles','corridors_served',true),('company_profiles','description',true),
      ('company_profiles','website',true),('company_profiles','logo_path',true),
      ('company_profiles','company_code',true),('company_profiles','pay_bank_name',true),
      ('company_profiles','pay_bank_account',true),('company_profiles','pay_account_name',true),
      ('company_profiles','pay_mobile_money',true),
      ('directory_listings','company_name',false),('directory_listings','headline',true),
      ('directory_listings','description',true),('directory_listings','services_offered',true),
      ('directory_listings','corridors_served',true),('directory_listings','home_base',true),
      ('directory_listings','website',true),('directory_listings','contact_name',false),
      ('directory_listings','contact_channel',false),('directory_listings','status',false),
      ('support_tickets','company_name',false),('support_tickets','reporter_name',false),
      ('support_tickets','reporter_email',true),('support_tickets','subject',false),
      ('support_tickets','body',false),('support_tickets','resolution',true),
      ('support_tickets','reporter_phone_encrypted',true),
      ('support_tickets','reporter_phone_search',true),
      ('service_disputes','company_name',false),('service_refund_requests','company_name',false),
      ('subscription_cancellations','company_name',false),
      ('users','full_name',false),('users','email',true),('users','email_normalized_search',true),
      ('users','phone_encrypted',true),('users','phone_search',true),('users','nida_encrypted',true),
      ('users','nida_search',true),('users','password_hash',true),
      ('users','totp_secret_encrypted',true),('users','totp_enabled',false),
      ('users','job_title',true),('users','status',false),('users','deleted_at',true),
      ('sessions','refresh_token_hash',false),('sessions','ip',true),('sessions','user_agent',true),
      ('sessions','revoked_at',true),('sessions','revoked_reason',true),
      ('clients','name',false),('clients','tin',true),('clients','email',true),
      ('clients','address',true),('clients','notes',true),('clients','phone_encrypted',true),
      ('clients','phone_search',true),
      ('branches','contact_person',true),('branches','email',true),
      ('branches','phone_encrypted',true),('branches','phone_search',true),
      ('drivers','full_name',false),('drivers','date_of_birth',true),('drivers','blood_group',true),
      ('drivers','address',true),('drivers','next_of_kin',true),('drivers','notes',true),
      ('drivers','licence_number',true),('drivers','nida_encrypted',true),('drivers','nida_search',true),
      ('drivers','phone_encrypted',true),('drivers','phone_search',true),
      ('drivers','next_of_kin_phone_encrypted',true),
      ('cargo_shipments','consignee_name',false),('cargo_shipments','consignor_name',false),
      ('cargo_shipments','notes',true),
      ('messages','body',false),('documents','file_name',false),('documents','deleted_at',true)
    ) as w(t, c, n)
    left join (select table_name as t, column_name as c, is_nullable
                 from information_schema.columns
                where table_schema = 'public') h
      on h.t = w.t and h.c = w.c
   where h.c is null or (w.n and h.is_nullable <> 'YES');
  if v_missing is not null then
    raise exception '129: the mask writes a column that is not there or cannot be nulled: %',
      v_missing;
  end if;

  -- 3. the preview runs, on the two kinds of account it has to tell apart.
  v_answer := null;
  if v_closed is not null then
    v_answer := platform_auth.data_request_preview(v_closed, 'erase');
    if v_answer ->> 'status' <> 'ok' or v_answer ->> 'eligible' <> 'true' then
      raise exception '129: a closed account was not offered an erasure (% / %)',
        v_answer ->> 'status', v_answer ->> 'eligible';
    end if;
  end if;
  if v_live is not null then
    v_answer := platform_auth.data_request_preview(v_live, 'erase');
    if coalesce(v_answer ->> 'eligible', 'true') <> 'false'
       or coalesce(v_answer ->> 'refusal', '') not like '%two-seat%' then
      raise exception '129: a live account was offered an erasure, or was refused in words that '
        'do not name the second signature it is waiting on (% / %)',
        v_answer ->> 'eligible', left(coalesce(v_answer ->> 'refusal', 'no refusal'), 120);
    end if;
  end if;
  if v_answer is null then
    raise exception '129: the preview could not be run — this database holds no company account, '
      'so the gate has nothing to read';
  end if;
  select count(*)::int into v_keys from jsonb_object_keys(v_answer -> 'masks') k;
  select jsonb_array_length(v_answer -> 'keeps')::int into v_keeps;
  if v_keys <> 10 then
    raise exception '129: the preview answers for % of the ten categories, not all ten', v_keys;
  end if;
  if v_keeps < 12 then
    raise exception '129: the preview leaves % of the twelve kept registers unsaid', 12 - v_keeps;
  end if;

  -- 4. the doors answer instead of raising. Each call below is a path that must refuse before it
  --    writes, so a guard that quietly stopped holding shows up here as a status, not a rollback.
  begin
    v_answer := platform_auth.raise_data_request(v_none, v_none, 'export', null,
      'the gate: a register that is not the office', null, v_none, 'gate', '127.0.0.1');
    if coalesce(v_answer ->> 'status', '') <> 'invalid' then
      raise exception '129: raise_data_request kept a request on a register that is not the office (%)',
        v_answer ->> 'status';
    end if;

    v_answer := platform_auth.raise_data_request(v_office, v_live, 'erase', array['account'],
      'the gate: a live account must not be erasable', null, v_none, 'gate', '127.0.0.1');
    if coalesce(v_answer ->> 'status', '') <> 'invalid'
       or coalesce(v_answer ->> 'message', '') not like '%two-seat%' then
      raise exception '129: an erasure was raised on a live account without the sentence that '
        'sends the desk to the tenants desk (% / %)',
        v_answer ->> 'status', left(coalesce(v_answer ->> 'message', 'none'), 120);
    end if;

    v_answer := platform_auth.raise_data_request(v_office, v_live, 'export', array['account'],
      'the gate: a copy is not a menu', null, v_none, 'gate', '127.0.0.1');
    if coalesce(v_answer ->> 'status', '') <> 'invalid' then
      raise exception '129: a copy accepted a category list (%), so the desk could choose what to '
        'withhold from its own copy', v_answer ->> 'status';
    end if;

    v_answer := platform_auth.raise_data_request(v_office, v_none, 'erase', array['account'],
      'the gate: an account that does not exist', null, v_none, 'gate', '127.0.0.1');
    if coalesce(v_answer ->> 'status', '') <> 'not_found' then
      raise exception '129: raise_data_request did not answer not_found for a missing account (%)',
        v_answer ->> 'status';
    end if;

    -- A signature asked for a paper that does not exist, a mask spent on a signature that does
    -- not exist, a refusal, a stamp and a copy on nothing. None of these may raise: the desk calls
    -- them from a page whose row may have been answered by another seat a second earlier.
    v_answer := platform_auth.propose_data_erasure(v_none, 'the gate: no such paper', v_seat,
      'gate', '127.0.0.1', 'migration');
    if coalesce(v_answer ->> 'status', '') not in ('not_found', 'invalid') then
      raise exception '129: propose_data_erasure answered % for a paper that does not exist',
        v_answer ->> 'status';
    end if;
    v_answer := platform_auth.apply_data_erasure(v_none, v_seat, 'gate', '127.0.0.1');
    if coalesce(v_answer ->> 'status', '') not in ('not_found', 'invalid', 'unauthorised') then
      raise exception '129: apply_data_erasure answered % for a signature that does not exist',
        v_answer ->> 'status';
    end if;
    v_answer := platform_auth.refuse_data_request(v_none, 'the gate: no such paper', v_seat,
      'gate', '127.0.0.1', 'migration');
    if coalesce(v_answer ->> 'status', '') not in ('not_found', 'invalid') then
      raise exception '129: refuse_data_request answered % for a paper that does not exist',
        v_answer ->> 'status';
    end if;
    v_answer := platform_auth.mark_data_request_delivered(v_none, v_seat, 'gate', '127.0.0.1',
      'not-a-hash', 1, 1);
    if coalesce(v_answer ->> 'status', '') <> 'invalid' then
      raise exception '129: a bundle was stamped without the SHA-256 of its bytes (%)',
        v_answer ->> 'status';
    end if;
    v_hex := encode(extensions.digest('waisha-129-gate', 'sha256'), 'hex');
    v_answer := platform_auth.mark_data_request_delivered(v_none, v_seat, 'gate', '127.0.0.1',
      v_hex, 1, 1);
    if coalesce(v_answer ->> 'status', '') <> 'not_found' then
      raise exception '129: mark_data_request_delivered answered % for a request that does not '
        'exist', v_answer ->> 'status';
    end if;
    v_answer := platform_auth.data_export(v_none, v_office);
    if coalesce(v_answer ->> 'status', '') <> 'not_found' then
      raise exception '129: data_export answered % for a request that does not exist',
        v_answer ->> 'status';
    end if;
    v_answer := platform_auth.data_request_detail(v_none);
    if coalesce(v_answer ->> 'status', '') <> 'not_found' then
      raise exception '129: the detail read does not answer not_found';
    end if;
    v_answer := platform_auth.data_requests_board(v_office, null, null, null, 5, 0);
    select jsonb_array_length(v_answer -> 'rows')::int into v_rows;
    if v_rows > v_before
       or coalesce((v_answer -> 'counts' ->> 'all')::int, -1) <> v_before then
      raise exception '129: the board reads % row(s) of a register holding %', v_rows, v_before;
    end if;
  exception when raise_exception then
    if sqlerrm like '129:%' then
      raise exception '%', sqlerrm;
    end if;
    raise exception '129: a door raised instead of answering — %', sqlerrm;
  end;

  -- 5. the register accepts a signature for this act.
  --
  -- 121 hard-codes which actions may be *proposed* — which is why this file carries its own raiser
  -- — but `platform_approvals` itself only knows the shape of an action name, and a paper the
  -- register will not hold is a request nobody can ever answer. So one row is inserted here and
  -- rolled back by the block that inserts it: the CHECKs, the FK and the seat columns all run, and
  -- no signature exists afterwards.
  if v_seat is not null then
    v_signed := false;
    begin
      insert into platform_approvals (id, action, target_kind, target_id, payload,
          payload_sha256, reason, status, proposed_by, proposed_role, expires_at)
      values (gen_random_uuid(), 'customer.erase', 'data_request', v_none::text,
          jsonb_build_object('request_id', v_none, 'categories', '["account"]'::jsonb),
          v_hex, 'the gate: a signature this file must be able to spend', 'pending', v_seat,
          'gate', now() + interval '7 days');
      v_signed := true;
      raise exception 'rollback the probe' using errcode = 'P0001';
    exception
      when raise_exception then
        if not v_signed then
          raise exception '129: the signature probe failed before it could be rolled back — %',
            sqlerrm;
        end if;
      when check_violation then
        raise exception '129: platform_approvals refuses a customer.erase row — %', sqlerrm;
      when foreign_key_violation then
        raise exception '129: platform_approvals cannot hold a customer.erase row — %', sqlerrm;
    end;
    if (select count(*)::int from platform_approvals
         where action = 'customer.erase' and target_id = v_none::text) <> 0 then
      raise exception '129: the signature probe left its row behind — the subtransaction did not '
        'roll it back';
    end if;
  end if;

  -- 6. who may reach the doors.
  --
  -- A `create or replace function` resets EXECUTE to PUBLIC, so the revokes above are load-bearing
  -- and are asserted rather than assumed: the mask is the one statement in this module that
  -- destroys values, and it must be reachable only from the approvals route.
  select count(*)::int into v_leaks
    from (values
      ('platform_auth.apply_data_erasure(uuid,uuid,text,text)'),
      ('platform_auth.propose_data_erasure(uuid,text,uuid,text,text,text)'),
      ('platform_auth.raise_data_request(uuid,uuid,text,text[],text,text,uuid,text,text)'),
      ('platform_auth.refuse_data_request(uuid,text,uuid,text,text,text)'),
      ('platform_auth.mark_data_request_delivered(uuid,uuid,text,text,text,bigint,int)'),
      ('platform_auth.data_export(uuid,uuid)'),
      ('platform_auth.data_request_preview(uuid,text)'),
      ('platform_auth.data_request_detail(uuid)'),
      ('platform_auth.data_requests_board(uuid,text,text,text,int,int)')) f(fn)
   where has_function_privilege('public', f.fn, 'EXECUTE')
      or not has_function_privilege('app_runtime', f.fn, 'EXECUTE');
  if v_leaks > 0 then
    raise exception '129: % of the nine doors is open to PUBLIC or shut to app_runtime', v_leaks;
  end if;
  select count(*)::int into v_leaks
    from (values
      ('platform_auth.data_request_names_a_closed_account()'),
      ('platform_auth.data_request_is_kept_not_rewritten()'),
      ('platform_auth.data_erase_needs_two_seats()')) f(fn)
   where has_function_privilege('app_runtime', f.fn, 'EXECUTE');
  if v_leaks > 0 then
    raise exception '129: % trigger(s) can be called as a function — 096''s sweep missed a file',
      v_leaks;
  end if;
  if has_sequence_privilege('app_runtime', 'customer_data_request_number_seq', 'USAGE')
     or has_sequence_privilege('service_role', 'customer_data_request_number_seq', 'USAGE') then
    raise exception '129: the DR number can be burned by a role that never raised a request';
  end if;
  if not (select relrowsecurity from pg_class
           where oid = 'customer_data_requests'::regclass) then
    raise exception '129: the register ships with row level security off';
  end if;
  select count(*)::int into v_leaks from information_schema.table_privileges
   where table_schema = 'public' and table_name = 'customer_data_requests'
     and grantee = 'app_runtime' and privilege_type = 'DELETE';
  if v_leaks > 0 then
    raise exception '129: a data-subject request can be deleted instead of answered';
  end if;

  select count(distinct rp.role_id)::int into v_viewers from role_permissions rp
    join roles r on r.id = rp.role_id
   where rp.permission_key = 'control.customers.gdpr' and r.tenant_id is null;
  select count(distinct rp.role_id)::int into v_erasers from role_permissions rp
    join roles r on r.id = rp.role_id
   where rp.permission_key = 'control.customers.erase' and r.tenant_id is null;
  if v_viewers = 0 or v_erasers = 0 then
    raise exception '129: the two new duties reached no platform role (% read, % raise) — a tab '
      'nobody can open is a tab that ends up opened by an unguarded route', v_viewers, v_erasers;
  end if;

  -- 7. and the gate itself wrote nothing.
  select count(*)::int into v_after from customer_data_requests;
  if v_after <> v_before then
    raise exception '129: the migration gate left % request row(s) behind', v_after - v_before;
  end if;

  raise notice '129: the copy and the erasure are live — % category word(s) bounded by the '
    'register''s own CHECK, % masked columns read back from information_schema, the preview tells '
    'a closed account from a live one (% keys, % kept), all nine doors answer without raising, the '
    'signature probe rolled itself back, % role(s) may read a data request, % may raise an '
    'erasure, and the register holds % row(s) before and after the gate.',
    array_length(v_words, 1), 78, v_keys, v_keeps, v_viewers, v_erasers, v_after;
end $$;

commit;
