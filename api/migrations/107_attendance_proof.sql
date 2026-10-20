-- 107: a working day that the person confirmed themselves, and what they showed.
--
-- Task #182: "on attendance, i want the staff can do daily confirmation of work by
-- geolocation or photo". The register already takes a self clock-in (065) and stamps
-- lateness from it; what was missing is the evidence a supervisor can point at when the
-- person says they were on the ground. So the confirmation is not a second kind of day —
-- it is the clock-in the office already reads, with a proof hanging off it.
--
-- The proof lives on the day rather than in its own table because a day has exactly one:
-- the unique index on (tenant_id, employee_id, work_date) already says so, and a register
-- with two answers for one person's Tuesday is not a register.

-- ---------------------------------------------------------------------------
-- 1. the columns
-- ---------------------------------------------------------------------------

alter table employee_attendance
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid,
  add column if not exists proof_kind text,
  add column if not exists proof_lat numeric(9,6),
  add column if not exists proof_lng numeric(9,6),
  add column if not exists proof_accuracy_m int,
  add column if not exists proof_document_id uuid references documents(id);

alter table employee_attendance drop constraint if exists employee_attendance_proof_kind_check;
alter table employee_attendance add constraint employee_attendance_proof_kind_check
  check (proof_kind is null or proof_kind in ('location','photo'));

-- A confirmation is a moment, the seat that pressed it and a thing it showed. Half of that
-- is not a confirmation — a row with a time and no proof would let the register claim an
-- evidence it cannot produce.
alter table employee_attendance drop constraint if exists employee_attendance_proof_pair_check;
alter table employee_attendance add constraint employee_attendance_proof_pair_check
  check ((confirmed_at is null and proof_kind is null and confirmed_by is null)
     or (confirmed_at is not null and confirmed_by is not null and proof_kind is not null));

-- The bounds are the planet's, not a guess about where the office is.
alter table employee_attendance drop constraint if exists employee_attendance_proof_geo_check;
alter table employee_attendance add constraint employee_attendance_proof_geo_check
  check ((proof_lat is null or (proof_lat >= -90 and proof_lat <= 90))
     and (proof_lng is null or (proof_lng >= -180 and proof_lng <= 180))
     and (proof_accuracy_m is null or (proof_accuracy_m >= 0 and proof_accuracy_m <= 20000)));

-- The kind decides which half may be filled. A "photo" with coordinates or a "location"
-- with a file would be two stories about the same minute.
alter table employee_attendance drop constraint if exists employee_attendance_proof_shape_check;
alter table employee_attendance add constraint employee_attendance_proof_shape_check
  check ((proof_kind is null)
     or (proof_kind = 'location' and proof_lat is not null and proof_lng is not null
         and proof_document_id is null)
     or (proof_kind = 'photo' and proof_document_id is not null
         and proof_lat is null and proof_lng is null and proof_accuracy_m is null));

create index if not exists idx_attendance_proof
  on employee_attendance (tenant_id, work_date)
  where deleted_at is null and confirmed_at is not null;

-- A proof file is a document like every other one — tenant-scoped, magic-byte sniffed,
-- served through the signed-URL route. It gets its own kind so the person's avatar pile and
-- the day's evidence do not mix.
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check
  check (kind in ('logo','avatar','licence','insurance','inspection','road_licence',
                  'delivery_note','invoice','bill_of_lading','packing_list','contract',
                  'other','attachment','receipt','shipper_upload','arrival_notice',
                  'delivery_order','declaration','assessment','release_note','permit',
                  'pod','handover','proforma','attendance_proof'));

-- ---------------------------------------------------------------------------
-- 2. the shape and the memory of the proof
-- ---------------------------------------------------------------------------

-- Two jobs, both done here rather than in whichever route remembers to do them:
--
--   * The position is coarse by rule. Coordinates are a person's movements, so the column
--     keeps three decimals — about 100 m at this latitude — which answers the question the
--     office actually asked ("were you around work?") and not the one it did not. A route
--     that later wants metre precision cannot get it, which is the point.
--   * A confirmation cannot be quietly re-made. The office corrects a *day* through
--     attendance.edit; swapping somebody's evidence after the fact is a different act, and
--     nobody is trusted with it. Deleting the day stays possible (the soft delete is
--     audited), so a wrong row is not a prison.
create or replace function public.attendance_proof_shape()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Already confirmed: the evidence is frozen. The one legal write is the office's soft
  -- delete, which is a decision about the day, not about the proof.
  if tg_op = 'UPDATE' and old.confirmed_at is not null then
    if new.deleted_at is null
       and (new.proof_kind, new.proof_lat, new.proof_lng, new.proof_accuracy_m,
            new.proof_document_id, new.confirmed_at, new.confirmed_by)
       is distinct from
          (old.proof_kind, old.proof_lat, old.proof_lng, old.proof_accuracy_m,
            old.proof_document_id, old.confirmed_at, old.confirmed_by)
    then
      raise exception 'A day already confirmed keeps its proof; correct the day, not the evidence.';
    end if;
    return new;
  end if;

  -- A fresh row, or a day whose clock-in came first and whose proof is now written for the
  -- first time: both go through the same shaping. Rounding only on INSERT would leave the
  -- person who clocked in before confirming stored to the metre while the rest got 100 m.
  if new.proof_kind = 'location' then
    new.proof_lat := round(new.proof_lat, 3);
    new.proof_lng := round(new.proof_lng, 3);
    new.proof_document_id := null;
  elsif new.proof_kind = 'photo' then
    new.proof_lat := null;
    new.proof_lng := null;
    new.proof_accuracy_m := null;
  else
    new.proof_lat := null;
    new.proof_lng := null;
    new.proof_accuracy_m := null;
    new.proof_document_id := null;
    new.confirmed_at := null;
    new.confirmed_by := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_attendance_proof_shape on employee_attendance;
create trigger trg_attendance_proof_shape before insert or update
  on employee_attendance for each row execute function public.attendance_proof_shape();

grant execute on function public.attendance_proof_shape() to app_runtime;

-- ---------------------------------------------------------------------------
-- 3. comments
-- ---------------------------------------------------------------------------

comment on column employee_attendance.proof_lat is
  'Rounded to 3 decimals by trg_attendance_proof_shape — about 100 m. Never in a list endpoint: see GET /attendance/:id/proof.';
comment on column employee_attendance.proof_document_id is
  'The documents row (kind attendance_proof, entity_type employee) the person uploaded as their day''s evidence.';
comment on column employee_attendance.confirmed_by is
  'The seat that pressed confirm. It is the person''s own seat — the route refuses to confirm anyone else''s day.';

-- No new duty key. Confirming is the act 065 already calls attendance.clock — which every
-- desk role holds — with evidence attached; a second key would have to be handed to the same
-- people, and a staff member who can clock but cannot confirm would be the bug that creates.
