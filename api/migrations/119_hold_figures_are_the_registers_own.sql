-- 119 — what a hold's own figures are, the register's to write and nobody's to type (task #190d).
--
-- 118 said it in a comment: `quantity_in`, `quantity_out`, `entered_on`, `exited_on`, `released_by`
-- and the status are *projections* of the dockets, recomputed by `warehouse_slip_booked()` after
-- every filing and every void, and the routes never write them. The sentence was true of the desks
-- and false of the table. A caller with SQL — or a future route that copies the wrong column into an
-- UPDATE — could open a hold with `quantity_in = 500, status = 'released'` and no docket behind it,
-- and the store would print a storage charge for goods that were never counted in. That is the exact
-- failure this register exists to prevent, so the promise moves from the comment into the trigger.
--
-- Two halves, because the two cases behave differently:
--
--   * INSERT. A hold as it is born has no paper, so its figures are written empty: the two
--     quantities zero, the two dates and the releaser null, and a status that is not `cancelled`
--     becomes `stored`. This is a correction rather than a refusal — a hold opened with a first
--     delivery is opened by the route that files the docket in the same act, and the booking trigger
--     then fills the row from the slip. Nothing legitimate changes shape.
--
--   * UPDATE. Here a refusal is the only honest answer, because a hand-written 400 is not the same
--     as the dockets' 400 and silently emptying the column would destroy a real release. The
--     bookkeeper has to be let through, and it is the *same role* on both sides: 118's functions run
--     as invoker (app_runtime holds the table grants it needs to file a docket), so privileges cannot
--     tell the booking trigger from a caller. A transaction-local mark is what can. `warehouse_slip_booked()`
--     sets `app.warehouse_booking` for the transaction, takes its lock, and writes; the shape trigger
--     admits a figure change only while the mark is up. `set_config(..., true)` is dropped at the end
--     of the transaction, so a pooled connection carries no mark into somebody else's write, and a
--     route that files two dockets is two transactions, each marked by its own booking.
--
-- `cancelled` is deliberately outside the mark. Calling a hold off is a header act the clerk does by
-- hand — with a name and a reason, and only while the hold received nothing — and 118 already freezes
-- a called-off or emptied row from being rewritten. What is refused is a status that *pretends paper
-- exists*: `released`, and the date and the name that go with it.
--
-- The second half is the money rule 118 stated in prose and left to the API: a hold that has given
-- out everything it received takes no new delivery. The door refused it and the table allowed it, so
-- a route bug — or a caller with SQL — could count crates into a hold that closed last month, and the
-- booking trigger's own `entered_on` (the *earliest* filed entry) would price the new goods from the
-- day the first crate arrived. `warehouse_slip_shape()` already reads the hold's status under a lock
-- to refuse a called-off one; it now refuses an emptied one for the same reason and in the same place.
-- Correcting a release that never happened stays open: voiding the exit docket is an UPDATE of that
-- docket's state, it puts the goods back and the hold back to `stored`, and only then may paper be
-- filed again.

begin;

-- The body below is 118's, with one rule added where the note says so: a plpgsql function is
-- replaced whole, never amended, so the words a later reader compares against the register are here
-- in full.

create or replace function public.warehouse_slip_shape()
returns trigger language plpgsql set search_path = public as $$
declare
  v_status text;
  v_in numeric;
  v_out numeric;
  v_first_in date;
  v_would_in numeric;
  v_would_out numeric;
  v_prefix text;
begin
  -- Cut from the kind, so the number and the movement cannot disagree. Assigned here rather than
  -- written inline in the condition below: plpgsql ends an IF condition at the first THEN it sees,
  -- and a CASE inside the condition carries its own — the whole body then fails to parse.
  v_prefix := case when new.kind = 'entry' then 'WE-' else 'WX-' end;

  if tg_op = 'INSERT' then
    if new.ref is null or trim(new.ref) = '' then
      new.ref := v_prefix ||
        to_char(date_trunc('year', new.slip_day), 'YYYY') || '-' ||
        lpad(nextval(case when new.kind = 'entry'
                          then 'warehouse_entry_ref_seq'
                          else 'warehouse_exit_ref_seq' end)::text, 5, '0');
    elsif left(new.ref, 3) <> v_prefix then
      raise exception 'A docket number carries the prefix of the movement it records.';
    end if;
    if new.state <> 'filed' then
      raise exception 'A docket is filed as it is written; a mistake is voided after the fact.';
    end if;
  else
    if new.ref          is distinct from old.ref
       or new.kind      is distinct from old.kind
       or new.stay_id   is distinct from old.stay_id
       or new.tenant_id is distinct from old.tenant_id
       or new.slip_day  is distinct from old.slip_day
       or new.quantity  is distinct from old.quantity
       or new.docket_ref is distinct from old.docket_ref
       or new.note      is distinct from old.note
       or new.filed_by  is distinct from old.filed_by
       or new.filed_at  is distinct from old.filed_at
       or new.created_at is distinct from old.created_at then
      raise exception 'A filed docket is not rewritten — void it and file the correct one.';
    end if;
    if old.state = 'voided' then
      raise exception 'A voided docket stays voided; file a new one.';
    end if;
    if new.state = 'filed' then
      raise exception 'A docket cannot be un-voided; file a new one.';
    end if;
    if new.voided_by is null or trim(coalesce(new.void_reason,'')) = '' then
      raise exception 'A voided docket says who voided it and why.';
    end if;
    -- Would the balance still add up with this docket gone? The row still reads `filed` here, so
    -- its own quantity is taken back out of whichever side it belongs to.
    select coalesce(sum(s.quantity) filter (where s.kind = 'entry'), 0),
           coalesce(sum(s.quantity) filter (where s.kind = 'exit'), 0)
      into v_in, v_out
      from warehouse_slips s
     where s.stay_id = old.stay_id and s.tenant_id = old.tenant_id and s.state = 'filed';
    v_would_in := case when old.kind = 'entry' then v_in - old.quantity else v_in end;
    v_would_out := case when old.kind = 'exit' then v_out - old.quantity else v_out end;
    if v_would_out > v_would_in then
      raise exception 'This docket cannot be voided while the goods it released are still out — void those dockets first.';
    end if;
    return new;
  end if;

  -- The lock is the point as much as the read: two exits filed in the same second against one hold
  -- would each see the balance before the other landed, and the store would release double.
  select status into v_status
    from warehouse_stays
   where id = new.stay_id and tenant_id = new.tenant_id
     for update;
  if not found then
    raise exception 'This docket belongs to a hold that is not in your register.';
  end if;
  if v_status = 'cancelled' then
    raise exception 'A hold that was called off takes no dockets.';
  end if;
  if v_status = 'released' then
    raise exception 'A hold that has given out everything it received is closed, and takes no new '
      'docket — a new delivery opens its own hold, or the days it is charged would count from the '
      'first crate, not from these goods. Void the exit docket if the release was a mistake.';
  end if;

  if new.kind = 'exit' then
    select coalesce(sum(s.quantity) filter (where s.kind = 'entry'), 0),
           coalesce(sum(s.quantity) filter (where s.kind = 'exit'), 0),
           min(s.slip_day) filter (where s.kind = 'entry')
      into v_in, v_out, v_first_in
      from warehouse_slips s
     where s.stay_id = new.stay_id and s.tenant_id = new.tenant_id and s.state = 'filed';
    if v_in = 0 then
      raise exception 'Nothing has been filed into this hold yet, so nothing can leave it.';
    end if;
    if v_first_in is not null and new.slip_day < v_first_in then
      raise exception 'Goods cannot leave the store on % — they arrived on %.', new.slip_day, v_first_in;
    end if;
    if v_out + new.quantity > v_in then
      raise exception 'The store holds % — it cannot release %.',
        trim_scale(v_in - v_out), trim_scale(new.quantity);
    end if;
  end if;
  return new;
end $$;


create or replace function public.warehouse_slip_booked()
returns trigger language plpgsql set search_path = public as $$
declare
  v_in numeric;
  v_out numeric;
  v_first_in date;
  v_last_out date;
  v_last_out_by uuid;
begin
  select coalesce(sum(s.quantity) filter (where s.kind = 'entry' and s.state = 'filed'), 0),
         coalesce(sum(s.quantity) filter (where s.kind = 'exit'  and s.state = 'filed'), 0),
         min(s.slip_day) filter (where s.kind = 'entry' and s.state = 'filed'),
         max(s.slip_day) filter (where s.kind = 'exit'  and s.state = 'filed'),
         (array_agg(s.filed_by order by s.slip_day desc, s.filed_at desc nulls last)
            filter (where s.kind = 'exit' and s.state = 'filed'))[1]
    into v_in, v_out, v_first_in, v_last_out, v_last_out_by
    from warehouse_slips s
   where s.stay_id = new.stay_id and s.tenant_id = new.tenant_id;

  -- The mark is read by warehouse_stay_shape() on the update below, and by nothing else. It is set
  -- here rather than passed because a trigger cannot hand its reason to another trigger.
  perform set_config('app.warehouse_booking', 'on', true);

  update warehouse_stays w
     set entered_on = v_first_in,
         quantity_in = v_in,
         quantity_out = v_out,
         exited_on = case when v_in > 0 and v_out >= v_in then v_last_out end,
         released_by = case when v_in > 0 and v_out >= v_in then v_last_out_by end,
         status = case when w.status = 'cancelled' then 'cancelled'
                      when v_in > 0 and v_out >= v_in then 'released'
                      else 'stored' end,
         updated_at = now()
   where w.id = new.stay_id and w.tenant_id = new.tenant_id;
  return new;
end $$;

create or replace function public.warehouse_stay_shape()
returns trigger language plpgsql set search_path = public as $$
declare
  v_year int := extract(year from current_date)::int;
  v_booking text := coalesce(current_setting('app.warehouse_booking', true), '');
begin
  if tg_op = 'INSERT' then
    new.quantity_in := 0;
    new.quantity_out := 0;
    new.entered_on := null;
    new.exited_on := null;
    new.released_by := null;
    if new.status is distinct from 'cancelled' then
      new.status := 'stored';
    end if;
  end if;

  if tg_op = 'UPDATE' and v_booking <> 'on' then
    if new.quantity_in   is distinct from old.quantity_in
       or new.quantity_out  is distinct from old.quantity_out
       or new.entered_on    is distinct from old.entered_on
       or new.exited_on     is distinct from old.exited_on
       or new.released_by   is distinct from old.released_by
       or (new.status is distinct from old.status
           and new.status is distinct from 'cancelled') then
      raise exception 'A hold''s quantities, dates and released status are its dockets'' conclusion. '
        'File or void the docket and the register writes them; they are not typed onto the row.';
    end if;
  end if;

  if new.ref is null or trim(new.ref) = '' then
    new.ref := 'WH-' || v_year || '-' || lpad(nextval('warehouse_stay_ref_seq')::text, 5, '0');
  end if;

  if new.status = 'cancelled' then
    if new.cancelled_by is null or trim(coalesce(new.cancel_reason,'')) = '' then
      raise exception 'A called-off hold says who called it off and why.';
    end if;
    if new.quantity_in <> 0 then
      raise exception 'A hold that received goods is emptied by an exit docket, not cancelled.';
    end if;
  elsif new.cancelled_by is not null or trim(coalesce(new.cancel_reason,'')) <> '' then
    raise exception 'Only a cancelled hold carries a cancellation.';
  end if;

  if tg_op = 'UPDATE' and old.status in ('released','cancelled') then
    if new.shipment_id    is distinct from old.shipment_id
       or new.place        is distinct from old.place
       or new.goods        is distinct from old.goods
       or new.unit         is distinct from old.unit
       or new.container_number is distinct from old.container_number
       or new.daily_rate   is distinct from old.daily_rate
       or new.currency     is distinct from old.currency
       or new.free_days    is distinct from old.free_days
       or new.notes        is distinct from old.notes
       or new.opened_by    is distinct from old.opened_by then
      raise exception 'A hold that has been emptied or called off is not rewritten.';
    end if;
  end if;
  return new;
end $$;

-- 118 set the privileges; a replaced function keeps its ACL, and the catalog gate in
-- scripts/verify-privileges-sql.ts reads the acl rather than the intent, so say it again in words.
revoke execute on function public.warehouse_stay_shape() from public, anon, authenticated;
revoke execute on function public.warehouse_slip_shape() from public, anon, authenticated;
revoke execute on function public.warehouse_slip_booked() from public, anon, authenticated;
grant execute on function public.warehouse_stay_shape() to app_runtime;
grant execute on function public.warehouse_slip_shape() to app_runtime;
grant execute on function public.warehouse_slip_booked() to app_runtime;

comment on function public.warehouse_slip_shape() is
  'A docket''s own rules, and the hold''s: a called-off or emptied hold takes no paper, because its one entered_on would charge new goods from the day the first crate arrived.';
comment on column warehouse_stays.quantity_in is
  'A projection of the filed entry dockets, written by warehouse_slip_booked(). Typed in, it is emptied on insert and refused on update.';
comment on column warehouse_stays.status is
  'stored | released | cancelled. released is the dockets'' conclusion and only they may write it; cancelled is a clerk''s act, with a name and a reason.';

do $$ declare
  v_rows int;
  v_slips int;
  v_offbook int;
begin
  select count(*)::int into v_rows from warehouse_stays;
  select count(*)::int into v_slips from warehouse_slips;
  -- Any row the new rule would have refused is reported rather than rewritten: a hold that says it
  -- released while its paper says otherwise is a money question for the office, not a line for a
  -- migration to quietly fix.
  select count(*)::int into v_offbook
    from warehouse_stays w
    join (select s.stay_id,
                 coalesce(sum(s.quantity) filter (where s.kind = 'entry' and s.state = 'filed'), 0) as q_in,
                 coalesce(sum(s.quantity) filter (where s.kind = 'exit'  and s.state = 'filed'), 0) as q_out
            from warehouse_slips s group by s.stay_id) x on x.stay_id = w.id
   where w.quantity_in <> x.q_in or w.quantity_out <> x.q_out;
  raise notice '119: the register''s figures are its own to write; % hold(s), % docket(s), % hold(s) off book',
    v_rows, v_slips, v_offbook;
end $$;

commit;
