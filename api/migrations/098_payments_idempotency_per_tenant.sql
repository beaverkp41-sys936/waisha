-- 098 — an idempotency key means one thing inside one company (task #232 follow-up).
--
-- 005 declared `idempotency_key text not null unique` across the whole table, which was the
-- right shape while there was one kind of row and one writer of it: the client sends a key, and
-- the server's answer to "have I already been asked for this charge?" is the charge it made the
-- first time. The moment tenants multiply, the same declaration says something else — that two
-- companies can never both use the key string "retry-1", and that the second one to try is
-- refused by the database rather than served by its own retry.
--
-- The route was just bound to the caller's tenant (api/src/routes/payments.routes.ts), because
-- unbound it looked up a header any caller can guess in every company's rows and handed back
-- another company's `intent_reference` — a live charge reference, with a real amount and a real
-- payer phone attached, to a stranger who happened to reuse a string. That read is fixed. This
-- migration is the other half: once the lookup is scoped, the constraint has to be scoped too,
-- or the first foreign retry of a key in use elsewhere is a unique violation and a 500.
--
-- Keyed per tenant, the promise each client was actually given holds — one key, one charge, in
-- this company — and no company can collide with another's bookkeeping. The definer paths
-- (010, 011, 068, 078) all write a generated uuid as the key, so they stay unique under either
-- rule and are unaffected.
--
-- The composite index is built before the constraint is dropped: the old index is what makes the
-- new one's build cheap, and there is no window in which a duplicate can slip in.

begin;

create unique index if not exists payments_tenant_idempotency_key_uq
  on payments (tenant_id, idempotency_key);

alter table payments drop constraint payments_idempotency_key_key;

do $$ declare
  v_rows int;
  v_companies int;
begin
  select count(*)::int, count(distinct tenant_id)::int into v_rows, v_companies from payments;
  raise notice '098: payments idempotency is now per company — % row(s) across % company(ies), no key reused', v_rows, v_companies;
end $$;

commit;
