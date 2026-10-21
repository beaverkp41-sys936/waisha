-- 122 — the board's order is a total order (task #338).
--
-- 121 hands the desk `rows` newest-first and the web page walks them with limit/offset.
-- Ordered by `created_at` alone, that is a *partial* order: whenever two rows share a
-- timestamp Postgres may return them in any order it likes, and it is free to change its
-- mind between two calls of the same query. So page 2 can show a row page 1 already showed
-- and hide the one that should have been on it — the desk would read a proposal twice, or
-- never see it, and an unanswered signature is exactly the thing this register exists to
-- make impossible to miss.
--
-- This is not hypothetical. 121's own SQL gate files two proposals inside one transaction,
-- and `created_at` defaults to `now()` — the transaction timestamp — so both rows carry the
-- identical instant. The first run of the gate passed the "newest first" check by luck and
-- the second failed it, which is what a non-deterministic order looks like from outside.
-- Two desks pressing ban on the same company within the same transaction is also how a
-- double-click arrives, and a `now()` tie is how anything batch-written in one call looks.
--
-- The fix is a tie-break, not a new clock: `id` is unique per row, so `(created_at desc,
-- id desc)` is total. For a genuine tie any order is still "newest first" — the point is
-- that the same question now gets the same answer twice, and a row cannot fall between two
-- pages. Both paged reads that 121 added are restated; each keeps its exact signature, so
-- `create or replace` carries the ACL forward (121 §7's grant to `app_runtime` and its
-- revoke from public/anon/authenticated/service_role stay, and 079's lesson is that a
-- changed signature would reset it).

-- The board: the same self-heal, the same filters, the same search, the same counts.
-- Only the two orderings — the page it picks and the aggregation that prints it — gain the
-- key that makes them agree with each other.
create or replace function platform_auth.approvals_board(
  p_status text,
  p_action text,
  p_search text,
  p_limit int,
  p_offset int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_rows jsonb;
  v_counts jsonb;
begin
  update platform_approvals set status = 'lapsed'
   where status = 'pending' and expires_at <= now();

  select coalesce(jsonb_agg(json_build_object(
      'id', a.id, 'action', a.action, 'target_kind', a.target_kind, 'target_id', a.target_id,
      'target_name', a.target_name, 'reason', a.reason, 'approval_status', a.status,
      'payload', a.payload, 'payload_sha256', a.payload_sha256,
      'proposed_name', a.proposed_name, 'proposed_role', a.proposed_role,
      'proposed_at', a.proposed_at,
      'decided_name', a.decided_name, 'decided_role', a.decided_role,
      'decided_note', a.decided_note, 'decided_at', a.decided_at,
      'applied_at', a.applied_at, 'result', a.result, 'expires_at', a.expires_at)
      order by a.created_at desc, a.id desc), '[]'::jsonb)
    into v_rows
    from (
      select q.*,
             coalesce(t.name, q.target_id) as target_name,
             pu.full_name as proposed_name,
             du.full_name as decided_name
        from (
          select a.id, a.action, a.target_kind, a.target_id, a.reason, a.status, a.payload,
                 a.payload_sha256, a.proposed_role, a.proposed_at, a.decided_role,
                 a.decided_note, a.decided_at, a.applied_at, a.result, a.expires_at,
                 a.created_at, a.proposed_by, a.decided_by
            from platform_approvals a
           where (p_status is null or p_status = 'all' or a.status = p_status)
             and (p_action is null or a.action = p_action)
             and (p_search is null or btrim(p_search) = ''
                  or a.reason ilike '%' || btrim(p_search) || '%'
                  or a.target_id ilike '%' || btrim(p_search) || '%'
                  or a.payload ->> 'note' ilike '%' || btrim(p_search) || '%'
                  or exists (select 1 from tenants tt
                              where tt.id::text = a.target_id
                                and tt.name ilike '%' || btrim(p_search) || '%'))
           order by a.created_at desc, a.id desc
           limit least(greatest(coalesce(p_limit, 30), 1), 100)
           offset greatest(coalesce(p_offset, 0), 0)) q
        left join tenants t on q.target_kind = 'tenant' and t.id::text = q.target_id
        left join users pu on pu.id = q.proposed_by
        left join users du on du.id = q.decided_by
    ) a;

  select jsonb_build_object(
           'pending',  count(*) filter (where status = 'pending'),
           'approved', count(*) filter (where status = 'approved'),
           'applied',  count(*) filter (where status = 'applied'),
           'rejected', count(*) filter (where status = 'rejected'),
           'lapsed',   count(*) filter (where status = 'lapsed'),
           'total',    count(*))
    into v_counts
    from platform_approvals
   where (p_action is null or action = p_action);

  return jsonb_build_object('rows', v_rows, 'counts', v_counts);
end $$;

-- A company's own register, read under the same limit/offset discipline, so it gets the
-- same tie-break. Its rows can tie for the reason 121's `tenant_apply_action` writes one
-- act per call: whoever batch-closes a licence today wants the two lines the sweep filed
-- in one transaction to stay in the order the desk printed them in yesterday.
create or replace function platform_auth.control_tenant_actions(p_tenant_id uuid, p_limit int)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(json_build_object(
           'id', a.id, 'action', a.action, 'reason_code', a.reason_code, 'note', a.note,
           'prior_status', a.prior_status, 'new_status', a.new_status,
           'seats_licensed', a.seats_licensed, 'actor_kind', a.actor_kind,
           'actor_role', a.actor_role, 'delivery', a.delivery, 'created_at', a.created_at,
           'approval_id', a.approval_id,
           'raised_by', pu.full_name, 'signed_by', du.full_name,
           'signed_at', ap.decided_at)
         order by a.created_at desc, a.id desc), '[]'::jsonb)
  from (select * from tenant_actions
         where tenant_id = p_tenant_id
         order by created_at desc, id desc limit least(coalesce(p_limit, 20), 50)) a
  left join platform_approvals ap on ap.id = a.approval_id
  left join users pu on pu.id = ap.proposed_by
  left join users du on du.id = ap.decided_by;
$$;

-- Restated rather than trusted: 121 §7 already ran these two lines, and a grant that only
-- exists because nobody dropped the function is a grant the next migration can lose.
grant execute on function
  platform_auth.approvals_board(text, text, text, int, int),
  platform_auth.control_tenant_actions(uuid, int)
to app_runtime;

revoke all on function
  platform_auth.approvals_board(text, text, text, int, int),
  platform_auth.control_tenant_actions(uuid, int)
from public, anon, authenticated, service_role;
