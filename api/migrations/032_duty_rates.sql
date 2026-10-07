-- 032: Duty calculator foundations — versioned TRA rates. Rates change with
-- each Finance Act, so every row carries a version tag and effective window;
-- the calculator resolves the version in force on today's date. Next year:
-- insert a new version's rows (a migration), never edit history.
begin;

create table if not exists duty_rates (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  effective_from date not null,
  effective_to date,
  kind text not null check (kind in ('vat','levy','fee','import_band','idl','excise')),
  hs_code text,
  category text,
  label text not null,
  basis text not null check (basis in ('cif','fob','duty_paid_value','per_unit')),
  rate_type text not null check (rate_type in ('percent','amount')),
  rate_value numeric(14,4) not null,
  is_active boolean not null default true
);
create index idx_duty_rates_version on duty_rates (version);
create index idx_duty_rates_kind on duty_rates (kind, is_active);
create index idx_duty_rates_hs on duty_rates (hs_code) where hs_code is not null;

-- Platform-wide reference data: every portal user reads it, writes happen
-- through version migrations only.
alter table duty_rates enable row level security;
create policy duty_rates_read on duty_rates for select to app_runtime using (true);
grant select on duty_rates to app_runtime;

-- ===== Seed: TRA "Taxes and Duties at a Glance 2025" (July 2025 edition) =====
insert into duty_rates (version, effective_from, effective_to, kind, hs_code, category, label, basis, rate_type, rate_value)
values
  -- Core import computation stack (sections 10.2, 26, 27)
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'vat',  null, null, 'VAT — taxable imports and supplies (Mainland)', 'duty_paid_value', 'percent', 18),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'vat',  null, null, 'Withholding VAT — goods supplied to a withholding agent', 'cif', 'percent', 3),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'vat',  null, null, 'Withholding VAT — services supplied to a withholding agent', 'cif', 'percent', 6),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'levy', null, null, 'Railway Development Levy', 'cif', 'percent', 2),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'fee',  null, null, 'Customs Processing Fee', 'fob', 'percent', 0.6),

  -- Import duty bands (section 11)
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'import_band', null, 'raw_materials',   'Raw materials, pharmaceuticals, capital goods, hand hoes, agricultural implements', 'cif', 'percent', 0),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'import_band', null, 'semi_finished',   'Semi-finished goods', 'cif', 'percent', 10),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'import_band', null, 'final_consumer',  'Final consumer goods or finished commercial goods', 'cif', 'percent', 25),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'import_band', null, 'fully_finished',  'Fully finished goods or special rate items (sensitive)', 'cif', 'percent', 35),

  -- Industrial Development Levy on customs value (section 21) — transport-relevant picks
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'idl', '8701.21.90', null, 'IDL — Road tractors for semi-trailers (trucks) 8701.21.90–8701.29.90', 'cif', 'percent', 10),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'idl', '2523.29.00', null, 'IDL — Cement (Portland cement)', 'cif', 'percent', 10),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'idl', '7317.00.00', null, 'IDL — Nails, tacks, pins, staples', 'cif', 'percent', 5),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'idl', '7213.91.10', null, 'IDL — Steel wire rod', 'cif', 'percent', 10),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'idl', '7213.14.00', null, 'IDL — Steel bars and rods (construction)', 'cif', 'percent', 10),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'idl', '7209.16.00', null, 'IDL — Flat-rolled steel products', 'cif', 'percent', 5),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'idl', '6907.21.00', null, 'IDL — Ceramic tiles', 'cif', 'percent', 5),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'idl', '8544.70.00', null, 'IDL — Optical fibre cables', 'cif', 'percent', 10),

  -- Excise on goods (section 12) — transport-relevant
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'excise', null, null, 'Excise — vehicle cylinder capacity below 1000 cc', 'duty_paid_value', 'percent', 0),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'excise', null, null, 'Excise — vehicle cylinder capacity 1000–2000 cc', 'duty_paid_value', 'percent', 5),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'excise', null, null, 'Excise — vehicle cylinder capacity above 2000 cc', 'duty_paid_value', 'percent', 10),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'excise', null, null, 'Excise — used passenger vehicle aged 8–10 years', 'duty_paid_value', 'percent', 15),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'excise', null, null, 'Excise — used passenger vehicle aged over 10 years', 'duty_paid_value', 'percent', 30),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'excise', null, null, 'Excise — used motorcycle (HS 87.11) aged over 3 years', 'duty_paid_value', 'percent', 10),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'excise', null, null, 'Fuel levy — petrol or diesel, per litre (Road and Fuels Tolls Act)', 'per_unit', 'amount', 523),
  ('TRA 2025/26', '2025-07-01', '2026-06-30', 'excise', null, null, 'Petroleum levy — kerosene, gas oil and motor spirit, per litre', 'per_unit', 'amount', 250)
on conflict do nothing;

commit;
