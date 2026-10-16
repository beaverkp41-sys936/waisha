-- 058: the report gate answers the question the operator actually asked.
--
-- 057 checked the three signatures, then the remarks, then the period. So a
-- supervisor opened a report for a training that had not finished yet, pressed
-- sign-off, and was told to go and collect three signatures — work the gate
-- would refuse again the moment it was done. The period is not one of three
-- independent conditions; it is the precondition of the whole exercise, because
-- there is nothing to sign until the training has ended.
--
-- Same rules, period moved to the front: an open period is refused before any
-- signature is asked for, then the signatures, then the remarks. The
-- immutability branch is untouched — 057 stands.
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
  if new.period_end > current_date then
    raise exception 'the training period is still open';
  end if;
  select count(*) into v_signed from public.trainee_report_signoffs s where s.report_id = new.id;
  if v_signed < 3 then
    raise exception 'the report needs all three sign-offs — HOD, HR Manager and Direct Supervisor; % present', v_signed;
  end if;
  if new.supervisor_remarks is null or length(trim(new.supervisor_remarks)) = 0 then
    raise exception 'a report is signed off only after the supervisor remarks are written';
  end if;
  if new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end $$;

commit;
