-- 049_transport_role_hardening
-- Supabase's bootstrap sets DEFAULT PRIVILEGES that grant EXECUTE on every new
-- function — and ALL on every new table — to the named API roles anon,
-- authenticated and service_role. Migration 048's `revoke ... from public`
-- does not cover those named roles, so the transport surface was still
-- callable by them: anon holds EXECUTE on transport_book_request and friends,
-- and table rights on transport_requests / transport_bookings.
--
-- The runtime never connects as those roles (the API uses app_runtime through
-- the pooler), so revoking costs nothing and removes them from the surface
-- entirely — belt and braces on top of the RLS + GUC guard, in case PostgREST
-- exposure of schema public is ever switched on in this project.

begin;

revoke all on function transport_book_request(uuid, uuid, uuid, text, text)
  from anon, authenticated, service_role;
revoke all on function transport_confirm_booking(uuid, uuid, uuid)
  from anon, authenticated, service_role;
revoke all on function transport_reject_booking(uuid, uuid, uuid, text)
  from anon, authenticated, service_role;
revoke all on function transport_release_booking(uuid, uuid, uuid, text)
  from anon, authenticated, service_role;
revoke all on function transport_cancel_booking(uuid, uuid, uuid, text)
  from anon, authenticated, service_role;
revoke all on function transport_withdraw_request(uuid, uuid, uuid)
  from anon, authenticated, service_role;
revoke all on function transport_booking_reminders()
  from anon, authenticated, service_role;
revoke all on function transport_booking_releases()
  from anon, authenticated, service_role;
revoke all on function transport_actor_ok(uuid)
  from anon, authenticated, service_role;

-- Same fix for the board projection functions from 046 — they carry the same
-- default-grant leak.
revoke all on function board_requests(text, int, date, date, text, int, int)
  from anon, authenticated, service_role;
revoke all on function board_request_card(uuid)
  from anon, authenticated, service_role;

revoke all on transport_requests from anon, authenticated, service_role;
revoke all on transport_bookings from anon, authenticated, service_role;

commit;
