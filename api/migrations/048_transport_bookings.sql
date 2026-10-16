-- 048: Transport bookings (spec Part 2, steps 2-3 "TEMP_BOOKED + timers").
--
-- The booking state machine. One rule shapes the whole file:
--
--   * CLIENTS NEVER SET STATUS. Migration 044 granted app_runtime table-wide
--     INSERT/UPDATE on transport_requests; that grant is revoked here and
--     rebuilt as an INSERT column list that does not even name `status`
--     (the column default 'open' is the only way in). UPDATE is revoked
--     entirely. Every lifecycle change — open → temp_booked → confirmed /
--     back to open, withdrawn — runs inside a SECURITY DEFINER function
--     below, so a tampered client (or a future buggy route) has no SQL
--     vocabulary for it at all.
--   * The timers are SERVER-SIDE and authoritative. reminder_sent_at at 6h
--     and auto-release at 12h are stamped by transport_booking_reminders()
--     and transport_booking_releases(), which are idempotent by predicate
--     (reminder_sent_at is null / status = 'temp_booked') and take row
--     locks (`for update skip locked`) so two concurrent ticks cannot
--     double-release. No browser is involved and closing a tab changes
--     nothing.
--   * CONCURRENCY resolves in the database: booking is a single guarded
--     UPDATE (`where status = 'open'`). The second caller blocks on the row
--     lock, re-evaluates after the winner commits, matches 0 rows and gets
--     a typed reason back — never a 500, never a double-booking.
--
-- transport_bookings is the BOOKER's own record (tenant_id = the booking
-- company), holding a snapshot of the disclosed card copied at book time —
-- the same Rule 0 allowlist board_card publishes, never a live join. The
-- publishing company reads its own transport_requests row, which carries
-- the current booking summary (who holds it, how to reach them). Full
-- history for the publisher lives in job_activity + audit_logs.
begin;

-- ---------- The booker's record ----------
create table if not exists transport_bookings (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references transport_requests(id),
  tenant_id uuid not null references tenants(id),
  booked_by uuid references users(id),
  status text not null default 'temp_booked'
    check (status in ('temp_booked','confirmed','rejected','expired','released','cancelled')),

  -- how the publisher reaches the person who booked
  contact_name text not null check (length(trim(contact_name)) between 2 and 120),
  contact_channel text not null check (length(trim(contact_channel)) between 5 and 160),

  -- snapshot of the disclosed card, copied once at book time (Rule 0:
  -- exactly the columns board_card publishes, nothing else)
  cargo_label text not null,
  container_type text,
  container_count int,
  weight_tonnes numeric(12,3),
  cbm numeric(12,3),
  vehicle_types text[] not null default '{}',
  route_label text,
  distance_km int,
  expected_duration_hours int,
  pickup_text text not null,
  dest_text text not null,
  via_label text,
  required_date date not null,
  company_name text not null,
  disclosed_at timestamptz,

  -- the server-side clocks
  temp_booked_at timestamptz not null default now(),
  reminder_sent_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by uuid,
  ended_at timestamptz,
  ended_by uuid,
  ended_reason text check (ended_reason is null or length(ended_reason) <= 300),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One active booking per request, enforced by the database itself.
create unique index if not exists transport_bookings_one_active_uq
  on transport_bookings (request_id)
  where status in ('temp_booked','confirmed') and deleted_at is null;
create index if not exists idx_transport_bookings_tenant
  on transport_bookings (tenant_id, created_at desc) where deleted_at is null;
create index if not exists idx_transport_bookings_request
  on transport_bookings (request_id, created_at desc);

drop trigger if exists trg_transport_bookings_updated on transport_bookings;
create trigger trg_transport_bookings_updated before update on transport_bookings
  for each row execute function public.set_updated_at();

-- SELECT only for the app role: rows are written exclusively by the
-- SECURITY DEFINER functions below, on behalf of either side.
alter table transport_bookings enable row level security;
drop policy if exists transport_bookings_tenant on transport_bookings;
create policy transport_bookings_tenant on transport_bookings for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on transport_bookings to app_runtime;
revoke insert, update, delete on transport_bookings from app_runtime;

-- ---------- Current booking summary on the publisher's own row ----------
alter table transport_requests
  add column if not exists booked_by_tenant_id uuid,
  add column if not exists booked_by uuid,
  add column if not exists booked_company_name text,
  add column if not exists booked_contact_name text,
  add column if not exists booked_contact_channel text,
  add column if not exists temp_booked_at timestamptz,
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists released_at timestamptz,
  add column if not exists confirmed_at timestamptz;

create index if not exists idx_transport_requests_temp_booked
  on transport_requests (temp_booked_at)
  where status = 'temp_booked' and deleted_at is null;

-- ---------- The lifecycle is no longer writable by the app role ----------
-- Rebuild the grants: INSERT keeps the publish column set (no `status` —
-- the default 'open' applies), UPDATE disappears. The transitions below run
-- as the function owner.
revoke insert, update on transport_requests from app_runtime;
grant insert (id, tenant_id, job_id, shipment_id, cargo_label, container_type,
  container_count, weight_tonnes, cbm, vehicle_types, route_id, route_label,
  distance_km, expected_duration_hours, pickup_text, pickup_region_id, dest_text,
  dest_region_id, via_label, required_date, contact_user_id, contact_name,
  contact_channel, public_note, company_name, company_description,
  company_services, company_corridors, company_website, fleet_size_declared,
  year_established, disclosed_by, disclosed_at, created_by, updated_by)
  on transport_requests to app_runtime;

-- ---------- Helper: the caller's transaction must be scoped to the acting company ----------
-- Every transition below checks this, so an accidental cross-tenant call in
-- a route fails loudly instead of succeeding with the wrong identity.
create or replace function transport_actor_ok(p_tenant uuid) returns boolean
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid = p_tenant
$$;
revoke all on function transport_actor_ok(uuid) from public;

-- ---------- BOOK: open → temp_booked (the concurrency gate) ----------
create or replace function transport_book_request(
  p_request uuid, p_tenant uuid, p_user uuid,
  p_contact_name text, p_contact_channel text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_company text;
  v_booking uuid;
begin
  if not transport_actor_ok(p_tenant) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;

  select t.id, t.tenant_id, t.status, t.deleted_at, t.job_id, t.shipment_id,
         t.pickup_text, t.dest_text
    into r
    from transport_requests t where t.id = p_request;
  if not found or r.deleted_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  if r.tenant_id = p_tenant then
    return jsonb_build_object('ok', false, 'reason', 'own_request');
  end if;
  if r.status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'not_open', 'status', r.status);
  end if;
  if length(trim(coalesce(p_contact_name, ''))) < 2
     or length(trim(coalesce(p_contact_channel, ''))) < 5 then
    return jsonb_build_object('ok', false, 'reason', 'contact');
  end if;

  v_company := coalesce(
    (select nullif(trim(cp.company_name), '') from company_profiles cp
      where cp.tenant_id = p_tenant),
    (select tn.name from tenants tn where tn.id = p_tenant),
    'Unknown company');

  -- The whole concurrency story in one statement: whoever flips 'open'
  -- first wins the row lock; the other caller blocks here, re-reads after
  -- the commit, matches nothing and falls through to the typed reason.
  update transport_requests t
     set status = 'temp_booked',
         temp_booked_at = now(), reminder_sent_at = null, released_at = null,
         confirmed_at = null,
         booked_by_tenant_id = p_tenant, booked_by = p_user,
         booked_company_name = v_company,
         booked_contact_name = trim(p_contact_name),
         booked_contact_channel = trim(p_contact_channel),
         updated_by = p_user, updated_at = now()
   where t.id = p_request and t.status = 'open' and t.deleted_at is null;
  if not found then
    select t.status, t.deleted_at into r.status, r.deleted_at
      from transport_requests t where t.id = p_request;
    if not found or r.deleted_at is not null then
      return jsonb_build_object('ok', false, 'reason', 'missing');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'not_open', 'status', r.status);
  end if;

  insert into transport_bookings (
    request_id, tenant_id, booked_by, status, contact_name, contact_channel,
    cargo_label, container_type, container_count, weight_tonnes, cbm, vehicle_types,
    route_label, distance_km, expected_duration_hours, pickup_text, dest_text,
    via_label, required_date, company_name, disclosed_at, temp_booked_at)
  select t.id, p_tenant, p_user, 'temp_booked', trim(p_contact_name), trim(p_contact_channel),
         t.cargo_label, t.container_type, t.container_count, t.weight_tonnes, t.cbm, t.vehicle_types,
         t.route_label, t.distance_km, t.expected_duration_hours, t.pickup_text, t.dest_text,
         t.via_label, t.required_date, t.company_name, t.disclosed_at, now()
    from transport_requests t where t.id = p_request
  returning id into v_booking;

  -- The publisher's job timeline sees the hold as it happens.
  insert into job_activity (tenant_id, job_id, shipment_id, actor_user_id, actor_role,
    action, summary, entity, entity_id, meta)
  values (r.tenant_id, r.job_id, r.shipment_id, p_user, 'transporter',
    'transport.booked',
    format('Load held — %s asked to book %s to %s', v_company, r.pickup_text, r.dest_text),
    'transport_bookings', v_booking,
    jsonb_build_object('company', v_company, 'contact', trim(p_contact_name),
      'contactChannel', trim(p_contact_channel), 'autoReleaseHours', 12));

  return jsonb_build_object('ok', true, 'bookingId', v_booking, 'company', v_company);
exception
  when unique_violation then
    -- Only reachable if a booking row survived without its request status —
    -- report it as a lost race rather than a 500.
    return jsonb_build_object('ok', false, 'reason', 'not_open', 'status', 'temp_booked');
end $$;

-- ---------- CONFIRM: temp_booked → confirmed (publisher only) ----------
create or replace function transport_confirm_booking(
  p_request uuid, p_tenant uuid, p_user uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_booking uuid;
begin
  if not transport_actor_ok(p_tenant) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;

  select t.id, t.tenant_id, t.status, t.deleted_at, t.job_id, t.shipment_id,
         t.booked_company_name, t.pickup_text, t.dest_text
    into r
    from transport_requests t where t.id = p_request;
  if not found or r.deleted_at is not null or r.tenant_id <> p_tenant then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  if r.status <> 'temp_booked' then
    return jsonb_build_object('ok', false, 'reason', 'not_temp', 'status', r.status);
  end if;

  -- Claim the request row first (this IS the lock), then the booking row.
  update transport_requests t
     set status = 'confirmed', confirmed_at = now(),
         updated_by = p_user, updated_at = now()
   where t.id = p_request and t.status = 'temp_booked' and t.deleted_at is null;
  if not found then
    select t.status into r.status from transport_requests t where t.id = p_request;
    return jsonb_build_object('ok', false, 'reason', 'not_temp', 'status', r.status);
  end if;

  update transport_bookings b
     set status = 'confirmed', confirmed_at = now(), confirmed_by = p_user
   where b.request_id = p_request and b.status = 'temp_booked' and b.deleted_at is null
  returning b.id into v_booking;
  if v_booking is null then
    raise exception 'booking row missing for request % in temp_booked', p_request;
  end if;

  insert into job_activity (tenant_id, job_id, shipment_id, actor_user_id, actor_role,
    action, summary, entity, entity_id, meta)
  values (r.tenant_id, r.job_id, r.shipment_id, p_user, 'publisher',
    'transport.confirmed',
    format('Booking confirmed with %s — %s to %s',
      coalesce(r.booked_company_name, 'the transporter'), r.pickup_text, r.dest_text),
    'transport_bookings', v_booking,
    jsonb_build_object('company', r.booked_company_name));

  return jsonb_build_object('ok', true, 'bookingId', v_booking,
    'company', r.booked_company_name);
end $$;

-- ---------- REJECT: temp_booked → open (publisher only, reason optional) ----------
create or replace function transport_reject_booking(
  p_request uuid, p_tenant uuid, p_user uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_booking uuid;
begin
  if not transport_actor_ok(p_tenant) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;

  select t.id, t.tenant_id, t.status, t.deleted_at, t.job_id, t.shipment_id,
         t.booked_company_name, t.pickup_text, t.dest_text
    into r
    from transport_requests t where t.id = p_request;
  if not found or r.deleted_at is not null or r.tenant_id <> p_tenant then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  if r.status <> 'temp_booked' then
    return jsonb_build_object('ok', false, 'reason', 'not_temp', 'status', r.status);
  end if;

  update transport_requests t
     set status = 'open', released_at = now(),
         updated_by = p_user, updated_at = now()
   where t.id = p_request and t.status = 'temp_booked' and t.deleted_at is null;
  if not found then
    select t.status into r.status from transport_requests t where t.id = p_request;
    return jsonb_build_object('ok', false, 'reason', 'not_temp', 'status', r.status);
  end if;

  update transport_bookings b
     set status = 'rejected', ended_at = now(), ended_by = p_user,
         ended_reason = nullif(trim(coalesce(p_reason, '')), '')
   where b.request_id = p_request and b.status = 'temp_booked' and b.deleted_at is null
  returning b.id into v_booking;
  if v_booking is null then
    raise exception 'booking row missing for request % in temp_booked', p_request;
  end if;

  insert into job_activity (tenant_id, job_id, shipment_id, actor_user_id, actor_role,
    action, summary, entity, entity_id, meta)
  values (r.tenant_id, r.job_id, r.shipment_id, p_user, 'publisher',
    'transport.rejected',
    format('Booking declined — %s released the hold on %s to %s',
      coalesce(r.booked_company_name, 'the transporter'), r.pickup_text, r.dest_text),
    'transport_bookings', v_booking,
    jsonb_build_object('company', r.booked_company_name,
      'reason', nullif(trim(coalesce(p_reason, '')), '')));

  return jsonb_build_object('ok', true, 'bookingId', v_booking);
end $$;

-- ---------- RELEASE: temp_booked → open (the booking company withdraws it) ----------
create or replace function transport_release_booking(
  p_request uuid, p_tenant uuid, p_user uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_booking uuid;
  v_company text;
begin
  if not transport_actor_ok(p_tenant) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;

  select t.id, t.tenant_id, t.status, t.deleted_at, t.job_id, t.shipment_id,
         t.booked_by_tenant_id, t.booked_company_name, t.pickup_text, t.dest_text
    into r
    from transport_requests t where t.id = p_request;
  if not found or r.deleted_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  if r.booked_by_tenant_id is distinct from p_tenant then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;
  if r.status = 'confirmed' then
    return jsonb_build_object('ok', false, 'reason', 'confirmed', 'status', 'confirmed');
  end if;
  if r.status <> 'temp_booked' then
    return jsonb_build_object('ok', false, 'reason', 'not_temp', 'status', r.status);
  end if;

  update transport_requests t
     set status = 'open', released_at = now(),
         updated_by = p_user, updated_at = now()
   where t.id = p_request and t.status = 'temp_booked' and t.deleted_at is null;
  if not found then
    select t.status into r.status from transport_requests t where t.id = p_request;
    return jsonb_build_object('ok', false, 'reason', 'not_temp', 'status', r.status);
  end if;

  update transport_bookings b
     set status = 'released', ended_at = now(), ended_by = p_user,
         ended_reason = nullif(trim(coalesce(p_reason, '')), '')
   where b.request_id = p_request and b.status = 'temp_booked' and b.deleted_at is null
  returning b.id into v_booking;
  if v_booking is null then
    raise exception 'booking row missing for request % in temp_booked', p_request;
  end if;

  v_company := coalesce(r.booked_company_name, 'The transporter');
  insert into job_activity (tenant_id, job_id, shipment_id, actor_user_id, actor_role,
    action, summary, entity, entity_id, meta)
  values (r.tenant_id, r.job_id, r.shipment_id, p_user, 'transporter',
    'transport.released',
    format('Hold released by %s — %s to %s is back on the board',
      v_company, r.pickup_text, r.dest_text),
    'transport_bookings', v_booking,
    jsonb_build_object('company', v_company,
      'reason', nullif(trim(coalesce(p_reason, '')), '')));

  return jsonb_build_object('ok', true, 'bookingId', v_booking);
end $$;

-- ---------- CANCEL a confirmed booking: reason required, either side ----------
create or replace function transport_cancel_booking(
  p_request uuid, p_tenant uuid, p_user uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_booking uuid;
  v_side text;
begin
  if not transport_actor_ok(p_tenant) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if length(trim(coalesce(p_reason, ''))) < 4 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  select t.id, t.tenant_id, t.status, t.deleted_at, t.job_id, t.shipment_id,
         t.booked_by_tenant_id, t.booked_company_name, t.pickup_text, t.dest_text
    into r
    from transport_requests t where t.id = p_request;
  if not found or r.deleted_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  if r.tenant_id <> p_tenant and r.booked_by_tenant_id is distinct from p_tenant then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;
  if r.status <> 'confirmed' then
    return jsonb_build_object('ok', false, 'reason', 'not_confirmed', 'status', r.status);
  end if;
  v_side := case when r.tenant_id = p_tenant then 'publisher' else 'transporter' end;

  update transport_requests t
     set status = 'open', released_at = now(),
         updated_by = p_user, updated_at = now()
   where t.id = p_request and t.status = 'confirmed' and t.deleted_at is null;
  if not found then
    select t.status into r.status from transport_requests t where t.id = p_request;
    return jsonb_build_object('ok', false, 'reason', 'not_confirmed', 'status', r.status);
  end if;

  update transport_bookings b
     set status = 'cancelled', ended_at = now(), ended_by = p_user,
         ended_reason = trim(p_reason)
   where b.request_id = p_request and b.status = 'confirmed' and b.deleted_at is null
  returning b.id into v_booking;
  if v_booking is null then
    raise exception 'booking row missing for request % in confirmed', p_request;
  end if;

  insert into job_activity (tenant_id, job_id, shipment_id, actor_user_id, actor_role,
    action, summary, entity, entity_id, meta)
  values (r.tenant_id, r.job_id, r.shipment_id, p_user, v_side,
    'transport.cancelled_booking',
    format('Confirmed booking cancelled (%s) — reason: %s', v_side, trim(p_reason)),
    'transport_bookings', v_booking,
    jsonb_build_object('company', r.booked_company_name, 'side', v_side,
      'reason', trim(p_reason)));

  return jsonb_build_object('ok', true, 'bookingId', v_booking, 'side', v_side);
end $$;

-- ---------- WITHDRAW the whole request: open → cancelled (publisher only) ----------
create or replace function transport_withdraw_request(
  p_request uuid, p_tenant uuid, p_user uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  if not transport_actor_ok(p_tenant) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;

  select t.id, t.tenant_id, t.status, t.deleted_at, t.job_id, t.shipment_id,
         t.pickup_text, t.dest_text
    into r
    from transport_requests t where t.id = p_request;
  if not found or r.deleted_at is not null or r.tenant_id <> p_tenant then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  if r.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if r.status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'engaged', 'status', r.status);
  end if;

  update transport_requests t
     set status = 'cancelled', cancelled_by = p_user, cancelled_at = now(),
         updated_by = p_user, updated_at = now()
   where t.id = p_request and t.status = 'open' and t.deleted_at is null;
  if not found then
    select t.status into r.status from transport_requests t where t.id = p_request;
    return jsonb_build_object('ok', false, 'reason', 'engaged', 'status', r.status);
  end if;

  insert into job_activity (tenant_id, job_id, shipment_id, actor_user_id, actor_role,
    action, summary, entity, entity_id, meta)
  values (r.tenant_id, r.job_id, r.shipment_id, p_user, 'publisher',
    'transport.cancelled',
    format('Transport request withdrawn — %s to %s', r.pickup_text, r.dest_text),
    'transport_requests', p_request, '{}'::jsonb);

  return jsonb_build_object('ok', true);
end $$;

-- ---------- The 6h reminder stamp (idempotent) ----------
create or replace function transport_booking_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_n int;
begin
  with due as (
    update transport_requests t
       set reminder_sent_at = now(), updated_at = now()
     where t.status = 'temp_booked' and t.reminder_sent_at is null
       and t.deleted_at is null
       and t.temp_booked_at <= now() - interval '6 hours'
    returning t.id
  ), marked as (
    update transport_bookings b
       set reminder_sent_at = now()
      from due where b.request_id = due.id and b.status = 'temp_booked'
    returning b.id
  )
  select count(*) into v_n from due;
  return v_n;
end $$;

-- ---------- The 12h auto-release (idempotent, row-locked) ----------
create or replace function transport_booking_releases() returns setof uuid
language plpgsql security definer set search_path = public as $$
begin
  return query
  with due as (
    -- Skip rows another tick (or a confirm) is already deciding on.
    select t.id from transport_requests t
     where t.status = 'temp_booked' and t.deleted_at is null
       and t.temp_booked_at <= now() - interval '12 hours'
     for update skip locked
  ), back as (
    update transport_requests t
       set status = 'open', released_at = now(), updated_at = now()
      from due where t.id = due.id
    returning t.id
  ), ended as (
    update transport_bookings b
       set status = 'expired', ended_at = now()
      from back where b.request_id = back.id and b.status = 'temp_booked'
    returning b.id
  )
  select back.id from back;
end $$;

-- ---------- Privileges: execute-only for the app role ----------
revoke all on function transport_book_request(uuid, uuid, uuid, text, text) from public;
revoke all on function transport_confirm_booking(uuid, uuid, uuid) from public;
revoke all on function transport_reject_booking(uuid, uuid, uuid, text) from public;
revoke all on function transport_release_booking(uuid, uuid, uuid, text) from public;
revoke all on function transport_cancel_booking(uuid, uuid, uuid, text) from public;
revoke all on function transport_withdraw_request(uuid, uuid, uuid) from public;
revoke all on function transport_booking_reminders() from public;
revoke all on function transport_booking_releases() from public;

grant execute on function transport_book_request(uuid, uuid, uuid, text, text) to app_runtime;
grant execute on function transport_confirm_booking(uuid, uuid, uuid) to app_runtime;
grant execute on function transport_reject_booking(uuid, uuid, uuid, text) to app_runtime;
grant execute on function transport_release_booking(uuid, uuid, uuid, text) to app_runtime;
grant execute on function transport_cancel_booking(uuid, uuid, uuid, text) to app_runtime;
grant execute on function transport_withdraw_request(uuid, uuid, uuid) to app_runtime;
grant execute on function transport_booking_reminders() to app_runtime;
grant execute on function transport_booking_releases() to app_runtime;

comment on function transport_book_request(uuid, uuid, uuid, text, text) is
  'The concurrency gate: a single guarded UPDATE resolves two simultaneous books to one winner.';
comment on function transport_booking_releases() is
  'Auto-release at 12h. Idempotent (status guard) and row-locked (for update skip locked).';

-- ---------- Permissions ----------
insert into permissions (key, description)
values
  ('board.book', 'Notice board - Book a load and manage your own bookings'),
  ('transport.confirm_booking', 'Transport requests - Confirm or decline a booking on your request'),
  ('transport.cancel_booking', 'Transport requests - Cancel a confirmed booking (reason required)')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'board.book'
from roles r
where r.key in ('director', 'operations_manager', 'general_manager', 'dispatcher')
  and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('transport.confirm_booking', 'transport.cancel_booking')
where r.key in ('director', 'operations_manager', 'general_manager')
  and r.tenant_id is null
on conflict do nothing;

commit;
