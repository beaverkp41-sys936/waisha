-- 050: Step 7 — alert read state, timer events on the record, booker profile snapshot.
--
-- Three jobs, one theme: make what the user SEES durable and reviewable.
--
--   1. UNREAD ALERTS. The notification feed is derived live (nothing is
--      stored), so "read" cannot live on the alert — it lives on a stable
--      KEY computed for every item (booking_hold:<request>:<temp_booked_at>,
--      invoice_overdue:<id>, …). alert_reads remembers which keys this user
--      has seen; the route keeps emitting the alert and marks `seen: true`.
--      No background sync, no drift: dismissing is idempotent by PK.
--
--   2. TIMER EVENTS ON THE RECORD. The 6h reminder and the 12h auto-release
--      previously changed rows silently. They now write job_activity (the
--      publisher's timeline) AND audit_logs, from INSIDE the functions.
--      That placement is deliberate: the timer process has no app.tenant_id
--      and cannot touch tenant rows itself — the SECURITY DEFINER functions
--      are the only code that can, and audit_logs has SQL-insert precedent
--      (010 licence_activate). create or replace keeps signatures — and
--      therefore the execute grants from 048/049 — untouched.
--
--   3. BOOKER REVIEW SNAPSHOT. When a transporter books, the publisher now
--      sees WHO is holding the load: the booker's company profile (about,
--      services, corridors, fleet size, year, licence number + expiry) is
--      copied onto the request row, and shadow-copied onto the booker's own
--      booking record for the CFA review card. Snapshot, never a live join —
--      the same Rule 0 discipline as the board card itself.
begin;

-- ---------- 1. alert read state ----------
-- One row per (user, alert key). Keys are rebuildable and content-addressed:
-- if the underlying alert changes materially (new booking, new countdown
-- window) the key changes with it, so a stale dismissal can never hide a
-- fresh event.
create table if not exists alert_reads (
  user_id uuid not null references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  alert_key text not null check (length(alert_key) between 2 and 200),
  seen_at timestamptz not null default now(),
  primary key (user_id, alert_key)
);
create index if not exists idx_alert_reads_tenant on alert_reads (tenant_id, user_id);

alter table alert_reads enable row level security;
drop policy if exists alert_reads_tenant on alert_reads;
create policy alert_reads_tenant on alert_reads for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert on alert_reads to app_runtime;
-- Marking read is the only verb; un-reading is deleting the key by hand.
revoke update, delete on alert_reads from app_runtime;
-- Supabase default privileges hand new tables to the API roles — take that
-- back explicitly (the 049 lesson), plus PUBLIC for good measure.
revoke all on table alert_reads from public;
revoke all on table alert_reads from anon, authenticated, service_role;

comment on table alert_reads is
  'Per-user dismissal of derived alerts, keyed by the alert''s stable key. Personal UX state, not audit.';

-- ---------- 2. booker profile snapshot columns ----------
-- On the publisher's request row: what the CFA review card renders.
alter table transport_requests
  add column if not exists booked_company_description text,
  add column if not exists booked_company_services text,
  add column if not exists booked_company_corridors text,
  add column if not exists booked_company_website text,
  add column if not exists booked_fleet_size int,
  add column if not exists booked_year_established int,
  add column if not exists booked_licence_no text,
  add column if not exists booked_licence_expiry date;

-- On the booker's own booking record: the same copy, so the transporter can
-- review what was on file when they booked.
alter table transport_bookings
  add column if not exists booker_description text,
  add column if not exists booker_services text,
  add column if not exists booker_corridors text,
  add column if not exists booker_website text,
  add column if not exists booker_fleet_size int,
  add column if not exists booker_year_established int,
  add column if not exists booker_licence_no text,
  add column if not exists booker_licence_expiry date;

-- ---------- 3. BOOK, now carrying the booker's profile ----------
create or replace function transport_book_request(
  p_request uuid, p_tenant uuid, p_user uuid,
  p_contact_name text, p_contact_channel text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_company text;
  v_desc text;
  v_services text;
  v_corridors text;
  v_website text;
  v_fleet int;
  v_year int;
  v_lic_no text;
  v_lic_exp date;
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

  -- Who is this booker? One snapshot of the company profile, so the
  -- publisher never gets a live join into another tenant's tables.
  select nullif(trim(cp.company_name), ''),
         cp.description, cp.services_offered, cp.corridors_served, cp.website,
         cp.fleet_size_declared, cp.year_established,
         cp.transport_licence_no, cp.transport_licence_expiry
    into v_company, v_desc, v_services, v_corridors, v_website,
         v_fleet, v_year, v_lic_no, v_lic_exp
    from company_profiles cp where cp.tenant_id = p_tenant;

  v_company := coalesce(
    v_company,
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
         booked_company_description = v_desc,
         booked_company_services = v_services,
         booked_company_corridors = v_corridors,
         booked_company_website = v_website,
         booked_fleet_size = v_fleet,
         booked_year_established = v_year,
         booked_licence_no = v_lic_no,
         booked_licence_expiry = v_lic_exp,
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
    via_label, required_date, company_name, disclosed_at, temp_booked_at,
    booker_description, booker_services, booker_corridors, booker_website,
    booker_fleet_size, booker_year_established, booker_licence_no, booker_licence_expiry)
  select t.id, p_tenant, p_user, 'temp_booked', trim(p_contact_name), trim(p_contact_channel),
         t.cargo_label, t.container_type, t.container_count, t.weight_tonnes, t.cbm, t.vehicle_types,
         t.route_label, t.distance_km, t.expected_duration_hours, t.pickup_text, t.dest_text,
         t.via_label, t.required_date, t.company_name, t.disclosed_at, now(),
         v_desc, v_services, v_corridors, v_website,
         v_fleet, v_year, v_lic_no, v_lic_exp
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

-- ---------- 4. The 6h reminder stamp (idempotent) — now on the record ----------
create or replace function transport_booking_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_n int := 0;
begin
  for r in
    update transport_requests t
       set reminder_sent_at = now(), updated_at = now()
     where t.status = 'temp_booked' and t.reminder_sent_at is null
       and t.deleted_at is null
       and t.temp_booked_at <= now() - interval '6 hours'
    returning t.id, t.tenant_id, t.job_id, t.shipment_id, t.booked_company_name,
              t.pickup_text, t.dest_text
  loop
    update transport_bookings b
       set reminder_sent_at = now()
     where b.request_id = r.id and b.status = 'temp_booked';

    insert into job_activity (tenant_id, job_id, shipment_id, actor_role,
      action, summary, entity, entity_id, meta)
    values (r.tenant_id, r.job_id, r.shipment_id, 'system',
      'transport.reminder_sent',
      format('6-hour reminder — %s still holds %s to %s with 6 hours left to confirm',
        coalesce(r.booked_company_name, 'the transporter'), r.pickup_text, r.dest_text),
      'transport_requests', r.id,
      jsonb_build_object('hoursRemaining', 6, 'company', r.booked_company_name));

    -- System actor: no user pressed anything — the clock did.
    insert into audit_logs (tenant_id, actor_role, entity, entity_id, action, after)
    values (r.tenant_id, 'system', 'transport_requests', r.id,
      'transport.booking_reminded',
      jsonb_build_object('reminderSentAt', now(),
        'company', r.booked_company_name, 'hoursRemaining', 6));

    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------- 5. The 12h auto-release (idempotent, row-locked) — now on the record ----------
create or replace function transport_booking_releases() returns setof uuid
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_booking uuid;
begin
  -- Skip rows another tick (or a confirm) is already deciding on.
  for r in
    select t.id, t.tenant_id, t.job_id, t.shipment_id, t.booked_company_name,
           t.pickup_text, t.dest_text
      from transport_requests t
     where t.status = 'temp_booked' and t.deleted_at is null
       and t.temp_booked_at <= now() - interval '12 hours'
     for update skip locked
  loop
    update transport_requests t
       set status = 'open', released_at = now(), updated_at = now()
     where t.id = r.id and t.status = 'temp_booked' and t.deleted_at is null;
    if not found then
      continue;  -- a confirm won the race while we were scanning
    end if;

    update transport_bookings b
       set status = 'expired', ended_at = now()
     where b.request_id = r.id and b.status = 'temp_booked'
    returning b.id into v_booking;

    insert into job_activity (tenant_id, job_id, shipment_id, actor_role,
      action, summary, entity, entity_id, meta)
    values (r.tenant_id, r.job_id, r.shipment_id, 'system',
      'transport.hold_expired',
      format('Hold expired — no confirmation in 12 hours, %s to %s is back on the board',
        r.pickup_text, r.dest_text),
      'transport_requests', r.id,
      jsonb_build_object('bookingId', v_booking,
        'company', r.booked_company_name, 'autoReleaseHours', 12));

    insert into audit_logs (tenant_id, actor_role, entity, entity_id, action, after)
    values (r.tenant_id, 'system', 'transport_requests', r.id,
      'transport.booking_auto_released',
      jsonb_build_object('bookingId', v_booking, 'releasedAt', now(),
        'company', r.booked_company_name));

    return next r.id;
  end loop;
end $$;

-- Signatures unchanged, so the execute grants from 048/049 survive the
-- replace. Refresh the doc comments to match what the functions now do.
comment on function transport_book_request(uuid, uuid, uuid, text, text) is
  'The concurrency gate: a single guarded UPDATE resolves two simultaneous books to one winner. Snapshots the booker''s company profile onto the request for the publisher to review.';
comment on function transport_booking_reminders() is
  'The 6h reminder stamp. Idempotent by predicate; records the reminder in job_activity + audit_logs from inside the database.';
comment on function transport_booking_releases() is
  'Auto-release at 12h. Idempotent (status guard) and row-locked (for update skip locked). Records the expiry in job_activity + audit_logs from inside the database, so it lands with no browser open.';

commit;
