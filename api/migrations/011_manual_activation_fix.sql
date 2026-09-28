-- 011: fix manual_activate - generate a durable reference for the payments row
-- (intent_reference is NOT NULL/UNIQUE; manual payments have no gateway intent,
-- so we mint a MAN- reference that reconciliation can always trace back).
begin;

create or replace function platform_auth.manual_activate(
  p_tenant_id uuid,
  p_plan_key text,
  p_billing_cycle text,
  p_provider text,
  p_provider_txn_id text,
  p_amount_override numeric,
  p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_plan plans%rowtype;
  v_months int;
  v_total numeric;
  v_subtotal numeric;
  v_vat numeric;
  v_period_end timestamptz;
  v_subscription_id uuid;
  v_invoice_id uuid;
  v_number text;
  v_reference text;
  v_extending boolean;
  v_prev_expiry timestamptz;
begin
  if p_billing_cycle not in ('monthly','quarterly','annual') then
    return jsonb_build_object('status','invalid','message','Invalid billing cycle');
  end if;
  if p_provider not in ('azampesa','mpesa','tigopesa','airtel','halopesa','bank') then
    return jsonb_build_object('status','invalid','message','Invalid payment channel');
  end if;

  select * into v_plan from plans where key = p_plan_key and is_active = true limit 1;
  if not found then
    return jsonb_build_object('status','invalid','message','Plan unavailable');
  end if;

  select licence_expires_at into v_prev_expiry from tenants
   where id = p_tenant_id and deleted_at is null;
  if not found then return jsonb_build_object('status','not_found'); end if;

  v_extending := v_prev_expiry is not null and v_prev_expiry > now();
  v_period_end := (case when v_extending then v_prev_expiry else now() end)
                  + make_interval(months => case p_billing_cycle
                      when 'quarterly' then 3 when 'annual' then 12 else 1 end);

  v_subtotal := case p_billing_cycle
    when 'quarterly' then v_plan.price_quarterly
    when 'annual' then v_plan.price_annual
    else v_plan.price_monthly end;
  if p_amount_override is not null and p_amount_override > 0 then
    v_total := round(p_amount_override, 2);
    v_subtotal := round(v_total / (1 + v_plan.vat_rate), 2);
  else
    v_total := round(v_subtotal * (1 + v_plan.vat_rate), 2);
  end if;
  v_vat := round(v_total - v_subtotal, 2);

  update subscriptions set plan_id = v_plan.id, billing_cycle = p_billing_cycle,
      status = 'active', current_period_start = now(), current_period_end = v_period_end
   where tenant_id = p_tenant_id and deleted_at is null
   returning id into v_subscription_id;
  if v_subscription_id is null then
    insert into subscriptions (tenant_id, plan_id, billing_cycle, status, seats_licensed,
      current_period_start, current_period_end)
    values (p_tenant_id, v_plan.id, p_billing_cycle, 'active', 1, now(), v_period_end)
    returning id into v_subscription_id;
  end if;

  v_number := 'INV-' || to_char(now(), 'YYYY') || '-' ||
              lpad(nextval('invoice_number_seq')::text, 6, '0');
  v_reference := 'MAN-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 12));

  insert into invoices (tenant_id, subscription_id, number, billing_cycle, seats,
    amount_subtotal, vat_rate, vat_amount, amount_total, status, period_start, period_end,
    paid_at)
  values (p_tenant_id, v_subscription_id, v_number, p_billing_cycle, 1,
    v_subtotal, v_plan.vat_rate, v_vat, v_total, 'paid',
    current_date, v_period_end::date, now())
  returning id into v_invoice_id;

  insert into payments (tenant_id, invoice_id, provider, provider_txn_id,
    intent_reference, amount, currency, status, idempotency_key, completed_at)
  values (p_tenant_id, v_invoice_id, p_provider, p_provider_txn_id,
    v_reference, v_total, 'TZS', 'approved',
    gen_random_uuid()::text, now());

  update tenants set status = 'active', licence_expires_at = v_period_end
   where id = p_tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity, entity_id, action, after)
  values (p_tenant_id, p_actor, 'tenants', p_tenant_id, 'licence.manually_activated',
    jsonb_build_object(
      'mode', case when v_extending then 'extend' else 'activate' end,
      'plan', v_plan.key, 'cycle', p_billing_cycle,
      'provider', p_provider, 'provider_txn_id', p_provider_txn_id,
      'reference', v_reference,
      'subtotal', v_subtotal, 'vat', v_vat, 'total', v_total,
      'previous_expiry', v_prev_expiry, 'new_expiry', v_period_end,
      'invoice', v_number));

  return jsonb_build_object('status','ok',
    'mode', case when v_extending then 'extend' else 'activate' end,
    'invoice_number', v_number, 'reference', v_reference, 'total', v_total,
    'licence_expires_at', v_period_end);
end $$;

grant execute on function platform_auth.manual_activate(uuid, text, text, text, text, numeric, uuid) to app_runtime;

commit;