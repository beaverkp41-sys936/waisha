-- 030: Invoice professionalism pass — transporter payment details (where to
-- pay), per-invoice payment instructions, line-item units and currency work.
begin;

-- Where-to-pay defaults, set once by the transporter on their profile.
alter table company_profiles add column if not exists pay_bank_name text;
alter table company_profiles add column if not exists pay_bank_account text;
alter table company_profiles add column if not exists pay_account_name text;
alter table company_profiles add column if not exists pay_mobile_money text;

-- Stamped onto each invoice at creation (editable per invoice).
alter table freight_invoices add column if not exists payment_instructions text;

-- Optional unit per line: tonnes, trips, days, containers...
alter table freight_invoice_items add column if not exists unit text;

commit;
