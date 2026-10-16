-- 053: widen the charge catalogue default rate.
--
-- 052 created default_rate as numeric(8,4), which caps a rate at 9,999.9999 —
-- fine for a percentage, too small for a flat or per-day charge typed in TZS
-- (a reefer plug at 45,000/day, a wharfage flat amount). Ten integer digits
-- with four decimals keeps the fractional statutory percentages exact and
-- leaves room for any local tariff. Purely a widening: stored values are
-- unchanged, so this is safe on databases where 052 already ran.

begin;

alter table charge_catalog
  alter column default_rate type numeric(14,4);

commit;
