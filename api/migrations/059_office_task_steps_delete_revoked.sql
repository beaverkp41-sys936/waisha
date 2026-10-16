-- 059: take back the DELETE the API never asks for.
--
-- 056 granted delete on office_task_steps because re-mapping a flow looked like
-- it would need it. It does not: attaching a procedure to a task is idempotent
-- (the copy stays, the task simply points at the new procedure), retiring a
-- procedure soft-deletes its steps, and the only hard delete in the module is a
-- checklist item that has never been ticked. So the grant is privilege the
-- runtime holds and no code path uses — exactly what 041 and 051 exist to remove.
--
-- delete on office_task_step_checks and trainee_report_signoffs stays: both are
-- real call sites, both are gated first (a ticked item is evidence and a signed
-- report is paper), and both refuse through the 409 the routes already return.
begin;

revoke delete on office_task_steps from app_runtime;

commit;
