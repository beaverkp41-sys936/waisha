-- 052: CFA Billing, Quotation & Proforma Generator — a charge catalog covering
-- the three blocks a Dar es Salaam clearing job is billed in (EAC statutory
-- taxes and duties, port/terminal/clearing charges, transport and incidentals),
-- quotations/proformas whose every line stays editable before it is saved or
-- printed, and a two-file reference shelf (primary proforma + secondary
-- supporting invoice) whose extracted values cross-verify the bill. The text
-- layer of each reference file is read in the browser and posted here as jsonb,
-- so no document byte is ever sent to a third party. Port tariff figures come
-- from what the transporter uploads, not from guesses baked into the catalog:
-- only the rates this repo can cite (VAT 18%, RDL 2% of CIF, CPF 0.6% of FOB,
-- from duty_rates) carry a default.
begin;

-- ---------- Charge catalog ----------
-- tenant_id null = platform default row that every portal reads; a tenant row
-- with the same code wins, so a CFA can re-label or re-rate a charge without
-- touching the shared reference. Seeded by migration only for the global rows.
create table if not exists charge_catalog (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  code text not null,
  label text not null,
  -- Which of the three printed blocks the charge belongs to, top to bottom.
  section text not null check (section in ('statutory','port','transport')),
  -- What the amount is computed on. cif/fob/duty_paid_value follow the customs
  -- valuation ladder; per_container and per_day are how TPA bills TEUs and
  -- storage; flat is a figure the clerk types.
  basis text not null default 'flat'
    check (basis in ('cif','fob','duty_paid_value','per_unit','per_container','per_day','flat')),
  -- Null rate = no citable tariff, so the line starts blank and is edited inline.
  default_rate numeric(14,4),
  rate_type text check (rate_type in ('percent','amount')),
  -- Intra-community EAC goods carry 0 duty but the line must still print.
  eac_exempt boolean not null default false,
  -- Printed order inside its section.
  sort int not null default 0,
  is_active boolean not null default true,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index charge_catalog_global_uq on charge_catalog (code)
  where deleted_at is null and tenant_id is null;
create unique index charge_catalog_tenant_uq on charge_catalog (tenant_id, code)
  where deleted_at is null and tenant_id is not null;
create index idx_charge_catalog_section on charge_catalog (section, sort)
  where deleted_at is null;

-- POLICY + GRANT together (016 lesson). Global rows are readable by every
-- tenant and, because every write policy requires a tenant match that NULL can
-- never satisfy, they are untouchable from the app role.
alter table charge_catalog enable row level security;
create policy charge_catalog_read on charge_catalog for select to app_runtime
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy charge_catalog_insert on charge_catalog for insert to app_runtime
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy charge_catalog_update on charge_catalog for update to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy charge_catalog_delete on charge_catalog for delete to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on charge_catalog to app_runtime;

create trigger trg_charge_catalog_updated before update on charge_catalog
  for each row execute function public.set_updated_at();

-- Block 1: EAC Customs Union statutory taxes and duties.
insert into charge_catalog (code, label, section, basis, default_rate, rate_type, sort, notes)
values
  ('IMPORT_DUTY', 'Import Duty (EAC Common External Tariff band)', 'statutory', 'cif', null, null, 10,
   'CET band 0/10/25/35 percent by goods category — see duty_rates import_band rows.'),
  ('EXCISE_DUTY', 'Excise Duty', 'statutory', 'duty_paid_value', null, null, 20,
   'Only for excisable goods; band depends on the item.'),
  ('IDL', 'Industrial Development Levy (IDL)', 'statutory', 'cif', null, null, 30,
   'Rate is HS-code specific — look the row up in duty_rates.'),
  ('RDL', 'Railway Development Levy (RDL)', 'statutory', 'cif', 2, 'percent', 40,
   '2 percent of CIF (duty_rates, TRA 2025/26).'),
  ('VAT_IMPORT', 'VAT on imports', 'statutory', 'duty_paid_value', 18, 'percent', 50,
   '18 percent on duty-paid value (duty_rates, TRA 2025/26).'),
  ('CPF_IDF', 'Customs Processing Fee / Import Declaration Fee', 'statutory', 'fob', 0.6, 'percent', 60,
   'CPF is 0.6 percent of FOB (duty_rates, TRA 2025/26). IDF is billed per declaration.'),
  -- Block 2: port, terminal and clearing charges. The TPA invoice shape is
  -- reproduced here; the money comes off the uploaded reference file.
  ('PORT_CLEARANCE', 'Port Clearance & Handling', 'port', 'per_container', null, null, 110, null),
  ('WHARFAGE', 'Wharfage', 'port', 'per_unit', null, null, 120,
   'TPA bills wharfage against the CIF value of the cargo.'),
  ('GREEN_PORT', 'Green Port Initiatives', 'port', 'per_container', null, null, 130,
   'Per-TEU charge; EAC-origin cargo is not exempt from it in practice.'),
  ('PORT_INFRA_DEV', 'Port Infrastructure Development', 'port', 'flat', null, null, 140,
   'Appears on TPA invoices with custom duty at zero.'),
  ('VERIFY_SCAN', 'Verification & Scanning Fees', 'port', 'flat', null, null, 150, null),
  ('AGENCY_CF', 'Agency / Clearing & Forwarding Fee', 'port', 'flat', null, null, 160,
   'The forwarding house''s own fee — tenants usually override the label.'),
  -- Block 3: transport, delivery and incidental charges.
  ('FREIGHT', 'Freight Charges', 'transport', 'per_unit', null, null, 210, null),
  ('CARTAGE', 'Local Transport / Cartage', 'transport', 'flat', null, null, 220, null),
  ('STORAGE', 'Storage', 'transport', 'per_day', null, null, 230, null),
  ('DEMURRAGE', 'Demurrage', 'transport', 'per_day', null, null, 240, null),
  ('INCIDENTAL', 'Incidental / Sundry Charges', 'transport', 'flat', null, null, 250, null)
on conflict do nothing;

-- Under the EAC Customs Union, qualifying originating goods are billed with the
-- duty line present at zero rather than dropped, and VAT still runs after it.
update charge_catalog set eac_exempt = true
  where tenant_id is null and code = 'IMPORT_DUTY';

-- ---------- Reference-file shelf ----------
-- The two uploaded documents a bill is built from. Extraction runs in the
-- browser over the file the user already has; this table stores what came back
-- so the cross-check survives a reload and is auditable.
create table if not exists billing_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- FK added once quotations exists below.
  quotation_id uuid,
  role text not null check (role in ('primary','secondary')),
  document_id uuid not null references documents(id),
  -- pending = uploaded, not read yet; extracted = the reader found fields;
  -- manual = nothing machine-readable (scanned image), the clerk types it;
  -- failed = the reader itself errored.
  extract_status text not null default 'pending'
    check (extract_status in ('pending','extracted','manual','failed')),
  -- { header: {...}, lines: [{ description, qty, unit, amount, vat, ... }] }
  extracted jsonb,
  extract_notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- One primary and one secondary per quotation.
create unique index billing_documents_role_uq on billing_documents (quotation_id, role)
  where deleted_at is null and quotation_id is not null;
create index idx_billing_documents_quotation on billing_documents (tenant_id, quotation_id)
  where deleted_at is null and quotation_id is not null;
create trigger trg_billing_documents_updated before update on billing_documents
  for each row execute function public.set_updated_at();

alter table billing_documents enable row level security;
create policy billing_documents_tenant on billing_documents for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on billing_documents to app_runtime;

-- ---------- Quotations / proformas ----------
create table if not exists quotations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  quotation_number text not null,
  -- quotation = priced offer to the client; proforma = pre-declaration bill
  kind text not null default 'proforma' check (kind in ('quotation','proforma')),
  status text not null default 'draft'
    check (status in ('draft','issued','accepted','declined','converted','cancelled')),
  customer_name text not null,
  customer_phone_encrypted bytea,
  customer_phone_search text,
  customer_email text,
  customer_tin text,
  customer_address text,
  -- Optional link once the cargo file exists; a quote often precedes it.
  shipment_id uuid references cargo_shipments(id),
  -- Header fields a TPA/liner invoice is filed under.
  vessel_name text,
  voyage text,
  bl_number text,
  trade_type text,
  currency text not null default 'TZS',
  -- Shown on foreign-currency bills; never used to convert money server-side.
  exchange_rate numeric(14,6),
  vat_rate numeric(5,2) not null default 18,
  issue_date date not null default current_date,
  valid_until date,
  -- Section totals + grand total, all recomputed server-side on save.
  statutory_total numeric(14,2) not null default 0,
  port_total numeric(14,2) not null default 0,
  transport_total numeric(14,2) not null default 0,
  subtotal numeric(14,2) not null default 0,
  vat_amount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  payment_instructions text,
  notes text,
  -- Set when the bill is promoted to a real invoice; invoices stay append-only.
  converted_invoice_id uuid references freight_invoices(id),
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index quotations_tenant_number_uq on quotations (tenant_id, quotation_number)
  where deleted_at is null;
create index idx_quotations_tenant_status on quotations (tenant_id, status, created_at desc)
  where deleted_at is null;
create index idx_quotations_tenant_customer on quotations (tenant_id, customer_name)
  where deleted_at is null;
create index idx_quotations_shipment on quotations (tenant_id, shipment_id)
  where deleted_at is null and shipment_id is not null;
create trigger trg_quotations_updated before update on quotations
  for each row execute function public.set_updated_at();

create table if not exists quotation_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  quotation_id uuid not null references quotations(id),
  seq int not null,
  -- Printed block the line belongs to; drives the three top-to-bottom sections.
  section text not null check (section in ('statutory','port','transport')),
  -- Catalog code the line started from (nullable: free lines are allowed).
  catalog_code text,
  description text not null,
  basis text not null default 'flat'
    check (basis in ('cif','fob','duty_paid_value','per_unit','per_container','per_day','flat')),
  quantity numeric(12,2) not null default 1,
  unit text,
  unit_price numeric(14,2) not null default 0,
  amount numeric(14,2) not null default 0,
  -- Statutory tax carried by this line, editable inline (a TPA bill shows VAT
  -- per charge group, not one VAT line at the foot).
  tax_kind text not null default 'vat' check (tax_kind in ('vat','excise','none')),
  tax_rate numeric(5,2) not null default 0,
  tax_amount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  -- Provenance: which reference file this figure was read from, and whether a
  -- human has confirmed it against the other file.
  source_document_id uuid references billing_documents(id),
  verified boolean not null default false,
  notes text
);
create index idx_quotation_items_line on quotation_items (quotation_id, seq);

alter table quotation_items enable row level security;
create policy quotation_items_tenant on quotation_items for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on quotation_items to app_runtime;

-- billing_documents references quotations, so its FK is added after the table.
alter table billing_documents add constraint billing_documents_quotation_fk
  foreign key (quotation_id) references quotations(id);

-- ---------- Quotations become invoices ----------
-- Section totals and line-level taxes carry across when a proforma is promoted,
-- so the printed invoice keeps the same three blocks as the quote it came from.
alter table freight_invoices add column if not exists statutory_total numeric(14,2) not null default 0;
alter table freight_invoices add column if not exists port_total numeric(14,2) not null default 0;
alter table freight_invoices add column if not exists transport_total numeric(14,2) not null default 0;
alter table freight_invoices add column if not exists exchange_rate numeric(14,6);
alter table freight_invoices add column if not exists source_quotation_id uuid references quotations(id);

alter table freight_invoice_items add column if not exists section text not null default 'transport'
  check (section in ('statutory','port','transport'));
alter table freight_invoice_items add column if not exists catalog_code text;
alter table freight_invoice_items add column if not exists basis text not null default 'flat';
alter table freight_invoice_items add column if not exists tax_kind text not null default 'none'
  check (tax_kind in ('vat','excise','none'));
alter table freight_invoice_items add column if not exists tax_rate numeric(5,2) not null default 0;
alter table freight_invoice_items add column if not exists tax_amount numeric(14,2) not null default 0;

-- The vault stores quotations and their source papers under their own entity
-- type, and the generated proforma under its own kind.
alter table documents drop constraint documents_entity_type_check;
alter table documents add constraint documents_entity_type_check
  check (entity_type in ('tenant','user','vessel','driver','trip','shipment','message',
                         'licence','employee','office_cost','quotation'));
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check
  check (kind in ('logo','avatar','licence','insurance','inspection','road_licence',
                  'delivery_note','invoice','bill_of_lading','packing_list','contract',
                  'other','attachment','receipt','shipper_upload','arrival_notice',
                  'delivery_order','declaration','assessment','release_note','permit',
                  'pod','handover','proforma'));

-- ---------- RLS + grants for quotations ----------
alter table quotations enable row level security;
create policy quotations_tenant on quotations for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on quotations to app_runtime;

-- ---------- Permission keys ----------
insert into permissions (key, description)
values
  ('quotations.view', 'Quotations - View quotes and proformas'),
  ('quotations.create', 'Quotations - Raise quotes and proformas'),
  ('quotations.edit', 'Quotations - Edit lines, taxes and totals'),
  ('quotations.delete', 'Quotations - Delete quotes'),
  ('quotations.issue', 'Quotations - Issue or cancel a proforma'),
  ('quotations.convert', 'Quotations - Convert a proforma into an invoice'),
  ('quotations.export', 'Quotations - Print or export the document'),
  ('charge_catalog.view', 'Charge Catalog - Read statutory and port charges'),
  ('charge_catalog.manage', 'Charge Catalog - Maintain tenant charge codes'),
  ('billing_documents.view', 'Reference Files - View extracted billing documents'),
  ('billing_documents.upload', 'Reference Files - Attach primary and secondary reference files')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'quotations.%' or p.key like 'charge_catalog.%'
  or p.key like 'billing_documents.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('quotations.view', 'quotations.export',
  'charge_catalog.view', 'billing_documents.view')
where r.key = 'auditor' and r.tenant_id is null
on conflict do nothing;

commit;
