-- 103: a withdrawal gets its own word in the register.
--
-- 101 let one action key mean two different acts. Settling an incidence as
-- "closed — it ends here" and taking it off the boards both wrote `closed`, so the audit
-- trail and the desk's own event list said "Closed" for a removal that a caller could quote
-- a number against. They are not the same decision: one answers the person, the other hides
-- the row from every queue while keeping the evidence. The desk can already tell them apart
-- from the labels ("closed" versus "withdrawn from the register"), but nobody filters an
-- evidence register by reading two columns.
--
-- Widening a check is additive: nothing written under 101 is refused, and the rows already
-- carrying the old word for a removal are re-tagged here so the register says one thing per
-- act from the first line to the last. Only a tombstoned row matches the re-tag — the
-- withdraw door (control-tickets.routes.ts:735) refuses anything that is not closed first,
-- and it stamps `detail.withdrawn`, so the update cannot sweep up an ordinary settling.
begin;

alter table support_ticket_events
  drop constraint if exists support_ticket_events_action_check;

alter table support_ticket_events
  add constraint support_ticket_events_action_check check (action in (
    'logged','allocated','reallocated','status_changed','priority_changed',
    'note_added','resolved','reopened','closed','withdrawn'));

update support_ticket_events
   set action = 'withdrawn'
 where action = 'closed'
   and ((detail->>'withdrawn') = 'true' or to_label = 'withdrawn from the register');

do $$
declare
  v_retained int;
  v_tagged   int;
begin
  select count(*)::int into v_tagged from support_ticket_events where action = 'withdrawn';
  select count(*)::int into v_retained from support_tickets where deleted_at is not null;
  raise notice '103: withdrawn is its own action — % line(s) re-tagged, % tombstoned incidence(s) still in the table',
    v_tagged, v_retained;
end $$;

commit;
