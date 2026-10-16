-- 054: least-privilege pass on the billing tables, matching 041.
--
-- Rows in this module retire through deleted_at, never through SQL: a
-- proforma, a reference file and a charge code are all history the office may
-- have to show an auditor later. The only hard delete any billing route does
-- is replacing the line items of a draft whole (quotations.routes.ts), exactly
-- like the invoice module does, so quotation_items keeps DELETE and the rest
-- of the module loses it.

begin;

revoke delete on quotations, billing_documents, charge_catalog from app_runtime;

commit;
