-- 009: atomic payment completion -> licence activation (spec 5.2, 5.4)
begin;

create or replace function platform_auth.complete_payment(
  p_intent_reference text,
  p_new_status text,
  p_provider_txn_id text default null)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_payment payments%rowtype;
  v_invoice invoices%rowtype;
  v_months int;
  v_period_end timestamptz;
begin
  if p_new_status not in ('approved','failed','timed_out','cancelled') then
    return jsonb_build_object('status','invalid_status');
  end if;

  select * into v_payment from payments
   where intent_reference = p_intent_reference
   limit 1 for update;
  if not found then return jsonb_build_object('status','not_found'); end if;

  -- Idempotent: a final payment never transitions again (webhook replays are safe)
  if v_payment.status <> 'pending' then
    return jsonb_build_object('status','already_final','payment_status', v_payment.status);
  end if;

  if not platform_auth.payment_transition_allowed(v_payment.status, p_new_status) then
    return jsonb_build_object('status','invalid_transition');
  end if;

  update payments set status = p_new_status, completed_at = now(),
    provider_txn_id = coalesce(p_provider_txn_id, provider_txn_id)
   where id = v_payment.id;

  if p_new_status <> 'approved' then
    return jsonb_build_object('status','ok','payment_status', p_new_status);
  end if;

  -- Approved: invoice paid, subscription active, tenant active — all atomic.
  select * into v_invoice from invoices where id = v_payment.invoice_id;
  update invoices set status = 'paid', paid_at = now() where id = v_invoice.id;

  v_months := case v_invoice.billing_cycle
    when 'quarterly' then 3 when 'annual' then 12 else 1 end;
  v_period_end := now() + make_interval(months => v_months);

  update subscriptions set
    status = 'active',
    current_period_start = now(),
    current_period_end = v_period_end
   where tenant_id = v_payment.tenant_id and deleted_at is null;

  update tenants set status = 'active', licence_expires_at = v_period_end
   where id = v_payment.tenant_id;

  return jsonb_build_object('status','ok','payment_status','approved',
    'licence_expires_at', v_period_end);
end $$;

grant execute on function platform_auth.complete_payment(text, text, text) to app_runtime;

commit;