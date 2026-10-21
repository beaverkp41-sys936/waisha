-- 115: a wiped rail stops reporting the check it failed against the address it no longer has (#283)
--
-- Found by the browser pass, not by the smoke. An operator files app id, app name and a gateway
-- address, presses Test, watches it fail because the sandbox host does not resolve, then presses
-- Clear and answers the dialog's own words — "Remove every credential and the switch". The
-- credentials and the switch went, and the card still read:
--
--   azampesa · no gateway address · sandbox
--   No credentials saved · no webhook secret
--   Last check failed 10/21/2026, 4:19:08 AM — Nothing answers for that gateway address …
--
-- The third line names an address the record no longer holds, so the desk appears to remember a
-- verdict about a rail that has nothing to verify. Worse, it reads as a standing fault the next
-- operator will try to fix by testing again — and a test on a rail with no address can only fail.
--
-- `clear_payment_gateway` therefore wipes the check with the rest of what Clear took. Nothing is
-- lost: every check was already written to `audit_logs` as `gateway.tested` with its own verdict,
-- so the history is a query away, while `last_check` is only ever "what the button last said" —
-- and that button belongs to a configuration this statement just removed.
--
-- CREATE OR REPLACE, never drop-and-recreate: 114's grants revoke EXECUTE from PUBLIC on this
-- function, and a drop resets them to the default, which would hand the wipe to every role. The
-- revoke is restated below anyway, because this function empties a money rail and a replace that
-- quietly widened a grant should never depend on a later reader remembering that.
begin;

create or replace function platform_auth.clear_payment_gateway(p_key text, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ begin
  if p_key is null then return jsonb_build_object('status', 'error', 'code', 'BAD_INPUT'); end if;
  update payment_gateways
     set credentials_encrypted = null, webhook_secret_encrypted = null, credential_hint = null,
         base_url = null, config = '{}'::jsonb, enabled = false, last_check = null,
         updated_by = p_actor, updated_at = now()
   where provider_key = p_key;
  if not found then return jsonb_build_object('status', 'error', 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('status', 'ok', 'provider_key', p_key);
end $$;

grant execute on function platform_auth.clear_payment_gateway(text, uuid) to app_runtime;
revoke all on function platform_auth.clear_payment_gateway(text, uuid)
  from public, anon, authenticated, service_role;

-- ============================================================
-- 2. the rows the old version already left half-wiped
-- ============================================================
--
-- Any rail cleared under 114 keeps a verdict describing a configuration it no longer has. A
-- check is only ever a statement about the credentials and address filed at that moment, so the
-- orphan is dropped here rather than left for the desk to explain.
update payment_gateways
   set last_check = null
 where credentials_encrypted is null
   and webhook_secret_encrypted is null
   and last_check is not null;

-- The label is deliberately not wiped: it is the name the office gave the rail, not a credential,
-- and the dialog promises credentials and the switch.

do $$ declare
  v_orphans int;
  v_live text;
begin
  select count(*)::int into v_orphans from payment_gateways
   where credentials_encrypted is null and last_check is not null;
  select coalesce(string_agg(provider_key, ', '), 'none — the API answers from PAYMENT_PROVIDER')
    into v_live from payment_gateways where enabled;
  raise notice '115: clear forgets its last check — % orphan verdict(s) left, live rail: %',
    v_orphans, v_live;
end $$;

commit;
