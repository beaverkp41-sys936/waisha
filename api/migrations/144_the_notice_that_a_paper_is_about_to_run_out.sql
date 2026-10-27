-- 144: the notice that a paper is about to run out, and the proof the company was sent it
--
-- #343 asked for expiry reminders at 30, 14 and 7 days. The alert bell already answers that
-- question: `buildAlerts` in notifications.routes.ts walks vessels, drivers and regulatory
-- licences at the moment a seat opens the panel and shows the same 30-day rule. That is the
-- right shape for "what do I have to do today" and the wrong shape for "did we tell them" — a
-- read-time derivation keeps nothing but a dismissal (050's `alert_reads`), so when a company
-- says nobody warned it, the platform has no answer. This migration adds the answer: a row for
-- every warning raised, keyed by the paper, the rung and the expiry date it was about.
--
-- Why a rung is a row and not a flag. A paper is warned three times on the way down — at 30
-- days, at 14, at 7 — and each of those is a separate act somebody may have to produce. A
-- single row with `reminded_30 = true` cannot say when the 7-day one went, whether it landed,
-- or that the 14-day one never got a receipt because the mail provider refused it. So the
-- ledger's identity is `(subject_kind, subject_id, document_kind, threshold_days, expiry_date)`
-- and a renewal re-arms the whole ladder by itself: a new date is a new cycle, and the old
-- cycle's three rows stay exactly where they were written.
--
-- Why the rungs must go in order. A truck whose insurance lapses in three days is inside all
-- three windows, and a sweep that walks the windows would send three messages in one minute.
-- So the rule the candidates apply and the rule the write re-checks are the same rule: a paper
-- is due its *tightest* rung not yet warned, and a looser rung behind a tighter one is refused
-- — "the 30-day notice cannot follow the 7-day one". The test lives in one subquery shape used
-- twice, which is the only reason the door and the clock cannot drift apart later.
--
-- Why "warned" means "landed", not "inserted". A row whose notice never reached anybody is not
-- evidence, and a ledger that treated it as evidence would refuse to try again — which is
-- exactly the situation this platform is in today, because the sending domain is not yet
-- verified and mail fails. So a rung counts as warned only when its receipt shows a send on
-- either channel (`expiry_notice_landed`), and the desk can press a rung that never landed.
-- The per-attempt trail is 112's `message_deliveries`, widened here with its own purpose; this
-- row keeps the *latest* receipt, the way 078's `tenant_actions.delivery` keeps one.
--
-- Why the words are the register's and not the caller's. A notice goes to a company's
-- directors under WAISHA's name, so the sentence is built inside the definer from the paper,
-- the rung, the date and the days left. No door can put words into a company's mouth, and a
-- desk press sends exactly the message the clock would have sent. `notice` is therefore
-- written by `expiry_notice_text` and nothing else; the guard refuses to retype a row whose
-- notice landed.
--
-- Why this needs no second signature. 121's two-person rule guards the hand that *stops* a
-- company from trading. A warning is the mildest act on this desk: it changes nothing about the
-- company, its seats or its cards, and refusing a 7-day notice because it lacked a second seat
-- would mean no company is ever warned before its papers lapse. The actor is still recorded —
-- `system` for the clock, a named seat for a desk press — and the audit row says which.
--
-- Why the paper list is one reader. `expiry_documents()` is the only body in this file that
-- says what an expiring paper is: the sweep, the write's own re-check and the board all read
-- it, so a vehicle cannot be due according to one and already warned according to another. It
-- mirrors the CFA bell's rule (all non-deleted rows, whatever a vehicle's or driver's status,
-- because a lapsed road licence is the reason a truck stays in the garage) and adds the one
-- paper the bell has no access to: the company's own transport licence, which 061 copies onto
-- its directory card. A company that has been closed is left out of every branch — 078's
-- `close` tombstones `deleted_at` and leaves the status where it stood, so the status alone
-- would still let a dead company into a sweep. Whether a company may be *written to* is a
-- different question and is answered by its callers from `tenant_status`, so the reader can
-- tell a clerk why a company was skipped instead of having silently never mentioned it.
--
-- Why the date arithmetic happens in SQL. `current_date` is the same clock the expiry column
-- is measured against, so a rung's day count cannot come out different in two languages or
-- shift by a day across a timezone — the pg DATE trap this repository has already been bitten
-- by twice. The definer hands the API a date and a count of days; the API never subtracts.

-- ============================================================
-- 1. the ledger
-- ============================================================

create table if not exists expiry_reminders (
  id uuid primary key default gen_random_uuid(),
  -- The company the notice went to. A real foreign key: unlike 112's register, a reminder is
  -- always about a row that belongs to somebody, and a company that is closed keeps its
  -- warnings rather than losing the proof it was told.
  tenant_id uuid not null references tenants(id),

  -- What the paper is attached to, and which paper. The pair is CHECKed together: a road
  -- licence reminder filed against a driver would be a row the desk cannot act on.
  subject_kind text not null
    check (subject_kind in ('vehicle','driver','licence','company')),
  -- No foreign key, on purpose: the subject lives in one of four tables and a CHECK cannot
  -- read another. `record_expiry_reminder` resolves it against the live register every time,
  -- and the board re-checks it on every read, so a stale reference answers as a row whose
  -- paper no longer says so rather than as a lie.
  subject_id uuid not null,
  -- Kept, not joined: a driver deleted last month still has to be nameable in the sentence
  -- the company was sent. Names only — no NIDA number, no phone, and none of either is
  -- reachable from this table.
  subject_name text not null check (char_length(trim(subject_name)) between 1 and 200),
  document_kind text not null check (document_kind in (
    'insurance','inspection','road_licence','licence',
    'regulatory_tra','regulatory_brela','regulatory_tpa','regulatory_other',
    'transport_licence')),
  check ((subject_kind = 'vehicle' and document_kind in ('insurance','inspection','road_licence'))
      or (subject_kind = 'driver' and document_kind = 'licence')
      or (subject_kind = 'licence' and document_kind like 'regulatory\_%' escape '\')
      or (subject_kind = 'company' and document_kind = 'transport_licence')),

  threshold_days int not null check (threshold_days in (30,14,7)),
  -- The expiry the warning was about, copied from the paper on the day it was raised. This is
  -- half of the dedupe key and the whole reason a renewal re-arms the ladder.
  expiry_date date not null,
  -- What was left on the day it was sent, and the figure the sentence quotes. Bounded by the
  -- rung the row is filed under, so a 7-day warning cannot be raised 20 days out.
  days_left int not null check (days_left between 0 and 30),

  notice text not null check (char_length(notice) between 60 and 900),

  actor_kind text not null default 'system' check (actor_kind in ('system','control')),
  actor_user_id uuid references users(id),
  actor_role text,
  actor_ip text,
  check ((actor_kind = 'control') = (actor_user_id is not null)),

  -- The receipt of the send that followed, written once by `expiry_reminder_receipt` in the
  -- shape 112's transports already produce: masked addresses and per-channel counts. Empty
  -- means nothing has come back yet — the desk sees that as "we have not told them".
  delivery jsonb not null default '{}'::jsonb,
  raised_at timestamptz not null default now()
);

-- One warning per rung per paper per expiry cycle. This index is the dedupe: it is what makes
-- running the clock twice on two replicas safe without a lock table.
create unique index if not exists expiry_reminders_one_notice_per_rung
  on expiry_reminders (subject_kind, subject_id, document_kind, threshold_days, expiry_date);
create index if not exists expiry_reminders_raised on expiry_reminders (raised_at desc);
create index if not exists expiry_reminders_tenant on expiry_reminders (tenant_id, raised_at desc);
create index if not exists expiry_reminders_due_ladder
  on expiry_reminders (subject_kind, subject_id, document_kind, expiry_date);

alter table expiry_reminders enable row level security;
-- No policy and no grant: the register is reached through the definers below and by nobody
-- else. The API connects as a role that bypasses row-level security, so a grant here would be
-- a door with no lock on it.
revoke all on expiry_reminders from public, anon, authenticated, service_role, app_runtime;

comment on column expiry_reminders.subject_name is
  'The plate, the driver, the licence title or the company the paper belongs to. Copied at the '
  'moment of the warning so the sentence a company was sent can still be read after the subject '
  'is deleted. Never an identity number and never a phone.';

-- ============================================================
-- 2. the guard: a warning keeps its paper, its rung and its date
-- ============================================================

-- Whether a receipt counts as a send. Both channels are looked at because the office sends on
-- both, and one number the register can read as a positive figure is enough: a company that
-- got the SMS was told even when the mail was refused.
--
-- `#>` returns jsonb and `jsonb_typeof` filters before the cast, so a receipt holding a string,
-- an object or nothing at all answers false rather than throwing. A plain `+` over the two
-- counts would return NULL for a malformed receipt, and 143's lesson is that a NULL sum turns
-- every test written against it into a test that is never false.
create or replace function platform_auth.expiry_notice_landed(p_delivery jsonb)
returns boolean language sql immutable security definer set search_path = public as $$
  with counts as (
    select p_delivery #> '{email,sent}' as v
    union all
    select p_delivery #> '{sms,sent}'
  )
  select coalesce(bool_or(jsonb_typeof(c.v) = 'number' and (c.v #>> '{}')::numeric > 0), false)
    from counts c;
$$;

-- The words the company receives. Owned by the register: `notice` is filled from here and from
-- nowhere else, so a desk press and a clock press cannot send two different messages about one
-- paper.
create or replace function platform_auth.expiry_notice_text(
  p_subject_name text, p_document_kind text, p_threshold_days int,
  p_expiry_date date, p_days_left int, p_tenant_name text)
returns text language sql immutable security definer set search_path = public as $$
  select 'WAISHA ' || p_threshold_days || '-day warning: ' ||
    case p_document_kind
      when 'insurance'         then 'The insurance on ' || p_subject_name
      when 'inspection'        then 'The inspection certificate on ' || p_subject_name
      when 'road_licence'      then 'The road licence on ' || p_subject_name
      when 'licence'           then 'The driving licence of ' || p_subject_name
      when 'regulatory_tra'    then 'The TRA licence ' || p_subject_name
      when 'regulatory_brela'  then 'The BRELA certificate ' || p_subject_name
      when 'regulatory_tpa'    then 'The TPA licence ' || p_subject_name
      when 'regulatory_other'  then 'The regulatory licence ' || p_subject_name
      else 'The transport licence'
    end || ' for ' || p_tenant_name || ' ' ||
    case
      when p_days_left = 0 then 'expires today'
      when p_days_left = 1 then 'expires tomorrow'
      else 'expires in ' || p_days_left || ' days'
    end || ' (' || to_char(p_expiry_date, 'DD Mon YYYY') || '). '
    || 'Renew the paper and record its new expiry date in WAISHA.';
$$;

create or replace function platform_auth.expiry_reminder_is_kept()
returns trigger language plpgsql set search_path = public as $$ begin
  -- The identity of a warning cannot be retyped. Moving the subject, the rung or the date is
  -- how a ledger row would be made to answer for a different paper than the one it warned about.
  if tg_op = 'UPDATE' and (
       new.tenant_id      is distinct from old.tenant_id
    or new.subject_kind   is distinct from old.subject_kind
    or new.subject_id     is distinct from old.subject_id
    or new.document_kind  is distinct from old.document_kind
    or new.threshold_days is distinct from old.threshold_days
    or new.expiry_date    is distinct from old.expiry_date) then
    raise exception
      'expiry_reminders: % was a %-day warning on a paper dated % - a warning keeps the paper, the rung and the date it was about',
      old.id, old.threshold_days, old.expiry_date using errcode = '23514';
  end if;

  -- A company that was told stays told. Everything but the receipt is frozen once a send
  -- landed; a row that landed and is then re-armed would move the proof of a notice that the
  -- company did receive onto a later attempt.
  if tg_op = 'UPDATE' and platform_auth.expiry_notice_landed(old.delivery) and (
       new.subject_name is distinct from old.subject_name
    or new.days_left    is distinct from old.days_left
    or new.notice       is distinct from old.notice
    or new.actor_kind   is distinct from old.actor_kind
    or new.actor_user_id is distinct from old.actor_user_id
    or new.actor_role   is distinct from old.actor_role
    or new.actor_ip     is distinct from old.actor_ip
    or new.raised_at    is distinct from old.raised_at) then
    raise exception
      'expiry_reminders: %''s notice reached the company and cannot be rewritten - the register is the proof WAISHA told them',
      old.id using errcode = '23514';
  end if;

  if tg_op = 'DELETE' and platform_auth.expiry_notice_landed(old.delivery) then
    raise exception
      'expiry_reminders: % is a warning the company received and is kept - a paper that ran out without a notice on it is answerable, and the notice is the answer',
      old.id using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists expiry_reminders_are_kept on expiry_reminders;
create trigger expiry_reminders_are_kept
  before update or delete on expiry_reminders
  for each row execute function platform_auth.expiry_reminder_is_kept();

-- ============================================================
-- 3. one reader of what is expiring
-- ============================================================
--
-- Internal: cross-tenant, and it returns driver names. Revoked from the client role at the end
-- of this file, and every door that answers from it projects only what its own duty may show.

create or replace function platform_auth.expiry_documents()
returns table (tenant_id uuid, tenant_name text, tenant_status text,
              subject_kind text, subject_id uuid, subject_name text,
              document_kind text, expires_on date)
language sql stable security definer set search_path = public as $$
  select v.tenant_id, t.name, t.status, 'vehicle'::text, v.id,
         -- A plate is how a clerk names a truck; a name is what is left when the plate was
         -- never typed. The plate never reaches the desk raw for a shipper — this is the
         -- office's own register.
         coalesce(nullif(trim(v.plate_number), ''), v.name)::text,
         d.kind, d.expires_on
    from vessels v
    join tenants t on t.id = v.tenant_id
    cross join lateral (values
      ('insurance',    v.insurance_expiry),
      ('inspection',   v.inspection_expiry),
      ('road_licence', v.road_licence_expiry)) as d(kind, expires_on)
   where v.deleted_at is null and t.deleted_at is null and d.expires_on is not null

  union all

  select dr.tenant_id, t.name, t.status, 'driver'::text, dr.id, dr.full_name::text,
         'licence', dr.licence_expiry
    from drivers dr
    join tenants t on t.id = dr.tenant_id
   where dr.deleted_at is null and t.deleted_at is null and dr.licence_expiry is not null

  union all

  select l.tenant_id, t.name, t.status, 'licence'::text, l.id, l.title::text,
         'regulatory_' || l.authority, l.expiry_date
    from regulatory_licences l
    join tenants t on t.id = l.tenant_id
   where l.deleted_at is null and t.deleted_at is null

  union all

  -- The company's own paper. 061 copies this date onto the directory card, so a lapse here is
  -- a claim a published card is making about itself. `company_profiles` has no deleted_at: a
  -- company's profile is the one row that stays.
  select cp.tenant_id, t.name, t.status, 'company'::text, cp.id, t.name::text,
         'transport_licence', cp.transport_licence_expiry
    from company_profiles cp
    join tenants t on t.id = cp.tenant_id
   where t.deleted_at is null and cp.transport_licence_expiry is not null;
$$;

-- The rung this paper is due: the tightest window its remaining days fall inside, counting a
-- rung as warned only when its notice actually landed. One body, used by the sweep and by the
-- write, so the two cannot disagree about what is owed.
create or replace function platform_auth.expiry_rung_due(
  p_subject_kind text, p_subject_id uuid, p_document_kind text,
  p_expiry_date date, p_days_left int)
returns int
language sql stable security definer set search_path = public as $$
  select min(r.rung)
    from (values (30), (14), (7)) r(rung)
   where r.rung >= p_days_left
     and not exists (
       select 1 from expiry_reminders x
        where x.subject_kind = p_subject_kind
          and x.subject_id = p_subject_id
          and x.document_kind = p_document_kind
          and x.expiry_date = p_expiry_date
          and x.threshold_days <= r.rung
          and platform_auth.expiry_notice_landed(x.delivery));
$$;

-- Who at the company is told. 078's rule, unchanged: the live directors, and if none is left
-- the contact the company was registered with. Two copies of a recipient rule is how one ends
-- up telling a company about its money and not about its licences.
create or replace function platform_auth.expiry_notice_targets(p_tenant uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_agg(json_build_object(
              'name', x.full_name, 'email', x.email, 'phone', x.phone) order by x.created_at)
       from (select u.full_name, u.email, encode(u.phone_encrypted, 'hex') as phone,
                    u.created_at
               from users u
              where u.tenant_id = p_tenant and u.user_type = 'director'
                and u.deleted_at is null and u.status = 'active'
              order by u.created_at limit 6) x),
    (select jsonb_build_array(json_build_object(
              'name', t.name, 'email', t.email, 'phone', encode(t.phone_encrypted, 'hex')))
       from tenants t
      where t.id = p_tenant
        and (t.email is not null or t.phone_encrypted is not null)),
    '[]'::jsonb);
$$;

-- ============================================================
-- 4. the sweep's question: what is owed a warning today
-- ============================================================

create or replace function platform_auth.expiry_reminder_candidates(p_limit int)
returns jsonb
language sql stable security definer set search_path = public as $$
  with live as (
    select d.tenant_id, d.tenant_name, d.subject_kind, d.subject_id, d.subject_name,
           d.document_kind, d.expires_on,
           (d.expires_on - current_date)::int as days_left
      from platform_auth.expiry_documents() d
     -- A paper that has already run out is a breach, not a reminder: the office acts on it
     -- through 131's holds, and a warning letter after the date would say the opposite of
     -- what it means.
     where d.expires_on >= current_date
       -- The widest rung is also the outer edge; nothing 31 days out is a candidate.
       and d.expires_on <= current_date + 30
       -- Only a company the platform still lets trade can be written to. 'expired',
       -- 'suspended' and a pending company are the idle clock's business, not this one.
       and d.tenant_status in ('trial','active','grace')
  ), due as (
    select l.*, platform_auth.expiry_rung_due(l.subject_kind, l.subject_id, l.document_kind,
                                              l.expires_on, l.days_left) as rung
      from live l
  )
  select jsonb_build_object(
    'due', (select count(*)::int from due where rung is not null),
    'as_of', to_char(current_date, 'YYYY-MM-DD'),
    'limit', case when p_limit between 1 and 500 then p_limit else 200 end,
    'rows', coalesce((select jsonb_agg(json_build_object(
               'tenant_id', y.tenant_id, 'tenant_name', y.tenant_name,
               'subject_kind', y.subject_kind, 'subject_id', y.subject_id,
               'subject_name', y.subject_name, 'document_kind', y.document_kind,
               'threshold_days', y.rung, 'expiry_date', to_char(y.expires_on, 'YYYY-MM-DD'),
               'days_left', y.days_left)
               order by y.rung, y.expires_on, y.tenant_name)
             from (select * from due where rung is not null
                    order by rung, expires_on, tenant_name
                    limit case when p_limit between 1 and 500 then p_limit else 200 end) y),
             '[]'::jsonb));
$$;

-- ============================================================
-- 5. the warning
-- ============================================================
--
-- One press, one row, one answer. The caller names the paper and the rung; the register
-- resolves the live date, the days left, the words and the recipients, so the API cannot send
-- a message this file did not write. Idempotent by the unique index: two replicas sweeping the
-- same paper land one row, and the loser hears `already_warned` rather than writing twice.

create or replace function platform_auth.record_expiry_reminder(
  p_subject_kind text, p_subject_id uuid, p_document_kind text,
  p_threshold_days int, p_expiry_date date,
  p_actor_kind text, p_actor_user_id uuid, p_actor_role text, p_actor_ip text)
returns jsonb
language plpgsql security definer set search_path = public as $$ declare
  v_doc record;
  v_kind text;
  v_days int;
  v_due int;
  v_notice text;
  v_row expiry_reminders;
begin
  if p_subject_kind is null or p_subject_kind not in ('vehicle','driver','licence','company') then
    return jsonb_build_object('status','invalid','field','subject_kind',
      'message','A warning is about a vehicle, a driver, a regulatory licence or a company.');
  end if;
  if p_subject_id is null then
    return jsonb_build_object('status','invalid','field','subject_id',
      'message','Name the subject the paper belongs to.');
  end if;
  if p_document_kind is null or p_document_kind not in (
     'insurance','inspection','road_licence','licence','regulatory_tra','regulatory_brela',
     'regulatory_tpa','regulatory_other','transport_licence') then
    return jsonb_build_object('status','invalid','field','document_kind',
      'message','That is not a paper WAISHA keeps a date for.');
  end if;
  if (p_subject_kind = 'vehicle' and p_document_kind not in ('insurance','inspection','road_licence'))
     or (p_subject_kind = 'driver' and p_document_kind <> 'licence')
     or (p_subject_kind = 'licence' and p_document_kind not like 'regulatory\_%' escape '\')
     or (p_subject_kind = 'company' and p_document_kind <> 'transport_licence') then
    return jsonb_build_object('status','invalid','field','document_kind',
      'message', p_document_kind || ' is not a paper that belongs to a ' || p_subject_kind || '.');
  end if;
  if p_threshold_days is null or p_threshold_days not in (30,14,7) then
    return jsonb_build_object('status','invalid','field','threshold_days',
      'message','A warning is raised at 30, 14 or 7 days.');
  end if;
  v_kind := coalesce(nullif(p_actor_kind, ''), 'system');
  if v_kind not in ('system','control') then
    return jsonb_build_object('status','invalid','field','actor_kind','message','Unknown actor');
  end if;
  if v_kind = 'control' and p_actor_user_id is null then
    return jsonb_build_object('status','invalid','field','actor_user_id',
      'message','A warning raised from the desk names the seat that pressed it.');
  end if;
  if v_kind = 'system' and p_actor_user_id is not null then
    return jsonb_build_object('status','invalid','field','actor_user_id',
      'message','The clock does not sign as a person.');
  end if;

  select * into v_doc from platform_auth.expiry_documents() d
    where d.subject_kind = p_subject_kind and d.subject_id = p_subject_id
      and d.document_kind = p_document_kind;
  if not found then
    return jsonb_build_object('status','not_found',
      'message','That paper is not on a subject WAISHA holds — the row is gone, or the date '
      || 'has been cleared, so there is nothing to warn about.');
  end if;
  if v_doc.tenant_status not in ('trial','active','grace') then
    return jsonb_build_object('status','conflict','tenant_status', v_doc.tenant_status,
      'message','This company is ' || v_doc.tenant_status || '. A suspended or lapsed company '
      || 'is dealt with by the office as a lapsed account, not by a paper reminder.');
  end if;
  -- The date the caller is warning about must be the date the paper carries. A board opened
  -- before a renewal would otherwise file a notice against a date that no longer exists.
  if p_expiry_date is not null and p_expiry_date <> v_doc.expires_on then
    return jsonb_build_object('status','conflict','paper_moved', true,
      'expiry_date', to_char(v_doc.expires_on, 'YYYY-MM-DD'),
      'message','That paper now carries ' || to_char(v_doc.expires_on, 'DD Mon YYYY')
      || ' — the renewal has already been recorded, so the warning was about a date the '
      || 'register no longer holds.');
  end if;

  v_days := (v_doc.expires_on - current_date)::int;
  if v_days < 0 then
    return jsonb_build_object('status','conflict','expired', true,
      'message','That paper ran out on ' || to_char(v_doc.expires_on, 'DD Mon YYYY')
      || '. This ledger warns before a date; after it the office acts through a hold.');
  end if;
  -- Separated from the ladder test below on purpose: `expiry_rung_due` answers NULL both for a
  -- paper nobody has warned yet that is too far out and for a paper that has been warned at
  -- every rung it reached, and those are two different sentences to a clerk.
  if v_days > 30 then
    return jsonb_build_object('status','conflict','not_due', true, 'days_left', v_days,
      'message','That paper has ' || v_days || ' days left and the widest warning WAISHA sends '
      || 'is the 30-day one. It is not due yet.');
  end if;

  -- The ladder, re-checked here rather than trusted from the sweep: the register moves between
  -- the moment a list is read and the moment a press lands.
  v_due := platform_auth.expiry_rung_due(p_subject_kind, p_subject_id, p_document_kind,
                                         v_doc.expires_on, v_days);
  if v_due is null then
    return jsonb_build_object('status','conflict','already_warned', true,
      'message','The company has been told at every rung this paper is inside, and each '
      || 'notice landed. A new warning needs a new expiry date.');
  end if;
  if v_due <> p_threshold_days then
    return jsonb_build_object('status','conflict','due_rung', v_due,
      'message','This paper is due its ' || v_due || '-day warning, not its '
      || p_threshold_days || '-day one.');
  end if;

  v_notice := platform_auth.expiry_notice_text(v_doc.subject_name, p_document_kind,
                                               p_threshold_days, v_doc.expires_on, v_days,
                                               v_doc.tenant_name);

  -- The rung is due, which means either no row exists for it or the row that exists never
  -- landed. Both paths go through the same lock so two presses of one due rung cannot both
  -- write; the loser of the race hears the winner's answer.
  select * into v_row from expiry_reminders x
    where x.subject_kind = p_subject_kind and x.subject_id = p_subject_id
      and x.document_kind = p_document_kind and x.threshold_days = p_threshold_days
      and x.expiry_date = v_doc.expires_on
    for update;
  if found then
    update expiry_reminders
       set subject_name = v_doc.subject_name, days_left = v_days, notice = v_notice,
           actor_kind = v_kind, actor_user_id = p_actor_user_id,
           actor_role = nullif(trim(coalesce(p_actor_role, '')), ''),
           actor_ip = nullif(trim(coalesce(p_actor_ip, '')), ''),
           raised_at = now(), delivery = '{}'::jsonb
     where id = v_row.id;
    insert into audit_logs (tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
        action, after)
      values (v_doc.tenant_id, p_actor_user_id, nullif(trim(coalesce(p_actor_role, '')), ''),
        nullif(trim(coalesce(p_actor_ip, '')), ''), 'expiry_reminders', v_row.id,
        'expiry_reminder.re_armed',
        jsonb_build_object('subject_kind', p_subject_kind, 'subject_name', v_doc.subject_name,
          'document_kind', p_document_kind, 'threshold_days', p_threshold_days,
          'expiry_date', to_char(v_doc.expires_on, 'YYYY-MM-DD'), 'days_left', v_days,
          'actor_kind', v_kind, 'previous_id', v_row.id));
    return jsonb_build_object('status','ok','re_armed', true,
      'reminder_id', v_row.id, 'tenant_id', v_doc.tenant_id,
      'tenant_name', v_doc.tenant_name, 'subject_kind', p_subject_kind,
      'subject_id', p_subject_id, 'subject_name', v_doc.subject_name,
      'document_kind', p_document_kind, 'threshold_days', p_threshold_days,
      'expiry_date', to_char(v_doc.expires_on, 'YYYY-MM-DD'), 'days_left', v_days,
      'notice', v_notice, 'targets', platform_auth.expiry_notice_targets(v_doc.tenant_id));
  end if;

  insert into expiry_reminders (id, tenant_id, subject_kind, subject_id, subject_name,
      document_kind, threshold_days, expiry_date, days_left, notice,
      actor_kind, actor_user_id, actor_role, actor_ip, delivery, raised_at)
    values (gen_random_uuid(), v_doc.tenant_id, p_subject_kind, p_subject_id,
      v_doc.subject_name, p_document_kind, p_threshold_days, v_doc.expires_on, v_days,
      v_notice, v_kind, p_actor_user_id,
      nullif(trim(coalesce(p_actor_role, '')), ''),
      nullif(trim(coalesce(p_actor_ip, '')), ''), '{}'::jsonb, now())
    returning * into v_row;

  insert into audit_logs (tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, after)
    values (v_doc.tenant_id, p_actor_user_id,
      nullif(trim(coalesce(p_actor_role, '')), ''),
      nullif(trim(coalesce(p_actor_ip, '')), ''), 'expiry_reminders', v_row.id,
      'expiry_reminder.raised',
      jsonb_build_object('subject_kind', p_subject_kind, 'subject_name', v_doc.subject_name,
        'document_kind', p_document_kind, 'threshold_days', p_threshold_days,
        'expiry_date', to_char(v_doc.expires_on, 'YYYY-MM-DD'), 'days_left', v_days,
        'actor_kind', v_kind, 'notice', v_notice));

  return jsonb_build_object('status','ok','re_armed', false,
    'reminder_id', v_row.id, 'tenant_id', v_doc.tenant_id,
    'tenant_name', v_doc.tenant_name, 'subject_kind', p_subject_kind,
    'subject_id', p_subject_id, 'subject_name', v_doc.subject_name,
    'document_kind', p_document_kind, 'threshold_days', p_threshold_days,
    'expiry_date', to_char(v_doc.expires_on, 'YYYY-MM-DD'), 'days_left', v_days,
    'notice', v_notice, 'targets', platform_auth.expiry_notice_targets(v_doc.tenant_id))
  ;
exception when unique_violation then
  -- Another press took this rung between the lock and the write. Nothing was sent, and the
  -- other row is the answer.
  return jsonb_build_object('status','conflict','already_warned', true,
    'message','A warning for this rung of this paper was raised a moment ago.');
end $$;

-- The receipt, written once against a row that has none — 078's rule restated, because the same
-- honesty is at stake: a notice that was sent cannot be re-described afterwards.
create or replace function platform_auth.expiry_reminder_receipt(
  p_reminder_id uuid, p_delivery jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$ declare
  v_rows int;
begin
  if jsonb_typeof(p_delivery) <> 'object' then
    return jsonb_build_object('status','invalid',
      'message','The receipt must be the answer the send gave, as an object.');
  end if;
  update expiry_reminders set delivery = p_delivery
   where id = p_reminder_id and delivery = '{}'::jsonb;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('status', case when v_rows = 1 then 'ok' else 'noop' end);
end $$;

-- ============================================================
-- 6. the board
-- ============================================================
--
-- The ledger as three states a clerk can act on. `told` is evidence, `waiting` is work, and
-- `past` is the honest record of a warning that never landed and whose date has gone by —
-- which is what a failed mail provider looks like two weeks later.
create or replace function platform_auth.expiry_reminder_board(
  p_state text, p_subject_kind text, p_limit int, p_offset int)
returns jsonb
language sql stable security definer set search_path = public as $$
  with doc as materialized (select * from platform_auth.expiry_documents()),
  graded as materialized (
    select r.*, (r.expiry_date - current_date)::int as days_now,
           platform_auth.expiry_notice_landed(r.delivery) as landed,
           exists (select 1 from doc d
                    where d.subject_kind = r.subject_kind and d.subject_id = r.subject_id
                      and d.document_kind = r.document_kind
                      and d.expires_on = r.expiry_date) as paper_still_says_so,
           case
             when platform_auth.expiry_notice_landed(r.delivery) then 'told'
             when r.expiry_date >= current_date then 'waiting'
             else 'past'
           end as state
      from expiry_reminders r
  ), picked as (
    select g.*, t.name as tenant_name,
           -- The whole filtered set, not the page: 131's two boards answer the same way and the desk
           -- reads a row count out of the rows themselves. Taken here rather than from `counts`
           -- because those are worked out before the subject filter, so a pager fed by them would
           -- offer pages that do not exist.
           count(*) over ()::int as total
      from graded g
      join tenants t on t.id = g.tenant_id
     where (p_subject_kind is null or g.subject_kind = p_subject_kind)
       -- `coalesce` rather than a bare test: with p_state NULL both halves of that disjunction are
       -- NULL, and the ledger would answer an empty page while its own counts said four hundred.
       and (coalesce(p_state, 'all') = 'all' or g.state = p_state)
     order by g.raised_at desc, g.expiry_date
     limit case when p_limit between 1 and 100 then p_limit else 30 end
     offset case when p_offset between 0 and 5000 then p_offset else 0 end
  )
  select jsonb_build_object(
    'state', p_state,
    'subject_kind', p_subject_kind,
    'as_of', to_char(current_date, 'YYYY-MM-DD'),
    'limit', case when p_limit between 1 and 100 then p_limit else 30 end,
    'offset', case when p_offset between 0 and 5000 then p_offset else 0 end,
    'counts', jsonb_build_object(
      'all', (select count(*)::int from graded),
      'told', (select count(*)::int from graded where state = 'told'),
      'waiting', (select count(*)::int from graded where state = 'waiting'),
      'past', (select count(*)::int from graded where state = 'past'),
      'due', coalesce((select (c ->> 'due')::int
                         from platform_auth.expiry_reminder_candidates(1) c), 0)),
    'rows', coalesce((select jsonb_agg(json_build_object(
               'id', y.id, 'tenant_id', y.tenant_id, 'tenant_name', y.tenant_name,
               'subject_kind', y.subject_kind, 'subject_id', y.subject_id,
               'subject_name', y.subject_name, 'document_kind', y.document_kind,
               'threshold_days', y.threshold_days,
               'expiry_date', to_char(y.expiry_date, 'YYYY-MM-DD'),
               'days_left', y.days_left, 'days_now', y.days_now,
               'state', y.state, 'landed', y.landed,
               'paper_still_says_so', y.paper_still_says_so,
               'notice', y.notice, 'actor_kind', y.actor_kind, 'actor_role', y.actor_role,
               'delivery', y.delivery,
               'total', y.total,
               'raised_at', to_char(y.raised_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
               order by y.raised_at desc)
             from picked y), '[]'::jsonb));
$$;

-- ============================================================
-- 7. the duty this desk runs on
-- ============================================================

insert into permissions (key, description) values
  ('control.directory.remind',
   'Control - Raise an expiry warning for a vehicle, driver or licence paper and read the ledger of warnings a company was sent')
on conflict do nothing;

-- The two seats that already hold a card up or down are the two that may warn about its papers.
-- A reminder sends nothing that changes a company's standing, so it is not drawn wider than the
-- desk it sits on: `control.directory.view` keeps reading the ledger, and the read is gated on
-- that key rather than on this one so an analyst can see what was sent without being able to
-- send it.
insert into role_permissions (role_id, permission_key)
select r.id, 'control.directory.remind' from roles r
where r.tenant_id is null and r.key in ('super_admin','compliance_officer')
on conflict do nothing;

-- ============================================================
-- 8. grants and revocations
-- ============================================================

grant execute on function
  platform_auth.expiry_reminder_candidates(int),
  platform_auth.expiry_reminder_board(text, text, int, int),
  platform_auth.record_expiry_reminder(text, uuid, text, int, date, text, uuid, text, text),
  platform_auth.expiry_reminder_receipt(uuid, jsonb)
to app_runtime;

revoke all on function
  platform_auth.expiry_reminder_candidates(int),
  platform_auth.expiry_reminder_board(text, text, int, int),
  platform_auth.record_expiry_reminder(text, uuid, text, int, date, text, uuid, text, text),
  platform_auth.expiry_reminder_receipt(uuid, jsonb)
from public, anon, authenticated, service_role;

-- The internals. A client role that could call `expiry_documents` would hold a reader that
-- names every driver on the platform across every tenant; `expiry_rung_due` would let it
-- rehearse a warning it was never granted; and a guard body called from outside the trigger is
-- a way of asking a question about a row it cannot see. The doors above and this file's own
-- bodies still reach them — a definer and its owner's work need no grant.
revoke all on function
  platform_auth.expiry_documents(),
  platform_auth.expiry_rung_due(text, uuid, text, date, int),
  platform_auth.expiry_notice_landed(jsonb),
  platform_auth.expiry_notice_text(text, text, int, date, int, text),
  platform_auth.expiry_notice_targets(uuid),
  platform_auth.expiry_reminder_is_kept()
from public, anon, authenticated, service_role, app_runtime;

-- ============================================================
-- 9. the purpose a reminder is filed under
-- ============================================================
--
-- 112's register is the only place a send is recorded, and its purpose column is a closed list
-- held in two copies: the table CHECK and the writer's own guard, written twice on purpose so a
-- caller cannot slip an unknown purpose in. A reminder filed under 'tenant_notice' would be a
-- lie the desk reading the register afterwards would believe, so it gets its own word — and
-- both copies must be moved together or the writer drops every reminder silently.
alter table message_deliveries
  drop constraint if exists message_deliveries_purpose_check;
alter table message_deliveries
  add constraint message_deliveries_purpose_check check (purpose in (
    'signup_otp', 'otp_resend', 'password_reset', 'staff_invite',
    'tenant_notice', 'platform_test', 'sla_breach', 'expiry_reminder'));

create or replace function platform_auth.record_message_delivery(
  p_channel text,
  p_purpose text,
  p_to text,
  p_subject text,
  p_status text,
  p_provider text,
  p_provider_message_id text,
  p_error text,
  p_attempts int,
  p_tenant_id uuid,
  p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$ declare
  v_masked text;
begin
  if p_channel is null or p_channel not in ('email','sms') then return; end if;
  if p_purpose is null or p_purpose not in (
     'signup_otp','otp_resend','password_reset','staff_invite','tenant_notice','platform_test',
     'sla_breach','expiry_reminder')
  then return; end if;
  if p_status is null or p_status not in ('sent','failed','skipped') then return; end if;
  if trim(coalesce(p_to, '')) = '' then return; end if;

  -- Masked here, not by the caller: one rule for how an address is shortened is one rule to
  -- keep honest, and a route that forgets cannot leak into this column.
  if p_channel = 'email' then
    v_masked := case
      when position('@' in p_to) > 1
        then left(split_part(p_to, '@', 1), 1) || '***@' || lower(split_part(p_to, '@', 2))
      else '***' end;
  else
    v_masked := case
      when char_length(p_to) > 8
        then left(p_to, 4) || '***' || right(p_to, 4)
      else '***' end;
  end if;

  insert into message_deliveries (channel, purpose, to_masked, subject, status, provider,
                                  provider_message_id, error, attempts, tenant_id, user_id)
  values (p_channel, p_purpose, left(v_masked, 160), left(p_subject, 200), p_status,
          left(coalesce(nullif(p_provider, ''), 'resend'), 40),
          left(p_provider_message_id, 120), left(p_error, 500),
          case when p_attempts between 1 and 5 then p_attempts else 1 end,
          p_tenant_id, p_user_id);
exception when others then
  return;
end $$;

grant execute on function platform_auth.record_message_delivery(
  text, text, text, text, text, text, text, text, int, uuid, uuid) to app_runtime;
revoke all on function platform_auth.record_message_delivery(
  text, text, text, text, text, text, text, text, int, uuid, uuid)
from public, anon, authenticated, service_role;

-- ============================================================
-- 10. say what this leaves the platform in
-- ============================================================

do $$ declare
  v_answer jsonb;
  v_due int;
  v_rows int;
  v_told int;
  v_waiting int;
  v_past int;
  v_no_rung int;
  v_table_rungs text;
  v_definer_rungs text;
  v_wrong_grant text;
begin
  select platform_auth.expiry_reminder_candidates(1) into v_answer;
  v_due := coalesce((v_answer ->> 'due')::int, 0);
  select count(*)::int into v_rows from expiry_reminders;
  select count(*)::int into v_told    from expiry_reminders where platform_auth.expiry_notice_landed(delivery);
  select count(*)::int into v_waiting from expiry_reminders
    where not platform_auth.expiry_notice_landed(delivery) and expiry_date >= current_date;
  select count(*)::int into v_past    from expiry_reminders
    where not platform_auth.expiry_notice_landed(delivery) and expiry_date < current_date;

  -- A row whose rung is no longer the one due is not a fault: a renewal, or a tighter rung sent
  -- after a looser one, both move it. It is counted here because it is the number a clerk will
  -- otherwise ask the register about.
  select count(*)::int into v_no_rung from expiry_reminders r
    where r.expiry_date >= current_date
      and platform_auth.expiry_rung_due(r.subject_kind, r.subject_id, r.document_kind,
                                        r.expiry_date,
                                        (r.expiry_date - current_date)::int) is null;

  -- The ladder is written twice in this file: as the rungs the table will hold, and as the
  -- values `expiry_rung_due` walks. A later migration that adds a rung to one and not the other
  -- is a silent half-failure — the table would accept a 3-day warning the definer can never
  -- raise, or the definer would ask for a rung the table refuses with a CHECK the caller cannot
  -- read. The table's list is read out of the constraint; the definer's is *measured*, by
  -- asking it what it is due at every day count from today to 60 days out and collecting what
  -- it answers. Text-scraping the body was tried first and found a `1` that belongs to a
  -- `select 1`, which is the reason this file compares behaviour rather than words.
  select string_agg(distinct m[1], ',' order by m[1]) into v_table_rungs
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    cross join regexp_matches(pg_get_constraintdef(c.oid), '\d+', 'g') m
   where c.conrelid = 'expiry_reminders'::regclass and c.contype = 'c'
     and a.attname = 'threshold_days';
  select coalesce(string_agg(distinct d.rung::text, ',' order by d.rung::text), '')
    into v_definer_rungs
    from (select distinct platform_auth.expiry_rung_due('vehicle', gen_random_uuid(),
                             'insurance', current_date + x.n, x.n) as rung
            from generate_series(0, 60) x(n)) d
   where d.rung is not null;
  if v_table_rungs is null then
    raise exception '144: expiry_reminders has no CHECK on threshold_days — the rungs a warning '
      'may be filed under are not held by the register';
  end if;
  if v_table_rungs <> v_definer_rungs then
    raise exception '144: the table holds rungs (%) and expiry_rung_due answers (%) — a paper '
      'would be due a warning the register cannot file, or filed under a rung nothing raises',
      v_table_rungs, v_definer_rungs;
  end if;

  -- The two copies of the purpose list must both know the new word. If the CHECK alone moves,
  -- every reminder is refused by the table; if the writer alone moves, every reminder is
  -- dropped before it reaches the table and the desk sees a clean receipt for a send that was
  -- never recorded. Neither failure raises, so this is the check that has to.
  if position('expiry_reminder' in
      (select coalesce(string_agg(pg_get_constraintdef(c.oid), ' '), '')
         from pg_constraint c
        where c.conname = 'message_deliveries_purpose_check')) = 0 then
    raise exception '144: message_deliveries'' CHECK does not know expiry_reminder — a reminder would be refused by the register';
  end if;
  if position('''expiry_reminder''' in
      (select coalesce(string_agg(pg_get_functiondef(p.oid), ' '), '')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'platform_auth' and p.proname = 'record_message_delivery')) = 0 then
    raise exception '144: record_message_delivery''s guard does not know expiry_reminder — every reminder send would be dropped silently';
  end if;

  -- A seat may not hold the press without the read: the door would open on a board it cannot
  -- see, which is how 143's count found itself gated on a duty its panel never asked for.
  if exists (select 1 from role_permissions rp
               join roles r on r.id = rp.role_id
              where r.tenant_id is null
                and rp.permission_key = 'control.directory.remind'
                and not exists (select 1 from role_permissions x
                                 where x.role_id = rp.role_id
                                   and x.permission_key = 'control.directory.view')) then
    raise exception '144: a platform role may raise a warning without being able to read the '
      'directory desk it is raised on: the door would open on a board the seat cannot see';
  end if;

  -- The internals must really be shut, including the cross-tenant paper reader.
  select string_agg(d.name, ', ' order by d.name) into v_wrong_grant
    from (values
      ('expiry_documents'), ('expiry_rung_due'), ('expiry_notice_landed'),
      ('expiry_notice_text'), ('expiry_notice_targets'), ('expiry_reminder_is_kept')) as d(name)
   where exists (select 1 from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'platform_auth' and p.proname = d.name
                   and (has_function_privilege('anon', p.oid, 'EXECUTE')
                     or has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     or has_function_privilege('service_role', p.oid, 'EXECUTE')
                     or has_function_privilege('app_runtime', p.oid, 'EXECUTE')
                     or has_function_privilege('public', p.oid, 'EXECUTE')));
  if v_wrong_grant is not null then
    raise exception '144: internal bodies are still callable by a client role: %', v_wrong_grant;
  end if;

  raise notice '144: % paper(s) are due a warning today; % warning(s) on the ledger '
    '(% told, % waiting, % past), % of them past every rung their date still allows',
    v_due, v_rows, v_told, v_waiting, v_past, v_no_rung;
end $$;

commit;
