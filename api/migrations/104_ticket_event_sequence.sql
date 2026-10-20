-- 104: the register of acts learns what happened first.
--
-- 101 gave every act its own row and ordered the story of an incidence by (ts, id). The
-- second half of that pair was `gen_random_uuid()`, and the first half cannot do the work:
-- `now()` is the transaction timestamp, so the two lines one request writes — "logged", then
-- "allocated" — carry the same instant to the microsecond. Their order was therefore decided
-- by a coin toss, and the desk printed "allocated" above "logged" often enough to be noticed.
-- A register that tells the story backwards is worse than no register: the next seat reads it
-- as evidence of who did what, in order.
--
-- A sequence fixes it honestly. The number is taken at insert time, inside the same
-- transaction, so it is strictly monotonic in the order the statements actually ran; nothing
-- about the recorded instant is invented.
--
-- Grants need saying out loud: an identity column brings its own sequence, and a sequence is a
-- separate object — table privileges do not reach it. app_runtime writes this register, so it
-- needs USAGE, or the first INSERT fails on a permission the table already grants.
begin;

alter table support_ticket_events
  add column if not exists seq bigint generated always as identity;

do $$
declare
  v_seq   text;
  v_lines int;
  v_multi int;
begin
  select pg_get_serial_sequence('public.support_ticket_events', 'seq') into v_seq;
  if v_seq is null then
    raise exception '104: no sequence behind support_ticket_events.seq — the identity column did not arrive';
  end if;
  execute format('grant usage, select on sequence %s to app_runtime', v_seq);
  select count(*)::int into v_lines from support_ticket_events;
  select count(*)::int into v_multi from (
    select ticket_id from support_ticket_events group by ticket_id having count(*) > 1) d;
  -- The rows already in the table took their numbers in physical order, and 103 moved the
  -- re-tagged withdrawal lines with an UPDATE. Nobody can read a story back out of that, so
  -- the old lines are left as they are: an incidence whose acts share one instant can only
  -- be ordered by the register it was written into.
  raise notice '104: support_ticket_events.seq is % — % line(s) in the register, % incidence(s) with more than one act',
    v_seq, v_lines, v_multi;
end $$;

-- The queue reads one incidence's acts in this order, so it needs an index that matches it.
create index if not exists support_ticket_events_order
  on support_ticket_events (ticket_id, seq);

commit;
