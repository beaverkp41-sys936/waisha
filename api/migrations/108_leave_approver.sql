-- 108: a leave request is decided by the person it was sent to.
--
-- Task #183: "on leave approval, i want the staff can request for leave and it is approved
-- by someone assigned as approver for him". 065 built the request and the decision, but the
-- decision only ever asked "does this seat hold leave.decide?" — so every director and every
-- HR officer could answer any request, and nobody in particular was on the hook for any of
-- them. This makes the ask a person rather than a permission.
--
-- Two halves, deliberately in two different places:
--
--   * employees.leave_approver_user_id — the standing assignment the office makes. It points
--     at a seat (users), because that is what signs in and what decided_by already holds, not
--     at an employee row, because a person can be a decision-maker with no staff record of
--     their own.
--   * leave_requests.routed_to_user_id + routed_reason — the route stamped on the request at
--     the moment it is raised. Without the snapshot, re-assigning an approver next month would
--     silently move last month's queue, and the register would rewrite its own history.
--
-- The chain itself (assigned → the person above them → the office) is resolved in the route,
-- because it has to read the permission tables; what is kept here is the two rules that must
-- hold even if a route is written badly, and the columns that make the chain readable.

-- ---------------------------------------------------------------------------
-- 1. the assignment
-- ---------------------------------------------------------------------------

alter table employees
  add column if not exists leave_approver_user_id uuid references users(id) on delete set null;

create index if not exists idx_employee_leave_approver
  on employees (tenant_id, leave_approver_user_id)
  where deleted_at is null and leave_approver_user_id is not null;

-- The foreign key says "a seat"; it cannot say "this company's seat", and a borrowed one is
-- exactly the mistake this column makes easy — an office that types an id from a support
-- ticket would send somebody's leave to another company's director, where it would sit
-- undecided forever. So the membership, the state and the self-reference are checked here,
-- against the row the write is about to land, which no route can talk its way past.
--
-- Only when the assignment moved. A rule that re-tested the seat on every edit would make an
-- ordinary name correction fail the day the approver's seat was suspended, and the office
-- would lose the ability to fix the staff register over a column they were not touching.
create or replace function public.employee_leave_approver_seat()
returns trigger language plpgsql set search_path = public as $$
declare
  seat_tenant uuid;
  seat_status text;
begin
  if new.leave_approver_user_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.leave_approver_user_id = old.leave_approver_user_id then
    return new;
  end if;
  if new.user_id is not null and new.user_id = new.leave_approver_user_id then
    raise exception 'An approver cannot be the person whose leave they decide.';
  end if;
  select tenant_id, status into seat_tenant, seat_status
    from users where id = new.leave_approver_user_id;
  if seat_tenant is null then
    raise exception 'The assigned approver is not a seat of any company.';
  end if;
  if seat_tenant <> new.tenant_id then
    raise exception 'The assigned approver belongs to another company.';
  end if;
  if seat_status <> 'active' then
    raise exception 'The assigned approver''s seat is not active.';
  end if;
  return new;
end $$;

drop trigger if exists trg_employee_leave_approver_seat on employees;
create trigger trg_employee_leave_approver_seat before insert or update
  on employees for each row execute function public.employee_leave_approver_seat();

grant execute on function public.employee_leave_approver_seat() to app_runtime;

-- ---------------------------------------------------------------------------
-- 2. the route the request took
-- ---------------------------------------------------------------------------

alter table leave_requests
  add column if not exists routed_to_user_id uuid references users(id) on delete set null,
  add column if not exists routed_reason text not null default 'office',
  add column if not exists routed_note text,
  add column if not exists escalated_at timestamptz,
  add column if not exists escalated_by uuid references users(id) on delete set null,
  add column if not exists escalated_from uuid references users(id) on delete set null;

alter table leave_requests drop constraint if exists leave_requests_routed_reason_check;
alter table leave_requests add constraint leave_requests_routed_reason_check
  check (routed_reason in ('assigned','supervisor','office','escalated'));

-- An escalation is an act with an author. A row that says somebody pushed it upstairs but
-- not who is a row that cannot be explained to the person whose leave it is.
alter table leave_requests drop constraint if exists leave_requests_escalation_check;
alter table leave_requests add constraint leave_requests_escalation_check
  check ((escalated_at is null and escalated_by is null and escalated_from is null)
     or (escalated_at is not null and escalated_by is not null));

-- The queue an approver opens is the one read this stage exists for, and it is a small one:
-- pending rows sent to this seat, oldest ask first, so a stale request cannot hide under a
-- fresh one.
create index if not exists idx_leave_routed_to_me
  on leave_requests (routed_to_user_id, created_at)
  where status = 'pending' and deleted_at is null;

-- The office's stalled pile: pending, nobody left holding it.
create index if not exists idx_leave_routed_open
  on leave_requests (tenant_id, created_at)
  where status = 'pending' and deleted_at is null
    and routed_reason in ('office','escalated');

-- ---------------------------------------------------------------------------
-- 3. the two rules the decision itself obeys
-- ---------------------------------------------------------------------------

-- The same reason 107 froze a photograph: a decision is a statement about a chain, and the
-- chain has to stay what it was when the answer was given. Of the route, everything is frozen
-- but one thing: the holder may still be *lost*, because that is what the foreign key does
-- when a seat is deleted, and refusing it would make the seat undeletable. Being pointed at a
-- different seat is another act — it rewrites who was asked.
--
-- It also refuses the one decision that can never be honest: your own. A person who can
-- decide their own leave can grant it, whatever the assignment said, so the rule is on the
-- row rather than in whichever route thought of it.
create or replace function public.leave_decision_shape()
returns trigger language plpgsql set search_path = public as $$
declare
  own_seat uuid;
  author uuid;
  deciding boolean;
begin
  -- A decision being taken, whether it arrives as pending → decided or lands decided in one
  -- write. The three refusals below are the whole of what makes the answer somebody else's.
  deciding := new.status in ('approved','rejected')
              and (tg_op = 'INSERT' or old.status = 'pending');
  if deciding then
    if new.decided_by is null then
      raise exception 'A decided leave request names the seat that decided it.';
    end if;
    select user_id into own_seat from employees where id = new.employee_id;
    if own_seat is not null and new.decided_by = own_seat then
      raise exception 'A person cannot decide their own leave.';
    end if;
    author := case when tg_op = 'INSERT' then new.created_by else old.created_by end;
    if author is not null and new.decided_by = author then
      raise exception 'The seat that raised a request is not the seat that decides it.';
    end if;
    return new;
  end if;

  -- Not a decision being taken. Once the answer is on the row the route is history, and the
  -- only later change it accepts is losing its holder — the act the foreign key performs when
  -- a seat is deleted. Everything else about the chain stays as it was.
  if tg_op = 'UPDATE'
     and old.status <> 'pending'
     and (   (new.routed_to_user_id is not null
              and new.routed_to_user_id is distinct from old.routed_to_user_id)
          or new.routed_reason is distinct from old.routed_reason
          or new.escalated_at is distinct from old.escalated_at
          or new.escalated_by is distinct from old.escalated_by
          or new.escalated_from is distinct from old.escalated_from
          or new.routed_note is distinct from old.routed_note)
  then
    raise exception 'The route a decided request took is part of the answer; it is not rewritten.';
  end if;
  return new;
end $$;

drop trigger if exists trg_leave_decision_shape on leave_requests;
-- Insert as well as update: a request that lands already decided is the same statement made in
-- one write instead of two, and it has to carry the same proof.
create trigger trg_leave_decision_shape before insert or update
  on leave_requests for each row execute function public.leave_decision_shape();

grant execute on function public.leave_decision_shape() to app_runtime;

-- ---------------------------------------------------------------------------
-- 4. comments
-- ---------------------------------------------------------------------------

comment on column employees.leave_approver_user_id is
  'The seat that decides this person''s leave. Checked against the company by trg_employee_leave_approver_seat.';
comment on column leave_requests.routed_to_user_id is
  'Who was holding the request when it was raised. Not the current assignment — the route is a snapshot.';
comment on column leave_requests.routed_reason is
  'assigned (the person named above) | supervisor (their supervisor''s seat) | office (nobody was resolved) | escalated (pushed upstairs by hand).';
comment on column leave_requests.escalated_from is
  'The seat it was taken away from, so the register can say whose desk it left.';

-- No new duty key. leave.decide already belongs to the director and the HR officer, and that
-- is exactly the office half of the chain; the assigned and supervisor halves are not a
-- permission but a fact about a person, which is why they live in a column instead.
