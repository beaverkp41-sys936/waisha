-- 138: A count keeps another money's figure out of its sum.
--
-- 135 minted a rule in one hand and broke it in the other. The register says
-- `currency … check (currency in ('TZS','USD'))` beside the words "one money per run … a run that
-- added a TZS difference to a USD one would be the same crime in the report", and the count it raises
-- asks twenty questions of which two — `webhook_not_landed` and `webhook_retries_spent` — join
-- `payments` on the reference a rail pushed, put `pay.amount` straight into `paper_figure` and never
-- ask that row which money it is in. `paper_figure` is what `net_difference` is summed from. 136
-- lifted 135's door whole to fix a different lie and changed only the guard on those same two blocks,
-- so the omission came with it.
--
-- The desk is what caught it. A gateway count over a day that holds TZS charges came back as
-- `REC-2026-00684 … net -360,000.00 USD`: three hundred and sixty thousand dollars no paper in this
-- office has ever held. Each finding's own sentence is honest, because it prints the charge's currency
-- inline — `… is pending for 180000.00 TZS` — and the figure in the column beside it is not, which is
-- the worst shape a report can take. A seat reads a USD total off a USD run and has to work out at
-- home that these rails only ever push TZS. The two wrong runs the desk raised during this stage's
-- browser pass are the evidence: the count was signed by nobody, and it was wrong in the one column a
-- signing seat is supposed to be able to add up without opening the findings.
--
-- The fix is the bind every other question already carries. Each money-bearing question in the count
-- names the run's money on the row it reads its figure from — `p.currency = v_cur` on 18's stale
-- charge, `a.currency = v_cur` on the wallet, escrow, payable and gateway lines, `q.currency = v_cur`
-- inside every population written to `examined`. Those two blocks are the only places a figure crossed
-- into a report without being asked. So both bind it now, and the run says so out loud in
-- `examined.skipped`, because a count that stops asking about half the pile is exactly the case 135's
-- own header demands be written down rather than left for a reader to notice: "an empty report that
-- does not say what it looked at is a claim, not a check".
--
-- The two blocks are held back differently, on purpose. `webhook_not_landed` joins the charge inner:
-- its whole account is that charge's state and its money, so a charge in another money is simply not
-- this run's charge and the line is not raised. `webhook_retries_spent` keeps its left join, because a
-- delivery whose reference belongs to nothing is precisely the thing a seat has to take to the rail,
-- and it carries no figure at all — so the bind is written to let a missing charge through
-- (`coalesce(pay.currency, v_cur) = v_cur`) and hold back only a charge that exists in another money.
-- Binding the currency in the join's `on` clause instead would turn "this desk spent its five presses
-- here" into "the charge is not ours to find", which is 136's false sentence wearing a different coat.
--
-- The two money-free delivery questions keep answering in either money. `webhook_unverified` and
-- `webhook_orphan` are facts about the wire whose `book_figure` and `paper_figure` are both zero, so
-- a USD count that hid them would hide a pile of bad signatures for an arithmetic reason.
--
-- **What this file does not change.** The seventeen book, wallet, escrow, payout and refund questions;
-- 136's guard on the two blocks — a delivery is still an exception only when its charge does not say
-- what the rail asked, and the word the rail asked for is still read the door's way; the
-- twenty-five-line ceilings, the numbering, the two-seat signature, the discard, the statement, the
-- board, the retry door, its ledger and 137's key; the scrub; the duties and every grant. And no run
-- already written: a count that reported the wrong sum stays as it was raised, because 135's guard on a
-- run's own account exists so that no figure a seat may still be reading can be moved underneath it.
-- REC-2026-00684 goes through the desk's discard and the count is re-raised, which is the only way a
-- draft dies in this office.
begin;

-- ============================================================
-- 1. the count, with the two figures asked which money they are in
-- ============================================================

-- 136's body lifted whole. Three clauses differ: the sentence written into the USD run's
-- `examined.skipped`, and one currency bind in each of the two delivery blocks that carry a figure.
-- Same signature, same security definer, same search path.
/**
 * One act of counting.
 *
 * The shape is deliberate: every question is written as a SELECT of its *exceptions* and the twenty
 * are UNION ALLed into one INSERT, so a check that agrees writes nothing and the register ends up
 * holding exactly the list of things the office has to answer for. `examined` then carries what each
 * run looked at — the populations, the list of questions it was allowed to ask, and the sentences
 * naming anything it had to leave alone — which is the evidence a signing seat reads when the
 * findings list is empty. An empty report that does not say what it looked at is a claim, not a check.
 *
 * The questions, and what each one is really asking:
 *
 *   book    `book_sums_to_zero`     every leg ever written in this money nets debits against credits.
 *           `posting_square`        each movement in the window has two legs, both sides, and a
 *                                   header figure equal to its own debits (133's commit rule, re-asked
 *                                   from the outside — a trigger that got it wrong once is not undone
 *                                   by the fact that it fires).
 *           `account_totals`        the cached figures on a line still follow its legs.
 *   wallet  `wallet_overdrawn`      a holder's line cannot be paid out below nothing.
 *           `wallet_line_orphan`    a `WLT-…` line in the book with no wallet pointing at it.
 *           `wallet_heading`        money is held on each holder's own line, never on `WALLET-…`.
 *   escrow  `escrow_line_total`     what waits in `ESCROW-…` is what the live papers say waits.
 *           `escrow_paper_postings` a parked or paid-out hold has the movements it claims.
 *   payout  `payable_line_total`    `PAYOUT-DUE`/`REFUND-DUE` equals the signed-but-unpaid papers.
 *           `payout_paper_postings` each paper's accrual, payment or mirror is there, is the figure
 *                                   on the paper, and stands on the three accounts the paper names.
 *           `batch_totals`          the total a second seat signed is still its own lines' total.
 *   refund  `refund_paper_unpaid`   a signed 126 paper the office still owes and has never accrued.
 *           `refund_payout_paper`   a refund payout whose paper is gone, ungranted, or says another
 *                                   figure.
 *   gateway `webhook_unverified`    deliveries the platform could not verify, in the days asked about.
 *           `webhook_not_landed`    a verified delivery whose charge does not say what the rail
 *                                   said — still open, or closed the other way. The pile 005's
 *                                   insert-only register could not otherwise show.
 *           `webhook_orphan`        a delivery whose reference belongs to no payment. The two are
 *                                   disjoint by the reference, so one delivery is never named twice
 *                                   for the same reason.
 *           `webhook_retries_spent` a delivery already re-driven five times and still open.
 *           `payment_stale`         a charge still `pending` past its own countdown (134's ten
 *                                   minutes, 009's door).
 *           `gateway_line_total`    what the rails confirmed against what the book's gateway line
 *                                   holds — the one place 135 states out loud that 005's licence
 *                                   money has never settled into the office's book.
 *
 * Nothing here writes money: no leg, no header, no cached total. A tool that finds drift must not be
 * the thing that edits it.
 */
create or replace function platform_auth.run_money_reconciliation(
  p_tenant uuid, p_scope text, p_currency text, p_from date, p_to date,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_scope  text := lower(trim(coalesce(p_scope, 'all')));
  v_cur    text := upper(trim(coalesce(p_currency, 'TZS')));
  v_from   date := p_from;
  v_to     date := p_to;
  v_run    uuid := gen_random_uuid();
  v_sfx    text;
  v_book   boolean;
  v_wallet boolean;
  v_escrow boolean;
  v_pay    boolean;
  v_ref    boolean;
  v_gate   boolean;
  v_rails  boolean;
  v_names  text[] := '{}'::text[];
  v_skip   jsonb := '[]'::jsonb;
  v_exam   jsonb;
  v_find   int := 0;
  v_net    numeric(14,2) := 0;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('ok', false, 'error', 'not_the_office',
      'message', 'A count is made of the office''s own book, and this session is not that book.');
  end if;
  if v_scope not in ('book','wallet','escrow','payout','refund','gateway','all') then
    return jsonb_build_object('ok', false, 'error', 'bad_scope', 'scope', v_scope,
      'message', 'Say what is being counted: the book, a wallet, escrow, a payout, a refund, the '
        || 'gateway, or all of it at once.');
  end if;
  if v_cur not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'bad_currency', 'currency', v_cur,
      'message', 'One money per count. The book holds two, and adding a difference in one to a '
        || 'difference in the other is how a report becomes unreadable.');
  end if;
  if v_from is null or v_to is null then
    return jsonb_build_object('ok', false, 'error', 'bad_days',
      'message', 'A count is asked of a window of days: the book is kept by day, and so is the pile '
        || 'of deliveries.');
  end if;
  if v_from > v_to then
    return jsonb_build_object('ok', false, 'error', 'bad_days', 'from_day', v_from, 'to_day', v_to,
      'message', 'The window runs backwards. The first day has to be the earlier one.');
  end if;
  if v_to > current_date then
    return jsonb_build_object('ok', false, 'error', 'bad_days', 'to_day', v_to,
      'message', 'There is no day ' || v_to || ' to count up to yet. A run is an account of days '
        || 'that have happened.');
  end if;

  v_sfx := case when v_cur = 'USD' then '-USD' else '' end;
  v_book   := v_scope in ('book','all');
  v_wallet := v_scope in ('wallet','all');
  v_escrow := v_scope in ('escrow','all');
  v_pay    := v_scope in ('payout','all');
  v_ref    := v_scope in ('refund','all');
  v_gate   := v_scope in ('gateway','all');

  -- The rails' money questions need a rail. With nothing switched on at the desk, a payment left
  -- `pending` is the mock door's answer rather than the office's, and `GATE-WAIT` has no inbound
  -- money to be compared against — so both are refused out loud instead of reported as drift.
  v_rails := v_gate and v_cur = 'TZS';
  if v_gate and v_cur = 'USD' then
    v_skip := v_skip || jsonb_build_array(
      'the rails were not asked about money: 005 takes TZS only, and this book has no USD gateway '
      || 'line to compare a rail against',
      'webhook_not_landed and webhook_retries_spent were asked of USD charges only: the money '
      || 'on both of them is read off the charge, and a TZS figure added to a USD difference is a '
      || 'translation, not a count');
  end if;
  if v_rails and not exists (select 1 from platform_auth.active_payment_gateway()) then
    v_skip := v_skip || jsonb_build_array(
      'no rail is switched on at the desk, so a charge left pending is the sandbox door''s answer '
      || 'and not the office''s: the pending charges and the gateway line were not asked about');
    v_rails := false;
  end if;

  if v_book   then v_names := v_names || array['book_sums_to_zero','posting_square','account_totals']; end if;
  if v_wallet then v_names := v_names || array['wallet_overdrawn','wallet_line_orphan','wallet_heading']; end if;
  if v_escrow then v_names := v_names || array['escrow_line_total','escrow_paper_postings']; end if;
  if v_pay    then v_names := v_names || array['payable_line_total','payout_paper_postings','batch_totals']; end if;
  if v_ref    then v_names := v_names || array['refund_paper_unpaid','refund_payout_paper']; end if;
  if v_gate   then v_names := v_names || array['webhook_unverified','webhook_not_landed',
                                               'webhook_orphan','webhook_retries_spent']; end if;
  if v_rails  then v_names := v_names || array['payment_stale','gateway_line_total']; end if;

  -- ------------------------------------------------------------
  -- the exceptions, in one set
  -- ------------------------------------------------------------
  insert into money_reconciliation_findings
    (id, run_id, tenant_id, line, check_name, subject_kind, subject_id, subject_ref,
     book_figure, paper_figure, verdict, detail)
  select gen_random_uuid(), v_run, p_tenant,
         row_number() over (order by x.check_name, x.subject_kind, x.subject_ref nulls first),
         x.check_name, x.subject_kind, x.subject_id, x.subject_ref,
         x.book_figure, x.paper_figure, x.verdict, x.detail
    from (
      -- 1. the whole book nets to nothing, or it does not.
      select 'book_sums_to_zero'::text             as check_name,
             'book'::text                          as subject_kind,
             null::uuid                            as subject_id,
             null::text                            as subject_ref,
             coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)::numeric(14,2)
                                                   as book_figure,
             coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2)
                                                   as paper_figure,
             'differs'::text                       as verdict,
             jsonb_build_object(
               'why', 'The ' || v_cur || ' book carries '
                   || platform_auth.money_figure(coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0))
                   || ' debited against '
                   || platform_auth.money_figure(coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0))
                   || ' credited over ' || count(*)::text || ' leg(s). Every movement is two sides, '
                   || 'so ' || platform_auth.money_figure(abs(
                        coalesce(sum(e.amount) filter (where e.direction = 'debit'), 0)
                      - coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)))
                   || ' is unaccounted for.',
               'currency', v_cur, 'legs', count(*)::int)      as detail
        from money_entries e
        join money_postings p on p.id = e.posting_id
       where v_book and p.tenant_id = p_tenant and p.currency = v_cur
       having coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)
           <> coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)

      union all

      -- 2. each movement in the window still says what its own legs say.
      select 'posting_square', 'posting', p.id, p.ref, p.total, coalesce(x.debits, 0),
             'differs',
             jsonb_build_object(
               'why', p.ref || ' of ' || to_char(p.posted_on, 'YYYY-MM-DD') || ' says it moved '
                   || platform_auth.money_figure(p.total) || ' and carries ' || coalesce(x.legs, 0)::text
                   || ' leg(s): ' || platform_auth.money_figure(coalesce(x.debits, 0)) || ' out, '
                   || platform_auth.money_figure(coalesce(x.credits, 0)) || ' in. '
                   || case
                        when coalesce(x.legs, 0) < 2
                          then 'A movement needs both sides, so this one is half-written.'
                        when coalesce(x.debits, 0) = 0 or coalesce(x.credits, 0) = 0
                          then 'Every leg is on one side.'
                        when x.debits <> x.credits
                          then 'The two sides are not equal.'
                        else 'The header''s figure is not its own debits.'
                      end,
               'memo', p.memo, 'currency', p.currency, 'status', p.status,
               'credits', coalesce(x.credits, 0), 'legs', coalesce(x.legs, 0),
               'source_kind', p.source_kind, 'source_ref', p.source_ref)
        from money_postings p
        left join (
          select e.posting_id,
                 count(*)::int                                                          as legs,
                 coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)::numeric(14,2) as debits,
                 coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2) as credits
            from money_entries e
           group by e.posting_id
        ) x on x.posting_id = p.id
       where v_book and p.tenant_id = p_tenant and p.currency = v_cur
         and p.posted_on between v_from and v_to
         and (coalesce(x.legs, 0) < 2 or coalesce(x.debits, 0) = 0 or coalesce(x.credits, 0) = 0
              or x.debits <> x.credits or p.total <> coalesce(x.debits, 0))

      union all

      -- 3. a line's cached figures still follow its legs. The pair printed here is the debits; the
      -- credits and the count ride in the sentence, because all three are kept by the same trigger.
      select 'account_totals', 'account', a.id, a.code, a.debit_total, coalesce(r.debits, 0),
             'differs',
             jsonb_build_object(
               'why', a.code || ' (' || a.label || ') says ' || platform_auth.money_figure(a.debit_total)
                   || ' debited and ' || platform_auth.money_figure(a.credit_total) || ' credited over '
                   || a.entry_count::text || ' leg(s); its own legs add up to '
                   || platform_auth.money_figure(coalesce(r.debits, 0)) || ' and '
                   || platform_auth.money_figure(coalesce(r.credits, 0)) || ' over '
                   || coalesce(r.n, 0)::text || '. The figures the register prints are kept by a '
                   || 'trigger, and this line has stopped agreeing with them.',
               'label', a.label, 'kind', a.kind, 'status', a.status,
               'credit_cached', a.credit_total, 'credit_legs', coalesce(r.credits, 0),
               'count_cached', a.entry_count, 'count_legs', coalesce(r.n, 0))
        from money_accounts a
        left join (
          select e.account_id,
                 coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)::numeric(14,2) as debits,
                 coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2) as credits,
                 count(*)::int as n
            from money_entries e
           group by e.account_id
        ) r on r.account_id = a.id
       where v_book and a.tenant_id = p_tenant and a.currency = v_cur
         and (a.debit_total <> coalesce(r.debits, 0) or a.credit_total <> coalesce(r.credits, 0)
              or a.entry_count <> coalesce(r.n, 0))

      union all

      -- 4. a holder's line cannot be paid below nothing. The office owes this money; it cannot owe
      -- less than zero of it.
      select 'wallet_overdrawn', 'wallet', w.id, a.code, n.net, 0,
             'differs',
             jsonb_build_object(
               'why', 'The ' || w.currency || ' line held for ' || w.holder_name || ' (' || a.code
                   || ') is ' || platform_auth.money_figure(abs(n.net))
                   || ' overdrawn: more has left it than the book has ever been told came in. '
                   || 'A payment out of a wallet is a claim this office cannot make.',
               'holder', w.holder_name, 'account', a.code, 'wallet_status', w.status)
        from money_wallets w
        join money_accounts a on a.id = w.account_id
        cross join lateral (
          select coalesce(sum(case when e.direction = 'credit' then e.amount else -e.amount end),
                         0)::numeric(14,2) as net
            from money_entries e where e.account_id = w.account_id
        ) n
       where v_wallet and w.tenant_id = p_tenant and w.currency = v_cur and n.net < 0

      union all

      -- 5. a wallet line in the book that no wallet in the register points at.
      select 'wallet_line_orphan', 'account', a.id, a.code, n.net, 0,
             'missing_paper',
             jsonb_build_object(
               'why', a.code || ' is a wallet line in the book — '
                   || platform_auth.money_figure(n.net) || ' held — and no row in the wallet register '
                   || 'names it. Money is standing in the office for somebody the office cannot name.',
               'label', a.label, 'opened_at', a.opened_at)
        from money_accounts a
        left join money_wallets w on w.account_id = a.id
        cross join lateral (
          select coalesce(sum(case when e.direction = 'credit' then e.amount else -e.amount end),
                         0)::numeric(14,2) as net
            from money_entries e where e.account_id = a.id
        ) n
       where v_wallet and a.tenant_id = p_tenant and a.currency = v_cur
         and a.code like 'WLT-%' and w.id is null

      union all

      -- 6. the heading is a heading. `WALLET-…` groups the holders' lines on the chart and carries no
      -- money of its own; a leg that landed on it means something moved twice, or moved nowhere.
      select 'wallet_heading', 'account', a.id, a.code, n.debits, n.credits,
             'differs',
             jsonb_build_object(
               'why', a.code || ' is the heading the ' || v_cur || ' wallet lines sit under, and it '
                   || 'carries ' || n.n::text || ' leg(s) of its own: '
                   || platform_auth.money_figure(n.debits) || ' debited, '
                   || platform_auth.money_figure(n.credits) || ' credited. A holder''s money lives on '
                   || 'its own WLT- line, so this is money booked twice or booked nowhere.',
               'label', a.label)
        from money_accounts a
        cross join lateral (
          select count(*)::int                                                                  as n,
                 coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0)::numeric(14,2) as debits,
                 coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0)::numeric(14,2) as credits
            from money_entries e where e.account_id = a.id
        ) n
       where v_wallet and a.tenant_id = p_tenant and a.currency = v_cur
         and a.code = 'WALLET-' || v_cur and n.n > 0

      union all

      -- 7. what waits in escrow is what the live papers say waits.
      select 'escrow_line_total', 'account', a.id, a.code, n.net, coalesce(h.held, 0),
             'differs',
             jsonb_build_object(
               'why', a.code || ' holds ' || platform_auth.money_figure(n.net) || ' and the '
                   || coalesce(h.papers, 0)::text || ' hold paper(s) in `held` or `pending_discharge` '
                   || 'add up to ' || platform_auth.money_figure(coalesce(h.held, 0))
                   || '. Money leaves escrow only on a signed plan whose figures are the whole hold, '
                   || 'so the two cannot legitimately differ.',
               'papers', coalesce(h.papers, 0), 'label', a.label)
        from money_accounts a
        cross join lateral (
          select coalesce(sum(case when e.direction = 'credit' then e.amount else -e.amount end),
                         0)::numeric(14,2) as net
            from money_entries e where e.account_id = a.id
        ) n
        cross join (
          select coalesce(sum(x.amount), 0)::numeric(14,2) as held, count(*)::int as papers
            from money_escrow_holds x
           where x.tenant_id = p_tenant and x.currency = v_cur
             and x.status in ('held','pending_discharge')
        ) h
       where v_escrow and a.tenant_id = p_tenant and a.currency = v_cur
         and a.code = 'ESCROW-' || v_cur
         and n.net <> coalesce(h.held, 0)

      union all

      -- 8. a hold's own paper and its movements agree.
      select 'escrow_paper_postings', 'escrow', h.id, h.ref,
             coalesce(op.total, 0), h.amount,
             case when h.status in ('held','pending_discharge','discharged')
                   and h.hold_posting_id is null
                  then 'missing_book'::text else 'differs'::text end,
             jsonb_build_object(
               'why', h.ref || ' (' || h.status || ', ' || platform_auth.money_figure(h.amount)
                   || ' against ' || coalesce(h.subject_ref, h.subject_kind) || ') — '
                   || concat_ws(' · ',
                        case when h.status <> 'raised' and h.hold_posting_id is null
                             then 'the paper says the money is parked and the book has no movement behind it' end,
                        case when h.status = 'raised' and h.hold_posting_id is not null
                             then 'a paper nobody has held yet already books ' || op.ref end,
                        case when h.status = 'discharged' and h.discharge_posting_id is null
                             then 'the plan was signed and no discharge movement exists' end,
                        case when op.total is not null and op.total <> h.amount
                             then 'the hold movement says ' || platform_auth.money_figure(op.total)
                                  || ' and the paper says ' || platform_auth.money_figure(h.amount) end,
                        case when dp.total is not null and dp.total <> h.amount
                             then 'the discharge movement says ' || platform_auth.money_figure(dp.total)
                                  || ' and the paper holds ' || platform_auth.money_figure(h.amount) end),
               'status', h.status, 'subject_kind', h.subject_kind, 'subject_ref', h.subject_ref,
               'hold_posting', op.ref, 'hold_posting_status', op.status,
               'discharge_posting', dp.ref, 'discharge_kind', h.discharge_kind)
        from money_escrow_holds h
        left join money_postings op on op.id = h.hold_posting_id
        left join money_postings dp on dp.id = h.discharge_posting_id
       where v_escrow and h.tenant_id = p_tenant and h.currency = v_cur
         and (   (h.status <> 'raised' and h.hold_posting_id is null)
              or (h.status =  'raised' and h.hold_posting_id is not null)
              or (h.status =  'discharged' and h.discharge_posting_id is null)
              or (op.total is not null and op.total <> h.amount)
              or (dp.total is not null and dp.total <> h.amount))

      union all

      -- 9. what the office has agreed to pay and has not paid, line by line.
      select 'payable_line_total', 'account', a.id, a.code, n.net, coalesce(s.due, 0),
             'differs',
             jsonb_build_object(
               'why', a.code || ' owes ' || platform_auth.money_figure(n.net) || ' and the '
                   || coalesce(s.papers, 0)::text || ' payout paper(s) standing on it in `released` '
                   || 'come to ' || platform_auth.money_figure(coalesce(s.due, 0))
                   || ' including their charges. A signed paper accrues once and is answered once, '
                   || 'either by the cash leaving or by its mirror.',
               'label', a.label, 'papers', coalesce(s.papers, 0), 'account_status', a.status)
        from money_accounts a
        cross join lateral (
          select coalesce(sum(case when e.direction = 'credit' then e.amount else -e.amount end),
                         0)::numeric(14,2) as net
            from money_entries e where e.account_id = a.id
        ) n
        cross join lateral (
          select coalesce(sum(p.amount + p.fee_amount), 0)::numeric(14,2) as due,
                 count(*)::int as papers
            from money_payouts p
           where p.tenant_id = p_tenant and p.payable_account_id = a.id and p.status = 'released'
        ) s
       where v_pay and a.tenant_id = p_tenant and a.currency = v_cur
         and a.code in ('PAYOUT-DUE' || v_sfx, 'REFUND-DUE' || v_sfx)
         and n.net <> coalesce(s.due, 0)

      union all

      -- 10. each payout paper and the movements it claims. This is where 134's two moments are
      -- re-counted from the outside: the accrual a signature released, the payment the rail answered
      -- with, the mirror a failure answered with, and the three accounts the paper names.
      select 'payout_paper_postings', 'payout', p.id, p.ref,
             coalesce(ac.total, 0), p.amount + p.fee_amount,
             case when p.status in ('released','paid','failed') and p.accrual_posting_id is null
                  then 'missing_book'::text else 'differs'::text end,
             jsonb_build_object(
               'why', p.ref || ' (' || p.status || ', pays ' || left(p.payee_name, 40) || ' on '
                   || p.rail_code || ') — '
                   || concat_ws(' · ',
                        case when p.status <> 'raised' and p.accrual_posting_id is null
                             then 'no accrual movement stands on the paper' end,
                        case when ac.total is not null and ac.total <> p.amount + p.fee_amount
                             then 'the accrual says ' || platform_auth.money_figure(ac.total)
                                  || ' and the paper owes '
                                  || platform_auth.money_figure(p.amount + p.fee_amount) end,
                        case when ac.total is not null and al.fund_dr = 0
                             then 'no leg of the accrual is on the funding line the paper names' end,
                        case when ac.total is not null and al.pay_cr = 0
                             then 'no leg of the accrual is on the payable line the paper names' end,
                        case when p.status = 'paid' and p.payment_posting_id is null
                             then 'the desk says the cash left and no payment movement exists' end,
                        case when py.total is not null and py.total <> p.amount + p.fee_amount
                             then 'the payment movement says ' || platform_auth.money_figure(py.total)
                                  || ' and the paper owes '
                                  || platform_auth.money_figure(p.amount + p.fee_amount) end,
                        case when p.status = 'failed' and ac.status <> 'reversed'
                             then 'the rail refused and the accrual was never answered by its mirror' end,
                        case when p.status = 'failed' and ac.status = 'reversed' and mir.id is null
                             then 'the accrual is marked reversed with no mirror movement behind it' end,
                        case when p.status in ('raised','pending_signature','declined')
                                  and p.accrual_posting_id is not null
                             then 'a paper that never spent a signature has booked ' || ac.ref end),
               'status', p.status, 'amount', p.amount, 'fee', p.fee_amount,
               'accrual', ac.ref, 'accrual_status', ac.status, 'payment', py.ref,
               'source_kind', p.source_kind, 'source_ref', p.source_ref,
               'batch', (select b.ref from money_payout_batches b where b.id = p.batch_id))
        from money_payouts p
        left join money_postings ac on ac.id = p.accrual_posting_id
        left join money_postings py on py.id = p.payment_posting_id
        left join money_postings mir on mir.source_kind = 'reversal'
                                     and mir.source_id = p.accrual_posting_id
        left join lateral (
          select count(*) filter (where e.direction = 'debit'
                                       and e.account_id = p.fund_account_id)::int    as fund_dr,
                 count(*) filter (where e.direction = 'credit'
                                       and e.account_id = p.payable_account_id)::int as pay_cr
            from money_entries e where e.posting_id = p.accrual_posting_id
        ) al on true
       where v_pay and p.tenant_id = p_tenant and p.currency = v_cur
         and (   (p.status <> 'raised' and p.accrual_posting_id is null)
              or (p.status in ('raised','pending_signature','declined')
                  and p.accrual_posting_id is not null)
              or (ac.total is not null and ac.total <> p.amount + p.fee_amount)
              or (ac.total is not null and (al.fund_dr = 0 or al.pay_cr = 0))
              or (p.status = 'paid' and p.payment_posting_id is null)
              or (py.total is not null and py.total <> p.amount + p.fee_amount)
              or (p.status = 'failed' and ac.id is not null and ac.status <> 'reversed')
              or (p.status = 'failed' and ac.status = 'reversed' and mir.id is null))

      union all

      -- 11. the total a second seat signed is still its own lines' total.
      select 'batch_totals', 'payout_batch', b.id, b.ref, b.total_amount, coalesce(s.total, 0),
             'differs',
             jsonb_build_object(
               'why', b.ref || ' was signed at ' || platform_auth.money_figure(b.total_amount)
                   || ' over ' || b.lines::text || ' line(s) and its lines come to '
                   || platform_auth.money_figure(coalesce(s.total, 0)) || ' over '
                   || coalesce(s.n, 0)::text || '. A batch''s total is the figure the second seat '
                   || 'read, so a line that has moved under it makes the signature a signature of '
                   || 'other words.',
               'status', b.status, 'label', b.label, 'lines_now', coalesce(s.n, 0))
        from money_payout_batches b
        left join lateral (
          select coalesce(sum(p.amount + p.fee_amount), 0)::numeric(14,2) as total,
                 count(*)::int as n
            from money_payouts p where p.batch_id = b.id
        ) s on true
       where v_pay and b.tenant_id = p_tenant and b.currency = v_cur
         and b.status in ('pending_signature','released','closed')
         and (b.total_amount <> coalesce(s.total, 0) or b.lines <> coalesce(s.n, 0))

      union all

      -- 12. the refunds the office signed and has never accrued. 126 says a caller is owed; this is
      -- the queue that owes it, read against 134's papers rather than against a colour on a screen.
      select 'refund_paper_unpaid', 'refund_paper', f.id, f.ref, 0, f.amount,
             'missing_book',
             jsonb_build_object(
               'why', f.ref || ' was released for ' || platform_auth.money_figure(f.amount) || ' '
                   || f.currency || ' to ' || left(f.company_name, 40) || ' and no payout in the '
                   || 'office''s book stands on it. The office has signed a promise the book has '
                   || 'never been told about.',
               'company', f.company_name, 'pay_back', f.pay_back, 'released_at', f.released_at,
               'ticket', f.ticket_ref, 'currency', f.currency)
        from service_refund_requests f
       where v_ref and f.currency = v_cur and f.status = 'released'
         and not exists (select 1 from money_payouts p
                          where p.source_kind = 'refund' and p.source_id = f.id
                            and p.status in ('released','paid'))

      union all

      -- 13. a refund payout whose paper is gone, ungranted, or says another figure. The trigger that
      -- refuses this at write time cannot help a paper that was voided afterwards.
      select 'refund_payout_paper', 'payout', p.id, p.ref,
             p.amount + p.fee_amount, coalesce(f.amount, 0),
             case when f.id is null then 'missing_paper'::text else 'differs'::text end,
             jsonb_build_object(
               'why', p.ref || ' is raised as a refund and '
                   || concat_ws(' ',
                        case when f.id is null then 'the paper it names is gone.'
                             when f.status <> 'released'
                             then 'the paper is ' || f.status || ', which owes nobody anything.'
                             when p.amount <> f.amount
                             then 'the paper was signed for ' || platform_auth.money_figure(f.amount)
                                  || ' and this payout is ' || platform_auth.money_figure(p.amount) || '.'
                             when p.currency <> f.currency
                             then 'the paper is in ' || f.currency || ' and this payout in '
                                  || p.currency || '.'
                             else 'the two disagree somewhere the desk has to read.' end),
               'paper', f.ref, 'paper_status', f.status, 'paper_amount', f.amount,
               'company', f.company_name, 'payout_status', p.status)
        from money_payouts p
        left join service_refund_requests f on f.id = p.source_id
       where v_ref and p.tenant_id = p_tenant and p.currency = v_cur and p.source_kind = 'refund'
         and (f.id is null or f.status <> 'released' or p.amount <> f.amount
              or p.currency <> f.currency)

      union all

      -- 14. deliveries the platform could not verify. Each is a fact the security desk wants, in the
      -- days asked about; the newest twenty-five per provider are listed and the rest are counted.
      select 'webhook_unverified', 'webhook', w.id,
             nullif(left(trim(coalesce(w.payload ->> 'reference', '')), 60), ''), 0, 0,
             'refused',
             jsonb_build_object(
               'why', 'A delivery from ' || w.provider || ' on '
                   || to_char(w.created_at, 'YYYY-MM-DD HH24:MI') || ' was signed with a key that is '
                   || 'not this rail''s, so nothing was completed from it. It is ' || w.event_type
                   || ' and it is kept here because a pile of them is somebody knocking.',
               'provider', w.provider, 'event', w.event_type, 'nonce', w.replay_nonce,
               'at', w.created_at)
        from (
          select x.id, x.provider, x.event_type, x.payload, x.replay_nonce, x.created_at,
                 row_number() over (partition by x.provider order by x.created_at desc) as rn
            from payment_webhooks x
           where not x.signature_valid
             and x.created_at::date between v_from and v_to
        ) w
       where v_gate and w.rn <= 25

      union all

      -- 14b. the same question when it has more answers than a page.
      select 'webhook_unverified', 'many', null, left(t.provider, 60), 0, 0,
             'refused',
             jsonb_build_object(
               'why', t.total::text || ' unverified deliveries from ' || t.provider || ' in these '
                   || 'days. The newest 25 are listed and these ' || (t.total - 25)::text
                   || ' more are not. Nobody paid them any attention: check the key on the rail.',
               'provider', t.provider, 'exceptions', t.total)
        from (
          select x.provider, count(*)::int as total
            from payment_webhooks x
           where not x.signature_valid
             and x.created_at::date between v_from and v_to
           group by x.provider
          having count(*) > 25
        ) t
       where v_gate

      union all

      -- 15. a delivery the platform verified whose answer is not on the charge it names.
      -- `payment_webhooks` cannot be updated by anybody, so this is the only way the stuck pile becomes
      -- visible — which is also why 136 had to qualify the sentence. 135 raised this line for every
      -- verified delivery with `processed_at IS NULL`, and a delivery keeps that shape forever, because
      -- nothing may write the row: so a seat that re-drove one through 135's own retry door and landed
      -- the licence was told, in a report a second seat signs, that the office had never acted on it.
      -- The only honest test of "acted on" is the charge. A charge still `pending` has never been
      -- answered for; a charge closed with another word is the rail and the register disagreeing, which
      -- is the worse finding and gets its own sentence rather than the false one.
      -- The join is inner on purpose. A delivery that names no charge is 16's finding, and raising the
      -- same orphan twice would make this run's exception count a number the desk cannot act on — and
      -- the sentence below could only say "no charge carries that reference", which 16 already says
      -- better.
      select 'webhook_not_landed', 'webhook', w.id,
             left(trim(w.payload ->> 'reference'), 60),
             0, pay.amount, 'missing_book',
             jsonb_build_object(
               'why', 'A verified delivery reached the platform on '
                   || to_char(w.created_at, 'YYYY-MM-DD HH24:MI') || ' and its answer is not on the '
                   || 'charge it names' || case when coalesce(w.processing_error, '') <> ''
                                                then ': ' || left(w.processing_error, 240)
                                                else ' and no reason was recorded — the write of the '
                                                  || 'outcome itself failed' end
                   || '. ' || pay.intent_reference || ' is ' || pay.status || ' for '
                   || platform_auth.money_figure(pay.amount) || ' ' || pay.currency
                   || case when pay.status = 'pending'
                           then ', so the money the rail says arrived has never settled into the book.'
                           else ', while the delivery asked for '
                                || coalesce(nullif(q.wanted, ''), 'nothing this door can read')
                                || '. The rail and the office''s own register disagree about this '
                                || 'charge, and one of them is wrong.' end,
               'provider', w.provider, 'event', w.event_type,
               'outcome_wanted', q.wanted, 'error', w.processing_error,
               'payment_status', pay.status, 'attempts',
                 (select count(*)::int from gateway_webhook_attempts a where a.webhook_id = w.id))
        from payment_webhooks w
        join payments pay
          on pay.intent_reference = nullif(trim(coalesce(w.payload ->> 'reference', '')), '')
        -- The word the rail asked for, read the same way 135's retry door reads it: the delivery's own event
        -- when the rail named a final state, else the outcome the intake route parsed. 005's intake
        -- writes `event_type = event ?? outcome`, so an unnamed rail still lands a final word here.
        cross join lateral (
          select coalesce(case when w.event_type in ('approved','failed','timed_out','cancelled')
                               then w.event_type
                               else nullif(trim(coalesce(w.payload ->> 'outcome', '')), '') end,
                          '') as wanted
        ) q
       where v_gate and w.signature_valid and w.processed_at is null
         and q.wanted <> pay.status
         and pay.currency = v_cur
         and w.created_at::date between v_from and v_to

      union all

      -- 16. a delivery whose reference belongs to no charge, or that carries no reference at all.
      select 'webhook_orphan', 'webhook', w.id,
             coalesce(nullif(left(trim(coalesce(w.payload ->> 'reference', '')), 60), ''),
                      left(w.provider || ' no reference', 60)),
             0, 0, 'missing_paper',
             jsonb_build_object(
               'why', 'A verified delivery on ' || to_char(w.created_at, 'YYYY-MM-DD HH24:MI')
                   || ' ' || case when coalesce(w.payload ->> 'reference', '') = ''
                                  then 'carries no reference at all, so there is nothing here for a '
                                       || 'seat to re-drive.'
                                  else 'names ' || left(w.payload ->> 'reference', 40)
                                       || ', which is not a charge this platform has ever raised. '
                                       || 'A rail does not invent a reference it never pushed.' end,
               'provider', w.provider, 'event', w.event_type, 'payload_ref',
                 left(coalesce(w.payload ->> 'reference', ''), 60))
        from payment_webhooks w
       where v_gate and w.signature_valid
         and w.created_at::date between v_from and v_to
         and (coalesce(w.payload ->> 'reference', '') = ''
              or not exists (select 1 from payments p
                              where p.intent_reference = w.payload ->> 'reference'))

      union all

      -- 17. a delivery re-driven five times and still not answered: the retry door will not touch it,
      -- and a person has to talk to the rail. 136 put the same guard on it as on 15, for the same
      -- reason: five presses that ended with the charge approved need nothing from anybody, and a line
      -- about them would carry that money into the run's net difference as though it were still missing.
      -- The charge may be absent — an orphan that has spent its ceiling is exactly the delivery a seat
      -- must take to the rail — so this one keeps its left join and names the null case.
      select 'webhook_retries_spent', 'webhook', w.id,
             nullif(left(trim(coalesce(w.payload ->> 'reference', '')), 60), ''), 0,
             coalesce(pay.amount, 0), 'stale',
             jsonb_build_object(
               'why', 'This delivery has been re-driven ' || t.n::text || ' times, last on '
                   || to_char(t.last_at, 'YYYY-MM-DD HH24:MI') || ', and the charge '
                   || coalesce(pay.intent_reference, 'it names') || ' is still '
                   || coalesce(pay.status, 'not ours to find') || '. Five attempts is the ceiling, so '
                   || 'the next answer has to come from the rail, not from the desk.',
               'attempts', t.n, 'last_attempt_at', t.last_at, 'payment_status', pay.status,
               'outcome_wanted', q.wanted, 'provider', w.provider)
        from payment_webhooks w
        join (select a.webhook_id, count(*)::int as n, max(a.created_at) as last_at
                from gateway_webhook_attempts a
               group by a.webhook_id) t on t.webhook_id = w.id
        left join payments pay
          on pay.intent_reference = nullif(trim(coalesce(w.payload ->> 'reference', '')), '')
        -- The word the rail asked for, read the same way 135's retry door reads it: the delivery's own event
        -- when the rail named a final state, else the outcome the intake route parsed. 005's intake
        -- writes `event_type = event ?? outcome`, so an unnamed rail still lands a final word here.
        cross join lateral (
          select coalesce(case when w.event_type in ('approved','failed','timed_out','cancelled')
                               then w.event_type
                               else nullif(trim(coalesce(w.payload ->> 'outcome', '')), '') end,
                          '') as wanted
        ) q
       where v_gate and t.n >= 5 and w.processed_at is null
         and (pay.status is null or q.wanted <> pay.status)
         and coalesce(pay.currency, v_cur) = v_cur
         and w.created_at::date between v_from and v_to

      union all

      -- 18. a charge the office is still holding open past its own countdown. 005's ten-minute window
      -- is expired lazily by whoever asks, so a charge nobody polls stays `pending` forever.
      select 'payment_stale', 'payment', p.id, p.intent_reference, 0, p.amount, 'stale',
             jsonb_build_object(
               'why', p.intent_reference || ' has stood pending on ' || p.provider || ' for '
                   || floor(extract(epoch from (now() - p.requested_at)) / 60)::int::text
                   || ' minutes for ' || platform_auth.money_figure(p.amount) || ' ' || p.currency
                   || ', past the ten minutes the customer was promised. Nothing in the book has '
                   || 'ever been told about this money.',
               'provider', p.provider, 'requested_at', p.requested_at, 'invoice',
                 (select i.number from invoices i where i.id = p.invoice_id),
               'tenant', (select t.name from tenants t where t.id = p.tenant_id))
        from payments p
       where v_rails and p.currency = v_cur and p.status = 'pending'
         and p.requested_at < now() - interval '10 minutes'
         and p.requested_at::date between v_from and v_to

      union all

      -- 19. the gateway line against the money the rails confirmed. This is the one question 135 asks
      -- that the office cannot answer by fixing a row: 005's licence money has never settled into the
      -- book, so the line can only ever go down. It is reported as the gap it is.
      select 'gateway_line_total', 'gateway_line', a.id, a.code, n.net, coalesce(t.confirmed, 0),
             'differs',
             jsonb_build_object(
               'why', a.code || ' carries ' || platform_auth.money_figure(n.net) || ' taken out of '
                   || 'the rails'' money and the rails confirmed '
                   || platform_auth.money_figure(coalesce(t.confirmed, 0)) || ' in these days. '
                   || 'The book has never been told about a licence payment: 005''s charges settle '
                   || 'into the office''s ledger in a later stage, so this line has receipts with '
                   || 'nothing behind them.',
               'confirmed_papers', coalesce(t.papers, 0), 'label', a.label,
               'live_rail', (select g.provider_key from payment_gateways g where g.enabled limit 1))
        from money_accounts a
        cross join lateral (
          select coalesce(sum(case when e.direction = 'debit' then e.amount else -e.amount end),
                         0)::numeric(14,2) as net
            from money_entries e where e.account_id = a.id
        ) n
        cross join (
          select coalesce(sum(p.amount), 0)::numeric(14,2) as confirmed, count(*)::int as papers
            from payments p
           where p.status in ('approved','refunded') and p.currency = 'TZS'
             and p.requested_at::date between v_from and v_to
        ) t
       where v_rails and a.tenant_id = p_tenant and a.currency = v_cur and a.code = 'GATE-WAIT'
         and n.net <> coalesce(t.confirmed, 0)
    ) x;

  get diagnostics v_find = row_count;

  select coalesce(sum(f.difference), 0)::numeric(14,2) into v_net
    from money_reconciliation_findings f where f.run_id = v_run;

  ------------------------------------------------------------
  -- what the count looked at, so that a clean report is evidence and not a claim
  ------------------------------------------------------------
  select jsonb_strip_nulls(jsonb_build_object(
    'questions', (select jsonb_agg(n.name order by n.name) from unnest(v_names) as n(name)),
    'basis', 'the window bounds the book''s days and the rails'' arrivals; a register check is '
      || 'made over the whole register, because both sides of every equation here are whole facts',
    'postings', case when v_book then (select count(*)::int from money_postings q
                       where q.tenant_id = p_tenant and q.currency = v_cur
                         and q.posted_on between v_from and v_to) end,
    'legs', case when v_book then (select count(*)::int from money_entries e
                       join money_postings q on q.id = e.posting_id
                      where q.tenant_id = p_tenant and q.currency = v_cur
                        and q.posted_on between v_from and v_to) end,
    'accounts', case when v_book then (select count(*)::int from money_accounts q
                       where q.tenant_id = p_tenant and q.currency = v_cur) end,
    'wallets', case when v_wallet then (select count(*)::int from money_wallets q
                       where q.tenant_id = p_tenant and q.currency = v_cur) end,
    'wallet_lines', case when v_wallet then (select count(*)::int from money_accounts q
                       where q.tenant_id = p_tenant and q.currency = v_cur
                         and q.code like 'WLT-%') end,
    'holds', case when v_escrow then (select count(*)::int from money_escrow_holds q
                       where q.tenant_id = p_tenant and q.currency = v_cur) end,
    'payouts', case when v_pay then (select count(*)::int from money_payouts q
                       where q.tenant_id = p_tenant and q.currency = v_cur) end,
    'batches', case when v_pay then (select count(*)::int from money_payout_batches q
                       where q.tenant_id = p_tenant and q.currency = v_cur) end,
    'refund_papers', case when v_ref then (select count(*)::int from service_refund_requests q
                       where q.currency = v_cur) end,
    'deliveries', case when v_gate then (select count(*)::int from payment_webhooks q
                       where q.created_at::date between v_from and v_to) end,
    'attempts', case when v_gate then (select count(*)::int from gateway_webhook_attempts q
                       where q.created_at::date between v_from and v_to) end,
    'payments', case when v_rails then (select count(*)::int from payments q
                       where q.currency = v_cur
                         and q.requested_at::date between v_from and v_to) end,
    'skipped', case when jsonb_array_length(v_skip) > 0 then v_skip end
  )) into v_exam;

  insert into money_reconciliation_runs
    (id, tenant_id, ref, scope, currency, from_day, to_day, examined, checks, findings,
     net_difference, raised_by)
  values (v_run, p_tenant,
          'REC-' || to_char(now(), 'YYYY') || '-'
              || lpad(nextval('recon_run_number_seq')::text, 5, '0'),
          v_scope, v_cur, v_from, v_to, v_exam,
          coalesce(array_length(v_names, 1), 0), v_find, v_net, p_actor);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'money_reconciliation_runs', v_run, 'recon.raised', null,
    jsonb_build_object('scope', v_scope, 'currency', v_cur, 'from_day', v_from, 'to_day', v_to,
      'questions', coalesce(array_length(v_names, 1), 0), 'findings', v_find,
      'net_difference', v_net,
      'worst', coalesce((select jsonb_agg(f.check_name order by abs(f.difference) desc nulls last)
                          from (select f2.check_name, f2.difference
                                  from money_reconciliation_findings f2
                                 where f2.run_id = v_run
                                 order by abs(f2.difference) desc nulls last limit 5) f), '[]'::jsonb)));

  return jsonb_build_object('ok', true,
    'run', platform_auth.money_recon_detail(p_tenant, v_run));
end $$;
-- ============================================================
-- 2. who may knock
-- ============================================================

-- `create or replace function` puts EXECUTE back on the public list, so the grant and the sweep
-- follow the body the way 114, 126, 129, 133, 134, 135, 136 and 137 all do.
grant execute on function
  platform_auth.run_money_reconciliation(uuid, text, text, date, date, uuid, text, text, text)
to app_runtime;
revoke all on function
  platform_auth.run_money_reconciliation(uuid, text, text, date, date, uuid, text, text, text)
from public, anon, authenticated, service_role;

-- ============================================================
-- 3. say what this left the office in
-- ============================================================

do $$ declare
  v_shape  record;
  v_leaks  int;
  v_body   text;
  v_binds  int;
  v_reads  int;
  v_said   int;
  v_fig    int;
begin
  -- One door, not two, and still the nine arguments the route binds. A differently typed signature
  -- here would leave 136's door standing and add an overload the desk never calls, which is how a
  -- fixed count keeps shipping the old sum.
  select p.pronargs, pg_get_function_arguments(p.oid) as args, p.prosecdef,
         p.proconfig::text as config, l.lanname as lan
    into v_shape
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
   where n.nspname = 'platform_auth' and p.proname = 'run_money_reconciliation';
  if not found then
    raise exception '138: platform_auth.run_money_reconciliation does not exist';
  end if;
  select count(*)::int into v_leaks from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth' and p.proname = 'run_money_reconciliation';
  if v_leaks <> 1 or v_shape.pronargs <> 9
     or v_shape.args <> 'p_tenant uuid, p_scope text, p_currency text, p_from date, p_to date, '
                        || 'p_actor uuid, p_role text, p_ip text, p_ua text' then
    raise exception '138: the count door is % overload(s) of % argument(s) taking `%` — this file '
      'replaces 136''s door and must match it exactly',
      v_leaks, v_shape.pronargs, v_shape.args;
  end if;
  if v_shape.prosecdef is not true or v_shape.config not like '%search_path=public%'
     or v_shape.lan <> 'plpgsql' then
    raise exception '138: the door left the shape it was handed — definer %, config %, language %',
      v_shape.prosecdef, v_shape.config, v_shape.lan;
  end if;

  select prosrc into v_body from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth' and p.proname = 'run_money_reconciliation';

  -- The two binds, one per block, in the shapes this file chose. The inner-join one is plain: a
  -- charge of another money is not this run's charge. The left-join one keeps the null case, and a
  -- body that wrote it the other way would report a missing charge instead of a spent ceiling.
  if v_body not like '%and pay.currency = v_cur%' then
    raise exception '138: `webhook_not_landed` still reads its figure off a charge it never asked '
      'which money it is in';
  end if;
  if v_body not like '%and coalesce(pay.currency, v_cur) = v_cur%' then
    raise exception '138: `webhook_retries_spent` has no currency bind, or has one written in the '
      'join instead of the guard — and the join form turns a TZS charge into a missing charge';
  end if;
  -- The two binds, one per block, in the shapes this file chose, and one each — a third would mean
  -- this file bound the money somewhere it was not written to. The inner-join one is plain: a charge
  -- of another money is not this run's charge. The left-join one keeps the null case, and a body that
  -- wrote it the other way would report a missing charge instead of a spent ceiling.
  v_binds := 0;
  v_binds := v_binds + (length(v_body) - length(replace(v_body,
    'and pay.currency = v_cur', ''))) / length('and pay.currency = v_cur');
  v_binds := v_binds + (length(v_body) - length(replace(v_body,
    'and coalesce(pay.currency, v_cur) = v_cur', ''))) / length('and coalesce(pay.currency, v_cur) = v_cur');
  if v_binds <> 2 then
    raise exception '138: expected one currency bind in each delivery question and none elsewhere, '
      'found the pair written % time(s)', v_binds;
  end if;

  -- A charge's money is now named three times in the door: the two binds above and the sentence
  -- 135 already wrote, which prints the currency inline beside the figure. A fourth would be a bind
  -- this file slipped in unawares; one fewer means a block holds a figure it never asked about.
  v_reads := (length(v_body) - length(replace(v_body, 'pay.currency', ''))) / length('pay.currency');
  if v_reads <> 3 then
    raise exception '138: expected the charge''s money named twice as a bind and once in the '
      'sentence, found it % time(s)', v_reads;
  end if;

  -- Three places a charge's figure is printed: the two paper figures and the one sentence that
  -- quotes it. Every one of them stands in a block the bind above covers, which is the whole promise
  -- of this file — so the count is asked how many figures it has, not how many the desk noticed.
  v_fig := (length(v_body) - length(replace(v_body, 'pay.amount', ''))) / length('pay.amount');
  if v_fig <> 3 then
    raise exception '138: expected three reads of a charge''s figure — two paper figures and the '
      'sentence — found %', v_fig;
  end if;

  -- The sentence, written where the USD branch writes its other one. A run that excludes a question
  -- has to say it excluded a question; that is the rule 135's header states and the desk renders.
  v_said := (length(v_body) - length(replace(v_body,
    'were asked of USD charges only', ''))) / length('were asked of USD charges only');
  if v_said <> 1 then
    raise exception '138: the USD skip sentence is written % time(s) — a count that holds a figure '
      'back must also say that it did', v_said;
  end if;
  if v_body not like '%the rails were not asked about money: 005 takes TZS only%' then
    raise exception '138: this file dropped the sentence 135 wrote about the rails'' own money';
  end if;

  -- 136's guard is still the guard. Without these two lines the count is back to calling a landed
  -- delivery one the office ignored, which is the lie this stage was asked to stop.
  if v_body not like '%and q.wanted <> pay.status%'
     or v_body not like '%and (pay.status is null or q.wanted <> pay.status)%' then
    raise exception '138: the charge''s own state no longer decides whether a delivery is an '
      'exception — this file has undone 136';
  end if;
  if v_body like '%the office never acted on it%' then
    raise exception '138: the count has 135''s false sentence back in it';
  end if;
  if v_body not like '%webhook_not_landed%' or v_body not like '%webhook_retries_spent%'
     or v_body not like '%webhook_unverified%' or v_body not like '%webhook_orphan%' then
    raise exception '138: the count left one of its four delivery questions behind';
  end if;
  if v_body not like '%coalesce(pay.intent_reference, ''it names'')%' then
    raise exception '138: the spent-ceiling sentence no longer names a missing charge as missing — '
      'that null case is the reason the bind sits in the guard and not in the join';
  end if;

  -- A door a client role can reach by hand is a door whose figures nobody signed for.
  if has_function_privilege('public',
       'platform_auth.run_money_reconciliation(uuid,text,text,date,date,uuid,text,text,text)',
       'execute')
     or has_function_privilege('anon',
       'platform_auth.run_money_reconciliation(uuid,text,text,date,date,uuid,text,text,text)',
       'execute')
     or has_function_privilege('authenticated',
       'platform_auth.run_money_reconciliation(uuid,text,text,date,date,uuid,text,text,text)',
       'execute')
     or has_function_privilege('service_role',
       'platform_auth.run_money_reconciliation(uuid,text,text,date,date,uuid,text,text,text)',
       'execute') then
    raise exception '138: a client role can execute the count door directly';
  end if;
  if not has_function_privilege('app_runtime',
       'platform_auth.run_money_reconciliation(uuid,text,text,date,date,uuid,text,text,text)',
       'execute') then
    raise exception '138: the office''s own role lost its grant to raise a count';
  end if;

  raise notice '138: the count asks a charge which money it is in before it adds the figure — % '
    'bind(s) over % figure read(s), the money named % time(s) in the door, the USD run says so in its '
    'own skip list, and 136''s guard on both blocks is intact', v_binds, v_fig, v_reads;
end $$;

commit;
