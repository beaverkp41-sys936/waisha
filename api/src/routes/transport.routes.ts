import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";
import { loadJob, logActivity } from "../util/jobs.js";
import {
  VEHICLE_TYPES, buildPreview, copyRoute, disclosureWarnings, type PreviewFields
} from "../util/transport.js";
import { getBoardCard } from "../util/board.js";
import { emitBoard } from "../util/board-bus.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const actorRole = (req: any): string | null => req.user?.roles?.[0] ?? null;

/**
 * The publish body is closed: `.strict()` means a field that is not on this
 * list is rejected rather than silently stored, so nothing can be smuggled
 * onto the board by a tampered client.
 */
const publishSchema = z.object({
  cargoLabel: z.string().trim().min(2).max(300),
  containerType: z.enum(["20ft", "40ft", "loose_cargo", "car"]).nullable().optional(),
  containerCount: z.number().int().min(1).max(500).nullable().optional(),
  weightTonnes: z.number().min(0).max(100000).nullable().optional(),
  cbm: z.number().min(0).max(100000).nullable().optional(),
  vehicleTypes: z.array(z.enum(VEHICLE_TYPES)).max(6).default([]),
  routeId: z.string().uuid().nullable().optional(),
  pickupText: z.string().trim().min(2).max(200),
  pickupRegionId: z.number().int().positive().nullable().optional(),
  destText: z.string().trim().min(2).max(200),
  destRegionId: z.number().int().positive().nullable().optional(),
  viaLabel: z.string().trim().max(200).nullable().optional(),
  requiredDate: dateOnly,
  contactUserId: z.string().uuid().nullable().optional(),
  contactName: z.string().trim().min(2).max(120),
  contactChannel: z.string().trim().min(5).max(160),
  publicNote: z.string().trim().max(600).nullable().optional(),
  acknowledgeWarnings: z.boolean().default(false)
}).strict();

const listSchema = z.object({
  status: z.enum(["open", "temp_booked", "confirmed", "cancelled"]).optional(),
  jobId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional()
});

/** Reason on a decline or a release — optional, but bounded. */
const optionalReason = z.object({
  reason: z.string().trim().min(2).max(300).optional()
}).strict();

/** Cancelling a confirmed booking always carries a reason (spec, Part 2). */
const cancelBookingSchema = z.object({
  reason: z.string().trim().min(4).max(300)
}).strict();

/** Typed reason from a booking transition function → the API's error shape. */
function bookingConflict(r: any, action: string): ApiError {
  if (r?.reason === "missing") return new ApiError("NOT_FOUND", "Transport request not found", 404);
  if (r?.reason === "not_allowed") return new ApiError("FORBIDDEN", "Not allowed.", 403);
  if (r?.reason === "reason_required") {
    return new ApiError("VALIDATION_FAILED", "Give a reason — at least a few words.", 400,
      [{ field: "reason" }]);
  }
  if (r?.reason === "confirmed") {
    return new ApiError("CONFLICT",
      "The booking is already confirmed — cancel it with a reason instead.", 409);
  }
  if (r?.reason === "not_temp") {
    if (r.status === "confirmed") {
      return new ApiError("CONFLICT",
        "The booking is already confirmed — cancel it with a reason instead.", 409);
    }
    if (r.status === "cancelled") {
      return new ApiError("CONFLICT", "That request was withdrawn by its publisher.", 409);
    }
    return new ApiError("CONFLICT",
      "That hold has already ended — it was released, declined or expired.", 409);
  }
  if (r?.reason === "not_confirmed") {
    if (r.status === "temp_booked") {
      return new ApiError("CONFLICT",
        "The booking is still awaiting confirmation — decline it instead.", 409);
    }
    return new ApiError("CONFLICT", "That booking is not confirmed any more.", 409);
  }
  return new ApiError("CONFLICT",
    `The booking changed while you were trying to ${action} it. Reload and try again.`, 409);
}

export async function transportRoutes(app: FastifyInstance, _opts: unknown) {
  // ---------- Consent preview: what would become visible, nothing stored ----------
  app.post("/jobs/:id/transport-preview",
    { preHandler: [requireAuth, requirePermission("transport.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, (c) =>
        buildPreview(c, req.user.tid, id, req.user.sub));
    });

  // ---------- Publish the approved copy ----------
  app.post("/jobs/:id/transport-request",
    { preHandler: [requireAuth, requirePermission("transport.publish")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = publishSchema.parse(req.body);
      const requestId = uuidv7();

      const out = await withTenant(req.user.tid, async (c) => {
        const job = await loadJob(c, req.user.tid, id);
        if (job.status !== "open") {
          throw new ApiError("CONFLICT", `A ${job.status} job cannot be advertised.`, 409);
        }
        // The client's permission is recorded at stage 9 and gates this call.
        if (job.record_kind === "archive") {
          throw new ApiError("CONFLICT",
            "This job is filed as a record of a completed shipment. It is never published.", 409);
        }
        if (!job.transport_needed || job.transport_consent !== "granted") {
          throw new ApiError("CONFLICT",
            "Ask the client at stage 9 and record their consent before publishing " +
            "cargo details and route.", 409, [{ field: "transportConsent" }]);
        }

        const profile = await c.query(
          `select company_name, description, services_offered, corridors_served, website,
                  fleet_size_declared, year_established
             from company_profiles where tenant_id = $1`, [req.user.tid]);
        if (!profile.rowCount || !profile.rows[0].company_name?.trim()) {
          throw new ApiError("CONFLICT",
            "Transporters see your company card, so complete your company profile first.",
            409, [{ field: "profile" }]);
        }

        if (body.contactUserId) {
          const inTenant = await c.query(
            `select 1 from users where id = $1 and tenant_id = $2
               and deleted_at is null and status = 'active' limit 1`,
            [body.contactUserId, req.user.tid]);
          if (!inTenant.rowCount) {
            throw new ApiError("VALIDATION_FAILED",
              "The named contact must be an active member of your company.", 400,
              [{ field: "contactUserId" }]);
          }
        }

        const need = new Date(`${body.requiredDate}T00:00:00`);
        const floor = new Date();
        floor.setHours(0, 0, 0, 0);
        floor.setDate(floor.getDate() - 7);
        if (Number.isNaN(need.getTime()) || need.getTime() < floor.getTime()) {
          throw new ApiError("VALIDATION_FAILED",
            "The required date must be today or later.", 400, [{ field: "requiredDate" }]);
        }

        // Re-check the submitted text, not the suggestion the preview offered.
        const published: PreviewFields = {
          cargoLabel: body.cargoLabel,
          containerType: body.containerType ?? null,
          containerCount: body.containerCount ?? null,
          weightTonnes: body.weightTonnes ?? null,
          cbm: body.cbm ?? null,
          vehicleTypes: body.vehicleTypes,
          routeId: body.routeId ?? null,
          routeLabel: null,
          distanceKm: null,
          expectedDurationHours: null,
          pickupText: body.pickupText,
          pickupRegionId: body.pickupRegionId ?? null,
          destText: body.destText,
          destRegionId: body.destRegionId ?? null,
          viaLabel: body.viaLabel ?? null,
          requiredDate: body.requiredDate,
          contactUserId: body.contactUserId ?? null,
          contactName: body.contactName,
          contactChannel: body.contactChannel,
          publicNote: body.publicNote ?? null
        };
        const warnings = disclosureWarnings(
          published, [job.consignee_name, job.consignor_name]);
        if (warnings.length && !body.acknowledgeWarnings) {
          throw new ApiError("CONFLICT",
            "What you are publishing looks like it exposes private details. " +
            "Reword it, or confirm you have checked it.", 409,
            warnings.map((message) => ({ field: "publicText", message })));
        }

        const route = await copyRoute(c, req.user.tid, body.routeId ?? null);
        const p = profile.rows[0];

        try {
          await c.query(
          // No `status` here: migration 048 revoked INSERT on that column, so
          // the database default 'open' is the only way a request can start.
          `insert into transport_requests (id, tenant_id, job_id, shipment_id,
             cargo_label, container_type, container_count, weight_tonnes, cbm, vehicle_types,
             route_id, route_label, distance_km, expected_duration_hours,
             pickup_text, pickup_region_id, dest_text, dest_region_id, via_label, required_date,
             contact_user_id, contact_name, contact_channel, public_note,
             company_name, company_description, company_services, company_corridors,
             company_website, fleet_size_declared, year_established,
             disclosed_by, disclosed_at, created_by, updated_by)
           values ($1,$2,$3,$4,
             $5,$6,$7,$8,$9,$10::text[],
             $11,$12,$13,$14,
             $15,$16,$17,$18,$19,$20::date,
             $21,$22,$23,$24,
             $25,$26,$27,$28,$29,$30,$31,
             $32,now(),$32,$32)`,
          [requestId, req.user.tid, id, job.shipment_id,
           body.cargoLabel, body.containerType ?? null, body.containerCount ?? null,
           body.weightTonnes ?? null, body.cbm ?? null, body.vehicleTypes,
           route?.route_id ?? null, route?.route_label ?? null, route?.distance_km ?? null,
           route?.expected_duration_hours ?? null,
           body.pickupText, body.pickupRegionId ?? null, body.destText,
           body.destRegionId ?? route?.dest_region_id ?? null, body.viaLabel ?? null,
           body.requiredDate,
           body.contactUserId ?? null, body.contactName, body.contactChannel,
           body.publicNote ?? null,
           p.company_name, p.description, p.services_offered, p.corridors_served,
           p.website, p.fleet_size_declared, p.year_established,
           req.user.sub]);
        } catch (e: any) {
          // transport_requests_one_live_job_uq: the database, not a read-then-write,
          // decides who gets the one live request on a job.
          if (e?.code === "23505") {
            throw new ApiError("CONFLICT",
              "This job is already on the notice board. Withdraw that request first.", 409,
              [{ field: "jobId" }]);
          }
          throw e;
        }

        await logActivity(c, {
          tenantId: req.user.tid, jobId: id, shipmentId: job.shipment_id,
          actorUserId: req.user.sub, actorRole: actorRole(req),
          action: "transport.published",
          summary: `Transport request published — ${body.pickupText} to ${body.destText}, ` +
            `needed ${body.requiredDate}`,
          entity: "transport_requests", entityId: requestId,
          meta: { route: route?.route_label ?? null, contactName: body.contactName,
            acknowledgedWarnings: warnings.length > 0 }
        });
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
          ip: req.ip, requestId: req.requestId, entity: "transport_requests", entityId: requestId,
          action: "transport.published",
          after: { jobId: id, pickup: body.pickupText, destination: body.destText,
            requiredDate: body.requiredDate, contactName: body.contactName,
            warningsAcknowledged: warnings.length > 0 ? warnings : undefined }
        });

        return { id: requestId, warnings };
      });

      // Realtime. The card is re-read through the same allowlisted door a
      // transporter would use, so a push can never carry more than a poll can.
      const card = await getBoardCard(out.id);
      if (card) emitBoard({ type: "request.published", card, at: new Date().toISOString() });

      return reply.status(201).send(out);
    });

  // ---------- CFA's own requests ----------
  app.get("/transport-requests", { preHandler: [requireAuth, requirePermission("transport.view")] },
    async (req: any) => {
      const q = listSchema.parse(req.query);
      const term = q.search ? `%${q.search}%` : null;
      return withTenant(req.user.tid, (c) => c.query(
        `select t.id, t.status, t.cargo_label, t.pickup_text, t.dest_text, t.via_label,
                t.distance_km, t.expected_duration_hours, t.vehicle_types, t.container_type,
                t.container_count, t.weight_tonnes, t.cbm, t.required_date::text as required_date,
                t.contact_name, t.contact_channel, t.company_name, t.route_label, t.disclosed_at,
                t.booked_company_name, t.booked_contact_name, t.booked_contact_channel,
                t.booked_company_description, t.booked_company_services, t.booked_company_corridors,
                t.booked_company_website, t.booked_fleet_size, t.booked_year_established,
                t.booked_licence_no, t.booked_licence_expiry::text as booked_licence_expiry,
                t.temp_booked_at, t.reminder_sent_at, t.released_at, t.confirmed_at,
                t.job_id, t.shipment_id, s.file_number, s.shipment_type,
                j.status as job_status, j.transport_consent
           from transport_requests t
           join jobs j on j.id = t.job_id and j.tenant_id = t.tenant_id
           join cargo_shipments s on s.id = t.shipment_id and s.tenant_id = t.tenant_id
          where t.tenant_id = $1 and t.deleted_at is null
            and ($2::text is null or t.status = $2)
            and ($4::uuid is null or t.job_id = $4)
            and ($3::text is null or t.cargo_label ilike $3 or t.pickup_text ilike $3
                 or t.dest_text ilike $3 or s.file_number ilike $3)
          order by (t.status = 'open') desc, t.required_date, t.created_at desc
          limit 300`,
        [req.user.tid, q.status ?? null, term, q.jobId ?? null])).then((r) => r.rows);
    });

  app.get("/transport-requests/:id",
    { preHandler: [requireAuth, requirePermission("transport.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const t = await c.query(
          `select t.*, t.required_date::text as required_date, t.disclosed_at,
                  s.file_number, s.shipment_type, j.status as job_status,
                  j.transport_consent, j.transport_needed
             from transport_requests t
             join jobs j on j.id = t.job_id and j.tenant_id = t.tenant_id
             join cargo_shipments s on s.id = t.shipment_id and s.tenant_id = t.tenant_id
            where t.id = $1 and t.tenant_id = $2 and t.deleted_at is null`,
          [id, req.user.tid]);
        if (!t.rowCount) throw new ApiError("NOT_FOUND", "Transport request not found", 404);
        return t.rows[0];
      });
    });

  // ---------- Cancel an open request (open → cancelled, via the state machine) ----------
  app.post("/transport-requests/:id/cancel",
    { preHandler: [requireAuth, requirePermission("transport.cancel")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const out = await withTenant(req.user.tid, async (c) => {
        const r = (await c.query(
          `select transport_withdraw_request($1,$2,$3) as r`,
          [id, req.user.tid, req.user.sub])).rows[0].r;
        if (r.ok && !r.already) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
            ip: req.ip, requestId: req.requestId, entity: "transport_requests", entityId: id,
            action: "transport.cancelled", before: { status: "open" },
            after: { status: "cancelled" }
          });
        }
        return r;
      });
      if (!out.ok) {
        if (out.reason === "missing") {
          throw new ApiError("NOT_FOUND", "Transport request not found", 404);
        }
        throw new ApiError("CONFLICT",
          "Only an open request can be cancelled. Once a transporter has engaged, " +
          "handle it from the booking.", 409);
      }

      // Watchers lose the card. Only the id travels — nothing about why, or who.
      if (!out.already) emitBoard({ type: "request.withdrawn", id, at: new Date().toISOString() });
      return reply.send({ ok: true });
    });

  // ---------- The publisher's side of a booking: confirm / decline / cancel ----------

  app.post("/transport-requests/:id/confirm",
    { preHandler: [requireAuth, requirePermission("transport.confirm_booking")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const out = await withTenant(req.user.tid, async (c) => {
        const r = (await c.query(
          `select transport_confirm_booking($1,$2,$3) as r`,
          [id, req.user.tid, req.user.sub])).rows[0].r;
        if (r.ok) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
            ip: req.ip, requestId: req.requestId, entity: "transport_requests", entityId: id,
            action: "transport.booking_confirmed",
            after: { status: "confirmed", bookingId: r.bookingId, company: r.company }
          });
        }
        return r;
      });
      if (!out.ok) throw bookingConflict(out, "confirm");
      return reply.send({ ok: true, bookingId: out.bookingId });
    });

  app.post("/transport-requests/:id/reject",
    { preHandler: [requireAuth, requirePermission("transport.confirm_booking")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = optionalReason.parse(req.body ?? {});
      const out = await withTenant(req.user.tid, async (c) => {
        const r = (await c.query(
          `select transport_reject_booking($1,$2,$3,$4) as r`,
          [id, req.user.tid, req.user.sub, body.reason ?? null])).rows[0].r;
        if (r.ok) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
            ip: req.ip, requestId: req.requestId, entity: "transport_requests", entityId: id,
            action: "transport.booking_rejected",
            after: { status: "open", bookingId: r.bookingId, reason: body.reason ?? null }
          });
        }
        return r;
      });
      if (!out.ok) throw bookingConflict(out, "decline");
      // Back on the board, so watchers get the card again.
      const card = await getBoardCard(id);
      if (card) emitBoard({ type: "request.published", card, at: new Date().toISOString() });
      return reply.send({ ok: true });
    });

  app.post("/transport-requests/:id/cancel-booking",
    { preHandler: [requireAuth, requirePermission("transport.cancel_booking")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = cancelBookingSchema.parse(req.body);
      const out = await withTenant(req.user.tid, async (c) => {
        const r = (await c.query(
          `select transport_cancel_booking($1,$2,$3,$4) as r`,
          [id, req.user.tid, req.user.sub, body.reason])).rows[0].r;
        if (r.ok) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
            ip: req.ip, requestId: req.requestId, entity: "transport_requests", entityId: id,
            action: "transport.booking_cancelled",
            after: { status: "open", bookingId: r.bookingId, side: r.side, reason: body.reason }
          });
        }
        return r;
      });
      if (!out.ok) throw bookingConflict(out, "cancel");
      const card = await getBoardCard(id);
      if (card) emitBoard({ type: "request.published", card, at: new Date().toISOString() });
      return reply.send({ ok: true });
    });

  // ---------- The booking company's own records ----------

  app.get("/my-bookings",
    { preHandler: [requireAuth, requirePermission("board.book")] },
    async (req: any) => withTenant(req.user.tid, (c) => c.query(
      `select id, status, cargo_label, container_type, container_count, weight_tonnes, cbm,
              vehicle_types, route_label, distance_km, expected_duration_hours,
              pickup_text, dest_text, via_label, required_date::text as required_date,
              company_name, contact_name, contact_channel,
              temp_booked_at, reminder_sent_at, confirmed_at, ended_at, ended_reason,
              created_at
         from transport_bookings
        where tenant_id = $1 and deleted_at is null
        order by created_at desc limit 200`, [req.user.tid])).then((r) => r.rows));

  app.post("/bookings/:id/release",
    { preHandler: [requireAuth, requirePermission("board.book")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = optionalReason.parse(req.body ?? {});
      const out = await withTenant(req.user.tid, async (c) => {
        const b = await c.query(
          `select request_id from transport_bookings
            where id = $1 and tenant_id = $2 and deleted_at is null`, [id, req.user.tid]);
        if (!b.rowCount) return { ok: false, reason: "not_yours" } as any;
        const requestId = b.rows[0].request_id as string;
        const r = (await c.query(
          `select transport_release_booking($1,$2,$3,$4) as r`,
          [requestId, req.user.tid, req.user.sub, body.reason ?? null])).rows[0].r;
        if (r.ok) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
            ip: req.ip, requestId: req.requestId, entity: "transport_bookings", entityId: id,
            action: "board.booking_released",
            after: { status: "released", requestId, reason: body.reason ?? null }
          });
        }
        return { ...r, requestId } as any;
      });
      if (!out.ok) {
        if (out.reason === "not_yours" || out.reason === "missing") {
          throw new ApiError("NOT_FOUND", "Booking not found", 404);
        }
        throw bookingConflict(out, "release");
      }
      // The load is back on the board.
      const card = await getBoardCard(out.requestId);
      if (card) emitBoard({ type: "request.published", card, at: new Date().toISOString() });
      return reply.send({ ok: true });
    });

  // The booker cancelling a booking that was already confirmed — same
  // transition as the publisher's, reason required, but from their own row.
  app.post("/bookings/:id/cancel-booking",
    { preHandler: [requireAuth, requirePermission("board.book")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = cancelBookingSchema.parse(req.body);
      const out = await withTenant(req.user.tid, async (c) => {
        const b = await c.query(
          `select request_id from transport_bookings
            where id = $1 and tenant_id = $2 and deleted_at is null`, [id, req.user.tid]);
        if (!b.rowCount) return { ok: false, reason: "not_yours" } as any;
        const requestId = b.rows[0].request_id as string;
        const r = (await c.query(
          `select transport_cancel_booking($1,$2,$3,$4) as r`,
          [requestId, req.user.tid, req.user.sub, body.reason])).rows[0].r;
        if (r.ok) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
            ip: req.ip, requestId: req.requestId, entity: "transport_bookings", entityId: id,
            action: "board.booking_cancelled",
            after: { status: "cancelled", requestId, side: r.side, reason: body.reason }
          });
        }
        return { ...r, requestId } as any;
      });
      if (!out.ok) {
        if (out.reason === "not_yours" || out.reason === "missing") {
          throw new ApiError("NOT_FOUND", "Booking not found", 404);
        }
        throw bookingConflict(out, "cancel");
      }
      const card = await getBoardCard(out.requestId);
      if (card) emitBoard({ type: "request.published", card, at: new Date().toISOString() });
      return reply.send({ ok: true });
    });
}
