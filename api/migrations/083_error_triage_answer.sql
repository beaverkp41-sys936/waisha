-- 083 — the judgement the desk just made is the judgement it is told about.
--
-- 082 declared `mark_error` as a `language sql` function whose guard CTE and upsert CTE were
-- correct, but whose final SELECT re-read `app_error_notes` to build its answer. That is the
-- mistake this file exists to record: in a single SQL statement every sub-statement, including
-- the data-modifying CTE, runs against the SAME snapshot. The CTE writes the row; the main
-- query cannot see that write.
--
-- Two consequences, both found by running 082's verify script rather than reading it:
--
--  - triaging a fingerprint for the first time wrote the note and answered with ZERO rows,
--    because at snapshot time no note existed. `POST /control/errors/:fingerprint/triage`
--    turns an empty answer into 404 "not in the register" — so the desk would have been told
--    its own first judgement on every line had failed, while the note was in the table the
--    whole time. A second triage of the same line answered 200 with the PREVIOUS state and
--    the PREVIOUS note, which is worse: it reads as a save that did not take.
--  - the guards that were meant to refuse an unknown state, an over-long note or an unknown
--    fingerprint with no rows at all did refuse the write — and, unlike the success path,
--    happened to answer correctly, because re-reading a row that does not exist is also empty.
--    A test that only checked the refusals would have passed.
--
-- The fix is to answer from the CTE's own RETURNING list, which is by definition the row that
-- was written. Nothing else in the body changes: the same guard, the same upsert, the same
-- keep-the-old-note rule, the same four states, and still no parameter that can touch a
-- message, a count or a time in the register itself.
--
-- `create or replace` keeps the function's ACL, so this body cannot arrive with PUBLIC EXECUTE
-- the way a drop-and-recreate did in 078 → 079. The sweep is repeated anyway, because the
-- posture of this door is the reason the register cannot be edited into silence.

begin;

create or replace function platform_auth.mark_error(
  p_fingerprint text,
  p_state text,
  p_note text,
  p_actor uuid)
returns table (fingerprint text, state text, note text, updated_at timestamptz)
language sql security definer set search_path = public as $$
  with guard as (
    select (p_state in ('open','triaged','resolved','ignored')
            and coalesce(char_length(nullif(trim(coalesce(p_note, '')), '')), 0) <= 600
            and exists (select 1 from app_errors e where e.fingerprint = p_fingerprint)
           ) as ok
  ), written as (
    insert into app_error_notes (fingerprint, state, note, updated_by, updated_at)
    select p_fingerprint, p_state, nullif(trim(coalesce(p_note, '')), ''), p_actor, now()
      from guard where guard.ok
    on conflict (fingerprint) do update
      -- A blank note means "change the state only"; it must not wipe what an earlier seat
      -- wrote. The note itself is still replaceable, because triage is a judgement that is
      -- allowed to change. No column here can touch a message, a count or a time.
      set state = excluded.state,
          note = coalesce(excluded.note, app_error_notes.note),
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      -- The four output columns in the order the returns table declares them: a RETURNING *
      -- here would be the whole row, including columns this door has no business naming.
      returning app_error_notes.fingerprint, app_error_notes.state,
                app_error_notes.note, app_error_notes.updated_at
  )
  -- The answer is the write, not a second read of a snapshot that predates it. When the guard
  -- is false the insert produced no rows, so this is empty and the route can say 404 truthfully.
  select w.fingerprint, w.state, w.note, w.updated_at from written w;
$$;

grant execute on function platform_auth.mark_error(text, text, text, uuid) to app_runtime;
revoke all on function platform_auth.mark_error(text, text, text, uuid)
  from public, anon, authenticated, service_role;

commit;
