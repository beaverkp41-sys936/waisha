-- 041: least-privilege pass on tenant tables (spec Rule 0 / security D.3).
-- Migration 001 established the soft-delete pattern: app_runtime gets
-- select/insert/update but DELETE is revoked; rows retire via deleted_at.
-- Migrations since drifted and re-granted delete on most modules. The only
-- hard deletes any route performs are office_tasks (employees.routes.ts),
-- freight_invoice_items (invoices.routes.ts), trip_checkpoint_logs
-- (trips.routes.ts) and route_checkpoints (routes.routes.ts) — those four
-- keep DELETE. user_roles is revoked nothing here (no tenant_id column and
-- users.routes.ts hard-replaces role rows). Everything else loses DELETE.
begin;

revoke delete on cargo_shipments, cargo_tasks, clients, documents, drivers,
  employee_evaluations, employees, freight_expenses, freight_invoices,
  freight_invoice_payments, fuel_logs, incidents, inventory_items, messages,
  office_budgets, office_costs, regulatory_licences, routes, screening_entries,
  shipper_accounts, shipper_file_shares, trip_shipments, trips, vessels
  from app_runtime;

commit;
