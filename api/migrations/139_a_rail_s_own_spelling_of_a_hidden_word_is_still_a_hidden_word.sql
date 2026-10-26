-- 139: A rail's own spelling of a hidden word is still a hidden word.
--
-- 135 wrote the payload scrub as a deny-list of key names and folded each name before comparing it:
-- dashes to underscores, everything lowercased, and the same word with its underscores taken out. The
-- fold catches the spellings a rail writes with punctuation — `Phone-Number`, `PHONE_NUMBER` and
-- `phonenumber` all arrive at a word that is on the list. It does not catch the spellings a rail
-- writes with CASE. `lower(replace('cardNumber', '-', '_'))` is `cardnumber`, and the list carries
-- `card_number`; the second test strips a dash that was never there and answers `cardnumber` again.
-- So a key named the way an SDK names it walks through the scrub with its value still attached, and
-- the two gateway reads that call the scrub put it on a desk for a support seat to read. The words a
-- rail uses for a payer are exactly the camelCase ones: `payerPhone`, `cardNumber`,
-- `accountNumber`, `mobileNumber`, `idNumber`, `nationalId`, `accNo`, `webhookSecret`.
--
-- The shape of the leak is one call: `select platform_auth.scrub_gateway_payload(
-- '{"cardNumber":"4111111111111111"}')` answers with the card number on a database running 135's
-- body and answers with nothing on one running this file's. A value-shape scrub — strip anything that
-- looks like a phone number — was rejected by 135's own comment for a good reason and is not what this
-- file proposes: it would also strip `WSH-0751234567`, the reference a seat needs in order to say
-- which charge is stuck. Hiding by name is right; the name just has to be folded the way the rail
-- spells it before it is compared. So the key is now split at its case boundary into an underscore and
-- lowercased, and the two tests read that folded word: `cardNumber`, `card-number`,
-- `CARD_NUMBER`, `card_number` and `CardNumber` are one word, and the second test still catches
-- the spellings that were always one word (`cardnumber`, `payerphone`). The list grows from 34
-- names to 43 because those underscore-free twins have to stay written down — the fold produces
-- `card_number`, and a rail that writes `cardnumber` reaches the list only through the test that
-- takes the underscore out.
--
-- **Why this is a new file.** `schema_migrations` records a filename and `migrate.ts` skips every
-- name it has already recorded, so 135's text is frozen: the databases that ran it keep what they read,
-- and a fix reaches them only as the next file. 136 and 137 were each written for exactly this reason,
-- and this fold was cut while this stage's browser pass was walking the delivery board — it belongs to
-- the file that next touches the scrub, which is this one, and not to a recorded 135.
--
-- **What this file does not change.** The rule that the scrub hides by NAME and never by shape, so a
-- number that is plainly a phone survives under a name nobody hid and the list is what has to grow when
-- a rail renames a field. The recursion into nested objects and arrays, the four non-object shapes
-- handed back as they came, and the top-level bare array the walk cannot reach — recorded by this
-- stage's gate as an open hole rather than as a passing claim, because `payment_webhooks.payload` is
-- written by an intake route that always stores an object. The two doors that call the scrub, its
-- signature, its `immutable` volatility, and the privacy rule 135 set on it: it touches no table, so
-- EXECUTE is revoked from every role including the office's own, and `create or replace` hands that
-- grant back to PUBLIC unless a file takes it away again. Every other body in 135 is left alone.
begin;

-- ============================================================
-- 1. the scrub, folding a rail's case the way it folds a rail's dashes
-- ============================================================

-- 135's body lifted whole. Two clauses differ: the name is folded at its case boundary and compared
-- twice over, and the list carries the words the fold no longer has to be told twice.
/**
 * Strip the keys a rail must never be asked to repeat, at any depth.
 *
 * The list is by *key name*, never by value shape. A scrub that removed anything looking like a
 * phone number would also remove `WSH-075...`, the reference the desk needs in order to say which
 * charge is stuck — and a payload read that destroyed the fact it was opened to show is worse than
 * not opening it. So the deny-list is the words a rail actually uses for a person's account or a
 * secret, compared once the name is folded, and everything else in the body survives.
 *
 * Today the intake route stores four shaped keys (`reference`, `outcome`, `nonce`, `event`) and
 * two refusal bodies, so nothing sensitive is in this column. The scrub ships anyway: it is the reason
 * a later rail that posts a raw body cannot turn a gateway read into a PII read, and the desk that
 * shows a payload is exactly where that would first be visible.
 *
 * A rail picks its own spelling, so the name is folded before it is compared: dashes to underscores,
 * camelCase split into two words, everything lowercased, and the same name with its underscores taken
 * out. `phone-number`, `PhoneNumber`, `phone_number` and `phonenumber` are then one word, and
 * the list is written once.
 */
create or replace function platform_auth.scrub_gateway_payload(p_payload jsonb)
returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_hidden text[] := array[
    'phone','phonenumber','phone_number','msisdn','mobile','mobile_number','mobilenumber','tel',
    'telephone','account','accountno','account_number','accountnumber','acc_no','accno','pan',
    'card','cardno','card_number','cardnumber','cvv','cvc','expiry','pin','otp','email','mail',
    'nida','id_number','idnumber','national_id','nationalid','secret','password','token',
    'authorization','signature','credentials_encrypted','credentialsencrypted','webhook_secret',
    'webhooksecret','payer_phone','payerphone'];
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_val jsonb;
  v_norm text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return coalesce(p_payload, '{}'::jsonb);
  end if;
  for v_key, v_val in select key, value from jsonb_each(p_payload)
  loop
    v_norm := lower(regexp_replace(replace(v_key, '-', '_'), '([a-z0-9])([A-Z])', '\1_\2', 'g'));
    if v_norm = any (v_hidden) or replace(v_norm, '_', '') = any (v_hidden) then
      continue;
    end if;
    if jsonb_typeof(v_val) = 'object' then
      v_out := v_out || jsonb_build_object(v_key, platform_auth.scrub_gateway_payload(v_val));
    elsif jsonb_typeof(v_val) = 'array' then
      v_out := v_out || jsonb_build_object(v_key, coalesce((select jsonb_agg(
                       case when jsonb_typeof(e) = 'object'
                            then platform_auth.scrub_gateway_payload(e) else e end)
                     from jsonb_array_elements(v_val) e), '[]'::jsonb));
    else
      v_out := v_out || jsonb_build_object(v_key, v_val);
    end if;
  end loop;
  return v_out;
end $$;
-- ============================================================
-- 2. who may knock — and who may not
-- ============================================================

-- 135 revoked this one from every role, the office's own included: a desk that could reach the scrub
-- on its own could ask it about any jsonb column in the schema and learn which key names this platform
-- hides, which is a map of where the PII is not. `create or replace function` puts that EXECUTE back
-- on the public list, so the sweep is this file's own work and not a copy of 135's.
revoke all on function platform_auth.scrub_gateway_payload(jsonb)
  from public, anon, authenticated, app_runtime, service_role;

-- ============================================================
-- 3. say what this left the office in
-- ============================================================

do $$ declare
  v_shape  record;
  v_leaks  int;
  v_body   text;
  v_fold   int;
  v_flat   int;
  v_words  int;
  v_dups   int;
  v_list   text;
  v_out    jsonb;
  v_kept   text[];
begin
  -- The same function, once, with the same signature and the same two properties every reader of a
  -- payload leans on. A second overload would leave 135's body answering the gateway doors — which is
  -- the exact failure this office has now written files about three times.
  select p.pronargs, pg_get_function_arguments(p.oid) as args, p.prosecdef, p.provolatile,
         p.proconfig::text as config, l.lanname as lan
    into v_shape
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
   where n.nspname = 'platform_auth' and p.proname = 'scrub_gateway_payload';
  if not found then
    raise exception '139: platform_auth.scrub_gateway_payload does not exist';
  end if;
  select count(*)::int into v_leaks from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth' and p.proname = 'scrub_gateway_payload';
  if v_leaks <> 1 or v_shape.args <> 'p_payload jsonb' or v_shape.prosecdef is not false
     or v_shape.provolatile <> 'i' or v_shape.config not like '%search_path=public%'
     or v_shape.lan <> 'plpgsql' then
    raise exception '139: the scrub left the shape it was handed — % overload(s) taking `%`, '
      'definer %, volatile %, config %, language %',
      v_leaks, v_shape.args, v_shape.prosecdef, v_shape.provolatile, v_shape.config, v_shape.lan;
  end if;

  select prosrc into v_body from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth' and p.proname = 'scrub_gateway_payload';

  -- The fold, written once, and 135's dash-only test gone. A body that kept both would fold and then
  -- compare the unfolded name as well, which reads as a longer list rather than as a fixed one.
  v_fold := (length(v_body) - length(replace(v_body, '([a-z0-9])([A-Z])', '')))
            / length('([a-z0-9])([A-Z])');
  if v_fold <> 1 then
    raise exception '139: expected the case-boundary split once in the scrub, found it % time(s)',
      v_fold;
  end if;
  v_flat := (length(v_body) - length(replace(v_body, 'lower(replace(v_key', '')))
            / length('lower(replace(v_key');
  if v_flat <> 0 then
    raise exception '139: the scrub still compares a name it folded for dashes but not for case — '
      'this file replaced nothing';
  end if;
  if v_body not like '%replace(v_norm, ''_'', '''') = any (v_hidden)%' then
    raise exception '139: the folded name is not tested with its underscores taken out, so a rail '
      'that writes `cardnumber` is back outside the list';
  end if;
  -- The list is still written in the body, still by name, and it did not shrink on the way: 135's 34
  -- names are all here, each one written once, and the 9 more are the spellings that were always one
  -- word — `cardnumber`, `payerphone` — which the fold cannot produce and the second test reads.
  select split_part(split_part(v_body, 'v_hidden text[] := array[', 2), '];', 1) into v_list;
  if v_list = v_body or v_list = '' then
    raise exception '139: the deny-list is no longer written in the body, which is the one rule this '
      'file promised to leave alone';
  end if;
  select count(*)::int into v_words from regexp_matches(v_list, '''([a-z_0-9]+)''', 'g');
  select count(*)::int into v_dups from (select m[1] as w
    from regexp_matches(v_list, '''([a-z_0-9]+)''', 'g') m group by 1 having count(*) > 1) d;
  if v_words <> 43 or v_dups <> 0 then
    raise exception '139: expected the folded list to carry 135''s 34 names plus the 9 one-word '
      'spellings, each written once — found % name(s) with % duplicate(s)', v_words, v_dups;
  end if;

  -- The proof this file exists for, asked of the body rather than of the text: eight camelCase names
  -- a rail would write, in one call, and the three keys the desk needs beside them.
  select platform_auth.scrub_gateway_payload(jsonb_build_object(
    'cardNumber', '4111111111111111', 'payerPhone', '+255712345678',
    'accountNumber', '0123456789', 'mobileNumber', '+255781234567',
    'idNumber', '12345678', 'nationalId', '9901011234567',
    'webhookSecret', 'sq-abcdef', 'credentialsEncrypted', 'eyJhbGci',
    'reference', 'WSH-0751234567', 'outcome', 'approved', 'event', 'payment.captured'))
    into v_out;
  select array_agg(k order by k) into v_kept from jsonb_object_keys(v_out) k;
  if v_kept is distinct from array['event', 'outcome', 'reference'] then
    raise exception '139: a gateway read would still be handed % — the fold does not reach the '
      'spelling the rail writes it in', v_kept;
  end if;

  -- …and the same rule one level down, because the doors walk nested bodies: a phone buried in a
  -- payer object is hidden on the folded name while its sibling key is kept, and an array element is
  -- scrubbed on the same pass without losing its place.
  select platform_auth.scrub_gateway_payload(jsonb_build_object(
    'reference', 'WSH-0751234567',
    'meta', jsonb_build_object('payer', jsonb_build_object(
      'payerPhone', '+255712345678', 'kind', 'NIDA-id')),
    'lines', jsonb_build_array(jsonb_build_object('cardnumber', '4111111111111111', 'line', 1))))
    into v_out;
  if v_out #> '{meta,payer,payerPhone}' is not null
     or v_out #>> '{meta,payer,kind}' <> 'NIDA-id'
     or v_out #> '{lines,0,cardnumber}' is not null
     or v_out #>> '{lines,0,line}' <> '1'
     or v_out #>> '{reference}' <> 'WSH-0751234567' then
    raise exception '139: the nested walk changed while the name was being folded — %', v_out;
  end if;

  -- Nobody may knock. Not a client role, and not the office's own role either: the scrub is called
  -- from inside the two gateway reads, and a desk that could call it directly could map which key
  -- names this platform hides.
  if has_function_privilege('public', 'platform_auth.scrub_gateway_payload(jsonb)', 'execute')
     or has_function_privilege('anon', 'platform_auth.scrub_gateway_payload(jsonb)', 'execute')
     or has_function_privilege('authenticated',
        'platform_auth.scrub_gateway_payload(jsonb)', 'execute')
     or has_function_privilege('service_role',
        'platform_auth.scrub_gateway_payload(jsonb)', 'execute')
     or has_function_privilege('app_runtime',
        'platform_auth.scrub_gateway_payload(jsonb)', 'execute') then
    raise exception '139: a role can execute the payload scrub directly, which 135''s grant list '
      'says it never should';
  end if;

  -- The two doors that call the scrub still do, and still on their own grants.
  if not has_function_privilege('app_runtime',
       'platform_auth.gateway_webhook_detail(uuid, uuid)', 'execute')
     or not has_function_privilege('app_runtime',
       'platform_auth.gateway_webhook_board(uuid, text, text, text, int, int)', 'execute') then
    raise exception '139: the office''s own role lost the gateway reads that call the scrub';
  end if;

  raise notice '139: a hidden word is now folded at its case boundary before it is compared — % '
    'names in the list, the camelCase eight hidden in one call, and EXECUTE still held by nobody',
    v_words;
end $$;

commit;
