-- 070 — the recommendation inbox (spec: admin panel, task #118).
--
-- Everything the panel has been built so far reports on: companies, money, seats, the
-- shape of the system itself. Nothing in it had a way for the people actually using the
-- product to say "this is the thing that is wrong" or "this is the thing I wish it did".
-- That feedback exists today — it arrives by phone to a director who mentions it to
-- whoever answers the office — and none of it is written down anywhere.
--
-- The table lives in the AUTHOR's tenant, not the platform's. That is the whole design
-- decision in this migration, and it is the cheaper one: a company writing its own
-- suggestion is a normal tenant-scoped insert that the policies written for 001 already
-- allow, so there is no SECURITY DEFINER on the write path at all, and an author reading
-- back their own list — including whatever the desk replied — is the same. DEFINER
-- appears only where a read or a write genuinely crosses tenants: the desk's register,
-- and the desk's decision on a row that belongs to somebody else's company. 067's
-- lesson, applied: do not open a wider door than RLS already holds shut.
--
-- What is deliberately NOT here: no notification (the control desk is opened by a
-- person, not woken by an alert, and 066's trail already records the act), no vote or
-- like count (a register of 12 companies cannot rank anything), no attachment (the
-- body is text and the file it describes is already in the vault), and no edit of a
-- submitted body — a recommendation that has been read must not be quietly rewritten.
-- An author who mis-posted can withdraw it while it is still unread.
--
-- Money rule honoured throughout: none. No price, no invoice, no credit is attached to
-- a suggestion or to a "built" status.

begin;

-- ============================================================
-- 1. THE REGISTER
-- ============================================================

create table if not exists recommendations (
  id uuid primary key default gen_random_uuid(),
  -- The AUTHOR's company (a seeker owns a tenant of type 'seeker', 060, so the same
  -- column serves both audiences and RLS scopes both without a special case).
  tenant_id uuid not null references tenants(id),
  author_user_id uuid not null references users(id),
  -- Which part of the product the note is about. 'other' exists so that a person who
  -- cannot find their box still sends the sentence instead of not sending it.
  area text not null default 'other'
    check (area in ('transport','cfa','office','marketplace','billing','documents',
                    'account','support','other')),
  -- A title short enough to read in a list, a body long enough to act on. The lower
  -- bound on the body is the one that matters: it is what stops the table filling with
  -- "make it better" and keeps every row worth the desk's time.
  title text not null check (char_length(trim(title)) between 4 and 140),
  body text not null check (char_length(trim(body)) between 15 and 4000),
  status text not null default 'new'
    check (status in ('new','reviewing','planned','built','declined')),
  -- The desk's read of urgency, never the author's: an author who can set a priority
  -- sets every priority to high.
  priority text check (priority in ('high','medium','low')),
  -- What the desk said back. Null until someone answers; the author sees exactly this.
  reply text check (reply is null or char_length(trim(reply)) between 5 and 2000),
  replied_by uuid, replied_at timestamptz,
  decided_by uuid, decided_at timestamptz,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- A card only leaves 'new' through a recorded act, and a sentence only exists because
  -- somebody signed it. Without these, "who closed this" and "did we ever answer them"
  -- both become unanswerable — which is how a suggestions box becomes a void.
  check (status = 'new' or (decided_by is not null and decided_at is not null)),
  check (reply is null or (replied_by is not null and replied_at is not null))
);
create trigger trg_recommendations_updated before update on recommendations
  for each row execute function public.set_updated_at();

-- The author's own list, newest first.
create index idx_recommendations_author on recommendations (tenant_id, author_user_id, created_at desc)
  where deleted_at is null;
-- The desk's queue. Deliberately not tenant-prefixed: the inbox is one list across every
-- company, and 'new' is the only state anyone opens it to look at.
create index idx_recommendations_queue on recommendations (status, created_at desc)
  where deleted_at is null;
create index idx_recommendations_area on recommendations (area, created_at desc)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- POLICY + GRANT together (016 lesson). No DELETE: a withdrawn suggestion is
-- soft-deleted by an update to deleted_at, so a retracted note still counts in
-- "how many did we receive" instead of vanishing from the record.
-- ---------------------------------------------------------------------------
alter table recommendations enable row level security;
create policy recommendations_tenant on recommendations for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on recommendations to app_runtime;

comment on column recommendations.priority is
  'Set by the desk, never by the author. Null means nobody has judged it yet.';
comment on column recommendations.decided_at is
  'Stamped on every status change: who last triaged this and when, not who first opened it.';

-- ============================================================
-- 2. THE DESK'S REGISTER — one list across every company
-- ============================================================
--
-- SECURITY DEFINER for the standing reason: this crosses tenants, and a bare query has
-- no app.tenant_id, so RLS would answer with nothing and the inbox would look empty on a
-- busy system.
--
-- Filtered and capped inside the function rather than in the route (068's rule), so a
-- control request cannot forget a parameter and ask for the whole table. `matched` and
-- `matched_new` are window counts over the FILTERED set computed before the LIMIT, so the
-- header line and the rows underneath it come from one statement and cannot disagree.
--
-- The author's name and address come along because a recommendation the desk cannot call
-- back about is not actionable — this is the same identity the forensic reader (066)
-- already hands a control seat, and nothing wider: no phone, no NIDA, no tenant secrets.

drop function if exists platform_auth.control_recommendation_register(text, text, text, text, int);
create or replace function platform_auth.control_recommendation_register(
  p_status text default null,
  p_area text default null,
  p_priority text default null,
  p_search text default null,
  p_limit int default 200
) returns table (
  id uuid, created_at timestamptz,
  tenant_id uuid, company_name text, company_type text,
  author_user_id uuid, author_name text, author_email text,
  author_type text, author_job_title text,
  area text, title text, body text, status text, priority text,
  reply text, replied_at timestamptz, replied_by_name text,
  decided_at timestamptz, decided_by_name text,
  matched int, matched_new int
) language sql stable security definer set search_path = public as $$
  select r.id, r.created_at,
         t.id, t.name, t.type,
         u.id, u.full_name, lower(u.email), u.user_type, u.job_title,
         r.area, r.title, r.body, r.status, r.priority,
         r.reply, r.replied_at, rb.full_name,
         r.decided_at, db.full_name,
         count(*) over ()::int as matched,
         count(*) filter (where r.status = 'new') over ()::int as matched_new
    from recommendations r
    join tenants t on t.id = r.tenant_id
    join users u on u.id = r.author_user_id
    left join users rb on rb.id = r.replied_by
    left join users db on db.id = r.decided_by
   where r.deleted_at is null
     and (p_status is null or r.status = p_status)
     and (p_area is null or r.area = p_area)
     and (p_priority is null or r.priority = p_priority)
     and (p_search is null or trim(p_search) = ''
          or r.title ilike '%' || trim(p_search) || '%'
          or r.body ilike '%' || trim(p_search) || '%'
          or t.name ilike '%' || trim(p_search) || '%'
          or coalesce(u.full_name, '') ilike '%' || trim(p_search) || '%')
   order by case when r.status = 'new' then 0 else 1 end, r.created_at desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;

-- ============================================================
-- 3. THE DESK'S DECISION
-- ============================================================
--
-- A write into somebody else's tenant, so it has to be a definer — and that is exactly
-- why it takes no tenant parameter at all. The caller names a recommendation by id and
-- the row's own tenant is whatever the register said it was; there is no argument here
-- that could point the update at a company the caller did not see.
--
-- The vocabulary is re-checked inside the function even though the route validates it,
-- because a definer is called by SQL too, and a status that is not in the list would
-- otherwise land as a 23514 check violation — a 500 on a screen that was really answered.

drop function if exists platform_auth.record_recommendation_decision(uuid, text, text, text, uuid);
create or replace function platform_auth.record_recommendation_decision(
  p_id uuid,
  p_status text,
  p_priority text default null,
  p_reply text default null,
  p_actor uuid default null
) returns table (id uuid, status text, priority text, reply text)
language plpgsql volatile security definer set search_path = public as $$
declare
  r recommendations;
  v_rows int;
  v_reply text := nullif(trim(coalesce(p_reply, '')), '');
  v_status text := nullif(trim(coalesce(p_status, '')), '');
begin
  if v_status is null or v_status not in ('new','reviewing','planned','built','declined') then
    raise exception 'That is not a state a recommendation can be in.' using errcode = 'P0001';
  end if;
  -- The table will not hold a triaged row without a triager, so say so here as a sentence
  -- rather than letting the check answer 23514, which is a 500 to a screen that was really
  -- refused. Every control route passes its own seat id; this is the door behind it.
  if v_status <> 'new' and p_actor is null then
    raise exception 'A decision needs the seat that made it.' using errcode = 'P0001';
  end if;
  if p_priority is not null
     and p_priority not in ('high','medium','low') then
    raise exception 'Priority is high, medium or low — or nothing yet.' using errcode = 'P0001';
  end if;
  if v_reply is not null and char_length(v_reply) < 5 then
    raise exception 'An answer is either a sentence of at least five characters or nothing at all.'
      using errcode = 'P0001';
  end if;
  if v_reply is not null and char_length(v_reply) > 2000 then
    raise exception 'An answer longer than 2,000 characters belongs in an email, not here.'
      using errcode = 'P0001';
  end if;

  select * into r from recommendations where recommendations.id = p_id and deleted_at is null;
  if not found then
    raise exception 'That recommendation is not on the register.' using errcode = 'P0001';
  end if;
  -- Everything above read parameters or the row just fetched; nothing relied on a value
  -- assigned in the DECLARE list, which is the 063 trap (initialisers see the empty
  -- record, not the row).

  update recommendations
     set status = v_status,
         priority = coalesce(p_priority, recommendations.priority),
         -- A decision record only exists with a name and a moment attached to it, so an
         -- untriaged card cannot carry a triager.
         decided_by = case when recommendations.status is distinct from v_status
                           then p_actor else recommendations.decided_by end,
         decided_at = case when recommendations.status is distinct from v_status
                           then now() else recommendations.decided_at end,
         reply = v_reply,
         replied_by = case when v_reply is null then null else p_actor end,
         replied_at = case when v_reply is null then null else now() end,
         updated_by = p_actor,
         updated_at = now()
   where recommendations.id = p_id
  returning recommendations.id, recommendations.status, recommendations.priority,
            recommendations.reply
     into id, status, priority, reply;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'That recommendation is not on the register.' using errcode = 'P0001';
  end if;
  -- A set-returning plpgsql function writes NOTHING by assigning its OUT columns — the
  -- row has to be returned. Without this line the decision saved correctly and the desk
  -- got an empty set back, which is the worst shape of a bug: the write worked, the
  -- screen said nothing.
  return next;
end $$;

-- ============================================================
-- 4. DUTIES
-- ============================================================
--
-- Two keys for the author and two for the desk. The author's split matters because an
-- auditor role that may read anything must not gain a pen by reading its own outbox.

insert into permissions (key, description) values
  ('recommendations.view', 'Recommendations - Read what this account has sent the platform team'),
  ('recommendations.write', 'Recommendations - Send a suggestion to the platform team'),
  ('control.recommendations.view', 'Control - Read the recommendation inbox'),
  ('control.recommendations.manage', 'Control - Triage and answer recommendations')
on conflict do nothing;

-- Everyone who works in the product can send one and see their own. Drivers and trainees
-- are included on purpose: they are the seats with the least power to be heard any other
-- way, and the most contact with what the app actually does on a truck. A shipper is too —
-- a client whose complaint currently reaches the office by phone is the one worth writing
-- down, and `/portal/` is already an open surface for its token.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
  from roles r
  join permissions p on p.key in ('recommendations.view', 'recommendations.write')
 where r.tenant_id is null
   and r.key in ('director','general_manager','operations_manager','finance_officer',
                 'hr_officer','dispatcher','checkpoint_clerk','workshop_manager',
                 'customer_service','fleet_manager','driver','trainee',
                 'shipper','shipper_portal')
on conflict do nothing;

-- Read-only seats read their own outbox and nothing more.
insert into role_permissions (role_id, permission_key)
select r.id, 'recommendations.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('auditor','billing_admin','compliance_officer','support_engineer',
                 'platform_analyst','customer_service_agent')
on conflict do nothing;

-- A seeker is the newest audience in the product and the one with no office to phone.
-- Its own key set (060/061) is what reaches the /seeker surface; this adds the one
-- write it is worth granting.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
  from roles r
  join permissions p on p.key in ('recommendations.view', 'recommendations.write')
 where r.tenant_id is null and r.key = 'seeker'
on conflict do nothing;

-- The desk: read it broadly, write it narrowly. An analyst measures what people asked
-- for; the customer service seat and the super admin are the ones who answer.
insert into role_permissions (role_id, permission_key)
select r.id, 'control.recommendations.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','customer_service_agent','platform_analyst',
                 'compliance_officer','support_engineer')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.recommendations.manage'
  from roles r
 where r.tenant_id is null and r.key in ('super_admin','customer_service_agent')
on conflict do nothing;

-- ============================================================
-- 5. GRANTS
-- ============================================================

grant execute on function
  platform_auth.control_recommendation_register(text, text, text, text, int),
  platform_auth.record_recommendation_decision(uuid, text, text, text, uuid)
to app_runtime;

-- The 051 sweep, per function: a new definer belongs to PUBLIC until told otherwise,
-- and 069's advisory hunts any that still do.
revoke all on function
  platform_auth.control_recommendation_register(text, text, text, text, int)
  from public, anon, authenticated, service_role;
revoke all on function
  platform_auth.record_recommendation_decision(uuid, text, text, text, uuid)
  from public, anon, authenticated, service_role;

commit;
