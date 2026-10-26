-- 137: An attempt is numbered by the desk that made it, and the delivery read asks
--              the board's own two questions.
--
-- 135 wrote "whose press is this" twice and got two answers. The retry door numbers a press over
-- `webhook_id AND tenant_id` — an attempt belongs to the book that made it — while the ledger's own
-- constraint is UNIQUE (webhook_id, attempt), one number line per delivery shared by every book. The
-- reconciliation gate that plants a second platform desk is what felt the difference, and it felt it
-- in the worst place: the second desk's board said the button was open, the door agreed, ran 009's
-- completion, landed the licence, and then could not write the row that says it did — attempt 1
-- already belonged to the first desk — so the whole statement came undone, money moved nowhere, and
-- the office kept no audit of a press it had actually made. The gate wrote the fix for itself in its
-- own note: "one word in one constraint, and it belongs to the migration that next touches this
-- table". This is that migration.
--
-- The same file read the delivery pile two ways. `gateway_webhook_detail` lists the attempts with
-- `tenant_id = p_tenant` bound, but behind `can_retry` and `why_not` it counted every desk's
-- presses on the delivery; so one JSON answer could carry an empty attempt list beside the sentence
-- "Five attempts is the ceiling and this delivery has spent it". And where the board and the door
-- both test the reference's TEXT (`coalesce(payload ->> 'reference', '') <> ''`), the read tested the
-- key's EXISTENCE, so a rail that posts `reference: ""` was handed an enabled button by the read and
-- refused by the door. A desk renders the read; a seat presses the door. Both questions now have one
-- answer, and it is the answer 135's own comment above that block already promised — "stated once so
-- the desk and the door cannot drift apart about it".
--
-- The ceiling is per desk on purpose. 135's header says the retry cannot bill, activate or extend
-- anything twice because 009's completion is idempotent, so five is about a seat's time and a rail's
-- support ticket, not about money; a second office asking the same delivery gets its own five and its
-- own ledger. The new key is weaker than the one it replaces, so no press ever recorded becomes
-- unlawful to store.
--
-- **What this file does not change.** The count door and 136's replacement of it, the delivery board,
-- the retry door and the sentences it answers with, the four guards and the ledger's no-edit rule, the
-- scrub, the duties, the grants on every other door, and every row already in the ledger. It does not
-- touch the board's `readable` flag either: that word answers "can a seat read this body at all" —
-- the event parsed, and a reference came out of it — which is a different question from "may this be
-- re-driven", is never rendered as a button, and the web desk already draws only its parse half.
begin;

-- ============================================================
-- 1. an attempt belongs to the book that made it
-- ============================================================

-- Dropped before the replacement is added because Postgres has no `add constraint if not exists`,
-- and the pair is wrapped so a database that never had 135's shape (a fresh install, where the
-- table comes up with the new key already on it) still runs this file.
do $$ declare
begin
  if exists (select 1 from pg_constraint
              where conname = 'gateway_webhook_attempt_numbered_per_delivery'
                and conrelid = 'gateway_webhook_attempts'::regclass) then
    alter table gateway_webhook_attempts
      drop constraint gateway_webhook_attempt_numbered_per_delivery;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'gateway_webhook_attempt_numbered_per_desk'
                    and conrelid = 'gateway_webhook_attempts'::regclass) then
    alter table gateway_webhook_attempts
      add constraint gateway_webhook_attempt_numbered_per_desk
        unique (webhook_id, tenant_id, attempt);
  end if;
end $$;

comment on constraint gateway_webhook_attempt_numbered_per_desk on gateway_webhook_attempts is
  'An attempt is numbered 1 to 5 within one office''s ledger for one delivery, so the key names the book that made the press — the same line the board, the one-delivery read and the door count from. 135 wrote it without tenant_id while its own door counted with it, and a second platform desk could not record a press it had already completed.';

-- ============================================================
-- 2. the one-delivery read, asked of the desk that asks it
-- ============================================================

-- 135's body is lifted whole; four lines differ. Two of them are the attempt counts behind
-- `can_retry` and `why_not`, which now carry `and a.tenant_id = p_tenant` exactly as the attempt
-- list in the same select already does. Two are the reference test, which now reads the reference's
-- text as the board and the door do. Same signature, same security definer, same search path.
/**
 * One delivery, whole: what the rail sent, what the charge says now, every attempt the office has
 * made against it, and the rail's own row from 114's register beside it.
 *
 * The payload is the scrubbed copy and the charge is read without its PII columns — `payer_phone_
 * encrypted` is never named by this select, which is the difference between a gateway desk a support
 * seat can use and a phone-number dump that happens to have a nice header.
 */
create or replace function platform_auth.gateway_webhook_detail(p_tenant uuid, p_webhook uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_w     payment_webhooks%rowtype;
  v_att   jsonb;
  v_pay   jsonb;
  v_rail  jsonb;
  v_can   boolean;
  v_why   text;
begin
  if not platform_auth.money_move_is_the_office(p_tenant) then
    return jsonb_build_object('error', 'The rails answer to the platform office, and this is not that desk.');
  end if;
  select * into v_w from payment_webhooks where id = p_webhook;
  if not found then
    return jsonb_build_object('error', 'No delivery reached the platform with that id.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'attempt', a.attempt, 'outcome', a.outcome, 'message', a.message,
           'intent_reference', a.intent_reference, 'payment_status', a.payment_status,
           'answer', a.answer, 'acted_by', (select u.full_name from users u where u.id = a.acted_by),
           'acted_role', a.acted_role, 'at', a.created_at
         ) order by a.attempt), '[]'::jsonb) into v_att
    from gateway_webhook_attempts a
   where a.webhook_id = v_w.id and a.tenant_id = p_tenant;

  select json_build_object(
           'id', p.id, 'reference', p.intent_reference, 'status', p.status,
           'amount', p.amount, 'currency', p.currency, 'rail', p.provider,
           'provider_txn_id', p.provider_txn_id, 'requested_at', p.requested_at,
           'completed_at', p.completed_at, 'invoice', i.number,
           'tenant_id', p.tenant_id, 'tenant', t.name, 'tenant_type', t.type
         ) into v_pay
    from payments p
    left join invoices i on i.id = p.invoice_id
    left join tenants t on t.id = p.tenant_id
   where p.intent_reference = nullif(trim(coalesce(v_w.payload ->> 'reference', '')), '');

  select jsonb_build_object('provider_key', g.provider_key, 'label', g.label, 'adapter', g.adapter,
           'environment', g.environment, 'live', g.enabled, 'credential_hint', g.credential_hint,
           'last_check', g.last_check, 'updated_at', g.updated_at,
           'updated_by', (select u.full_name from users u where u.id = g.updated_by))
    into v_rail
    from payment_gateways g where g.provider_key = v_w.provider;

  -- The answer to "can a seat press this button", stated once so the desk and the door cannot drift
  -- apart about it: the retry door re-checks each of these and refuses with the same sentence.
  v_can := v_w.signature_valid and v_w.processed_at is null
           and coalesce(v_w.payload ->> 'reference', '') <> ''
           and (select count(*)::int from gateway_webhook_attempts a
                  where a.webhook_id = v_w.id and a.tenant_id = p_tenant) < 5;
  if not v_w.signature_valid then
    v_why := 'The platform could not verify this delivery, so it is not an instruction. Nothing is '
          || 're-driven against a signature that did not match.';
  elsif v_w.processed_at is not null then
    v_why := 'The office already acted on this delivery — the ledger beside it is the whole story.';
  elsif coalesce(v_w.payload ->> 'reference', '') = '' then
    v_why := 'This payload names no charge, so there is nothing here to re-drive. The reference a '
          || 'rail pushes is what the completion is asked for.';
  elsif (select count(*)::int from gateway_webhook_attempts a
            where a.webhook_id = v_w.id and a.tenant_id = p_tenant) >= 5 then
    v_why := 'Five attempts is the ceiling and this delivery has spent it. The next answer has to '
          || 'come from the rail, not from this desk.';
  else
    v_why := null;
  end if;

  return jsonb_build_object(
    'id', v_w.id, 'provider', v_w.provider, 'event', v_w.event_type,
    'verified', v_w.signature_valid, 'nonce', v_w.replay_nonce,
    'arrived_at', v_w.created_at, 'processed_at', v_w.processed_at,
    'processing_error', v_w.processing_error,
    'payload', platform_auth.scrub_gateway_payload(v_w.payload),
    'payload_keys', coalesce((select jsonb_agg(k order by k)
                                from jsonb_object_keys(v_w.payload) k), '[]'::jsonb),
    'charge', v_pay, 'rail', v_rail, 'attempts', coalesce(v_att, '[]'::jsonb),
    'can_retry', v_can, 'why_not', v_why);
end $$;

-- ============================================================
-- 3. who may knock
-- ============================================================

-- `create or replace function` hands EXECUTE back to PUBLIC, so the grant and the sweep follow the
-- body the way 114, 126, 129, 133, 134, 135 and 136 all do.
grant execute on function platform_auth.gateway_webhook_detail(uuid, uuid) to app_runtime;
revoke all on function platform_auth.gateway_webhook_detail(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ============================================================
-- 4. say what this left the office in
-- ============================================================

do $$ declare
  v_shape    record;
  v_body     text;
  v_binds    int;
  v_refs     int;
  v_key      record;
  v_old      int;
begin
  -- One constraint, and it names the desk. A ledger keyed per delivery would let this file run and
  -- still leave the door unable to write what it did.
  select conname, pg_get_constraintdef(oid) as def into v_key from pg_constraint
   where conrelid = 'gateway_webhook_attempts'::regclass and contype = 'u';
  if v_key.conname is distinct from 'gateway_webhook_attempt_numbered_per_desk' then
    raise exception '137: the attempt ledger is keyed by %, not by the desk that made the attempt',
      coalesce(v_key.conname, '(nothing)');
  end if;
  if v_key.def not like '%webhook_id, tenant_id, attempt%' then
    raise exception '137: the attempt key does not reach tenant_id — it is %', v_key.def;
  end if;
  select count(*)::int into v_old from pg_constraint
   where conrelid = 'gateway_webhook_attempts'::regclass
     and conname = 'gateway_webhook_attempt_numbered_per_delivery';
  if v_old <> 0 then
    raise exception '137: 135''s per-delivery attempt key is still on the ledger beside the new one';
  end if;

  -- The read still answers in the same shape, and it is still the office's own body.
  select p.prosrc, pg_get_function_arguments(p.oid) as args, p.prosecdef,
         p.proconfig::text as config, l.lanname as lan
    into v_shape
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
   where n.nspname = 'platform_auth' and p.proname = 'gateway_webhook_detail';
  if v_shape.args <> 'p_tenant uuid, p_webhook uuid' or v_shape.prosecdef is not true
     or v_shape.lan <> 'plpgsql'
     or v_shape.config not like '%search_path=public%' then
    raise exception '137: the delivery read left the shape it was handed — args %, definer %, '
      'language %, config %',
      v_shape.args, v_shape.prosecdef, v_shape.lan, v_shape.config;
  end if;

  select prosrc into v_body from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth' and p.proname = 'gateway_webhook_detail';

  -- Three bindings of the pile to the asking desk: the attempt list (135 had it) and the two counts
  -- (135 did not). A fourth would mean this file edited a question that was already bound; one fewer
  -- means the read still answers the ceiling from somebody else's presses.
  v_binds := (length(v_body) - length(replace(v_body,
    'a.webhook_id = v_w.id and a.tenant_id = p_tenant', '')))
    / length('a.webhook_id = v_w.id and a.tenant_id = p_tenant');
  if v_binds <> 3 then
    raise exception '137: expected the attempt pile bound to the asking desk in three places, found '
      'it % time(s) — the ceiling count is still per delivery, or this file replaced more than the '
      'two counts it was written for', v_binds;
  end if;
  if v_body like '%where a.webhook_id = v_w.id) < 5%'
     or v_body like '%where a.webhook_id = v_w.id) >= 5%' then
    raise exception '137: the delivery read still counts another desk''s presses as its own ceiling';
  end if;

  -- The reference is asked for its text, three times: the charge join 135 already had and the two
  -- flags this file rewrote. And no existence test is left anywhere in the body, because the read
  -- that renders a button must ask the door's question.
  v_refs := (length(v_body) - length(replace(v_body,
    'coalesce(v_w.payload ->> ''reference'', '''')', '')))
    / length('coalesce(v_w.payload ->> ''reference'', '''')');
  if v_refs <> 3 then
    raise exception '137: expected the reference read as text in three places, found it % time(s)',
      v_refs;
  end if;
  if v_body like '%payload ? ''reference''%' then
    raise exception '137: the delivery read still asks whether a reference key exists rather than '
      'whether it says anything';
  end if;
  if v_body not like '%platform_auth.scrub_gateway_payload(v_w.payload)%' then
    raise exception '137: the read lifted by this file forgot the scrub, and a gateway read would '
      'answer with a payer''s phone number';
  end if;

  -- The board and the door still answer the two flags 137 did not touch, in the shapes the desk and
  -- the smoke already read.
  if has_function_privilege('public', 'platform_auth.gateway_webhook_detail(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'platform_auth.gateway_webhook_detail(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated',
        'platform_auth.gateway_webhook_detail(uuid, uuid)', 'execute')
     or has_function_privilege('service_role',
        'platform_auth.gateway_webhook_detail(uuid, uuid)', 'execute') then
    raise exception '137: a client role can execute the delivery read directly';
  end if;
  if not has_function_privilege('app_runtime',
       'platform_auth.gateway_webhook_detail(uuid, uuid)', 'execute') then
    raise exception '137: the office''s own role lost its grant to read a delivery';
  end if;

  raise notice '137: the attempt key now names the desk, and the delivery read counts the same pile '
    'and the same reference as the board and the door — % binding(s), % text test(s)',
    v_binds, v_refs;
end $$;

commit;
