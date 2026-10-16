-- 057: a signed completion report is paper.
--
-- 056 gated the *signatures* against a signed report but left the report row
-- itself editable while it carried the complete status: the gate re-checked the
-- three signatures, the remarks and the period, found them all still in place,
-- and let the new values through. So a supervisor's remarks could be rewritten
-- after the HOD had signed, and the paper would still look signed.
--
-- That is the same integrity class as an issued invoice, so it gets the same
-- rule: once signed, the row is immutable. The only way back is reopen, which
-- puts the report into draft and unlocks its signature blocks again — and that
-- transition is deliberately allowed here, because a wrong signature has to be
-- correctable without deleting the person's training record.
begin;

create or replace function platform_auth.trainee_report_gate() returns trigger
language plpgsql as $$
declare
  v_signed int;
begin
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'a completion report is generated as a draft and signed afterwards';
  end if;
  -- A signed page is paper. Reopen it first — that is the only honest way back.
  if tg_op = 'UPDATE' and old.status = 'complete' and new.status = 'complete' then
    raise exception '% is immutable once the report is signed off; reopen it to correct the paper',
      tg_table_name;
  end if;
  if new.status <> 'complete' then
    if tg_op = 'UPDATE' and old.status = 'complete' then
      new.completed_at := null;
    end if;
    return new;
  end if;
  select count(*) into v_signed from public.trainee_report_signoffs s where s.report_id = new.id;
  if v_signed < 3 then
    raise exception 'the report needs all three sign-offs — HOD, HR Manager and Direct Supervisor; % present', v_signed;
  end if;
  if new.supervisor_remarks is null or length(trim(new.supervisor_remarks)) = 0 then
    raise exception 'a report is signed off only after the supervisor remarks are written';
  end if;
  if new.period_end > current_date then
    raise exception 'the training period is still open';
  end if;
  if new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end $$;

commit;
