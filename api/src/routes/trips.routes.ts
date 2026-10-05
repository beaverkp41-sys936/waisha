import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { encryptField, searchHash } from "../util/crypto.js";
import { verifyAccessToken } from "../security/jwt.js";
import { writeAudit } from "../audit/audit.js";
import {
  TRIP_STATUSES,
  tripCanTransition,
  tripStampsFor
} from "../operations/trip-status.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const TRIAL_TRIP_LIMIT = 5;

const datetimeLocal = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{3})?Z?$/);

const tripSchema = z.object({
  reference: z.string().trim().max(60).nullable().optional(),
  routeId: z.string().uuid(),
  vesselId: z.string().uuid().nullable().optional(),
  driverId: z.string().uuid().nullable().optional(),
  plannedDeparture: datetimeLocal.nullable().optional(),
  plannedArrival: datetimeLocal.nullable().optional(),
  notes: z.string().max(1000).nullable().optional()
});

const tripStatusSchema = z.object({
  status: z.enum(TRIP_STATUSES)
});

const shipmentSchema = z.object({
  customerName: z.string().trim().min(2).max(120),
  customerPhone: z.string().regex(/^\+[1-9]\d{7,14}$/).nullable().optional(),
  goodsDescription: z.string().trim().max(300).nullable().optional(),
  packageCount: z.number().int().nonnegative().nullable().optional(),
  weightKg: z.number().nonnegative().nullable().optional(),
  freightCharge: z.number().nonnegative().nullable().optional(),
  notes: z.string().max(500).nullable().optional()
});

const logSchema = z.object({
  checkpointId: z.string().uuid().nullable().optional(),
  label: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(["weighbridge","border","toll","fuel","rest","town","custom"]).optional(),
  note: z.string().max(500).nullable().optional()
});

async function getLicence(tid: string) {
  const licence = await pool.query("select platform_auth.get_licence($1) as l", [tid]);
  return licence.rows[0]?.l ?? {};
}

/**
 * Double-booking guard: a vessel or driver can hold only one active trip
 * (planned or in transit). Returns the conflicting trip's label, or null.
 */
async function findResourceConflict(
  c: any,
  tid: string,
  col: "vessel_id" | "driver_id",
  resourceId: string,
  excludeTripId: string
) {
  const r = await c.query(
    `select coalesce(reference, id::text) as label from trips
     where tenant_id = $1 and ${col} = $2 and status in ('planned','in_transit')
       and deleted_at is null and id <> $3
     limit 1`,
    [tid, resourceId, excludeTripId]);
  return r.rows[0]?.label ?? null;
}

async function ownedOrNull(c: any, table: string, id: string, tid: string) {
  const r = await c.query(
    `select id from ${table} where id = $1 and tenant_id = $2 and deleted_at is null`,
    [id, tid]);
  return r.rowCount ? id : null;
}

export async function tripsRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- List (with trial counter) ----------
  app.get("/trips", { preHandler: [requireAuth] }, async (req: any) => {
    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select t.id, t.reference, t.status, t.route_id, t.vessel_id, t.driver_id,
              t.planned_departure, t.planned_arrival, t.actual_departure,
              t.actual_arrival, t.distance_km, t.notes, t.created_at,
              r.name as route_name, r.origin_text, r.dest_text,
              v.name as vessel_name, d.full_name as driver_name,
              (select count(*)::int from trip_shipments s
                where s.trip_id = t.id and s.deleted_at is null) as shipment_count,
              (select coalesce(sum(s.weight_kg), 0)::float8 from trip_shipments s
                where s.trip_id = t.id and s.deleted_at is null) as total_weight_kg,
              (select coalesce(sum(s.freight_charge), 0)::float8 from trip_shipments s
                where s.trip_id = t.id and s.deleted_at is null) as total_freight
       from trips t
       left join routes r on r.id = t.route_id
       left join vessels v on v.id = t.vessel_id
       left join drivers d on d.id = t.driver_id
       where t.tenant_id = $1 and t.deleted_at is null
       order by t.created_at desc`, [req.user.tid]));

    const l = await getLicence(req.user.tid);
    const isTrial = l.subscription_status === "trial" || l.tenant_status === "trial";

    return {
      trips: rows,
      tripLimit: isTrial ? TRIAL_TRIP_LIMIT : null,
      tripsUsed: rows.length
    };
  });

  // ---------- Create (trial cap, tenant-owned resources, double-booking) ----------
  app.post("/trips", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const body = tripSchema.parse(req.body);

    const l = await getLicence(req.user.tid);
    const isTrial = l.subscription_status === "trial" || l.tenant_status === "trial";
    if (isTrial) {
      const cnt = await withTenant(req.user.tid, (c) => c.query(
        "select count(*)::int as n from trips where tenant_id=$1 and deleted_at is null",
        [req.user.tid]));
      if (cnt.rows[0].n >= TRIAL_TRIP_LIMIT) {
        throw new ApiError("TRIAL_LIMIT",
          `Trial accounts are limited to ${TRIAL_TRIP_LIMIT} trips. Activate a licence for unlimited trips.`,
          403);
      }
    }

    const id = uuidv7();
    await withTenant(req.user.tid, async (c) => {
      const route = await c.query(
        "select id, distance_km from routes where id=$1 and tenant_id=$2 and deleted_at is null",
        [body.routeId, req.user.tid]);
      if (!route.rowCount) throw new ApiError("NOT_FOUND", "Route not found", 404);

      if (body.vesselId) {
        if (!(await ownedOrNull(c, "vessels", body.vesselId, req.user.tid)))
          throw new ApiError("NOT_FOUND", "Vessel not found", 404);
        const conflict = await findResourceConflict(c, req.user.tid, "vessel_id", body.vesselId, id);
        if (conflict) throw new ApiError("CONFLICT", `That vessel is already on trip ${conflict}.`, 409);
      }
      if (body.driverId) {
        if (!(await ownedOrNull(c, "drivers", body.driverId, req.user.tid)))
          throw new ApiError("NOT_FOUND", "Driver not found", 404);
        const conflict = await findResourceConflict(c, req.user.tid, "driver_id", body.driverId, id);
        if (conflict) throw new ApiError("CONFLICT", `That driver is already on trip ${conflict}.`, 409);
      }
      if (body.reference) {
        const dup = await c.query(
          "select id from trips where tenant_id=$1 and reference=$2 and deleted_at is null",
          [req.user.tid, body.reference]);
        if (dup.rowCount) throw new ApiError("CONFLICT", "A trip with this reference already exists.", 409);
      }

      await c.query(
        `insert into trips (id, tenant_id, reference, route_id, vessel_id, driver_id,
           planned_departure, planned_arrival, distance_km, notes, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [id, req.user.tid, body.reference ?? null, body.routeId,
         body.vesselId ?? null, body.driverId ?? null,
         body.plannedDeparture ?? null, body.plannedArrival ?? null,
         route.rows[0].distance_km ?? null, body.notes ?? null, req.user.sub]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "trips", entityId: id,
        action: "trip.created",
        after: { reference: body.reference ?? null, routeId: body.routeId,
                 status: "planned" }
      });
    });
    return reply.status(201).send({ id });
  });

  // ---------- Detail (route summary + shipments + checkpoint logs) ----------
  app.get("/trips/:id", { preHandler: [requireAuth] }, async (req: any) => {
    const { id } = req.params as { id: string };
    return withTenant(req.user.tid, async (c) => {
      const trip = await c.query(
        `select t.*, r.name as route_name, r.origin_text, r.dest_text,
                r.expected_duration_hours,
                rog.name_en as origin_region, rog.lat as origin_lat, rog.lng as origin_lng,
                rdg.name_en as dest_region, rdg.lat as dest_lat, rdg.lng as dest_lng,
                v.name as vessel_name, v.capacity_tonnes,
                d.full_name as driver_name
         from trips t
         join routes r on r.id = t.route_id
         left join geo_regions rog on rog.id = r.origin_region_id
         left join geo_regions rdg on rdg.id = r.dest_region_id
         left join vessels v on v.id = t.vessel_id
         left join drivers d on d.id = t.driver_id
         where t.id = $1 and t.tenant_id = $2 and t.deleted_at is null`,
        [id, req.user.tid]);
      if (!trip.rowCount) throw new ApiError("NOT_FOUND", "Trip not found", 404);

      const routeId = trip.rows[0].route_id;
      const [cps, shipments, logs] = await Promise.all([
        c.query(
          `select id, seq, kind, name from route_checkpoints
           where route_id = $1 and tenant_id = $2 order by seq`,
          [routeId, req.user.tid]),
        c.query(
          `select id, customer_name, goods_description, package_count,
                  weight_kg, freight_charge, notes, created_at
           from trip_shipments
           where trip_id = $1 and tenant_id = $2 and deleted_at is null
           order by created_at`,
          [id, req.user.tid]),
        c.query(
          `select id, route_checkpoint_id, label, kind, note, logged_at
           from trip_checkpoint_logs
           where trip_id = $1 and tenant_id = $2
           order by logged_at`,
          [id, req.user.tid])
      ]);

      return {
        ...trip.rows[0],
        checkpoints: cps.rows,
        shipments: shipments.rows,
        logs: logs.rows
      };
    });
  });

  // ---------- Update (presence-based) ----------
  app.put("/trips/:id", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = tripSchema.partial().parse(req.body);

    await withTenant(req.user.tid, async (c) => {
      const prev = await c.query(
        "select status, route_id from trips where id=$1 and tenant_id=$2 and deleted_at is null",
        [id, req.user.tid]);
      if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Trip not found", 404);
      const status = prev.rows[0].status;

      if (status === "completed" || status === "cancelled")
        throw new ApiError("CONFLICT", `A ${status} trip can no longer be edited.`, 409);
      if (status === "in_transit" &&
          ("routeId" in body || "vesselId" in body || "driverId" in body))
        throw new ApiError("CONFLICT",
          "Route, vessel or driver cannot change while the trip is in transit.", 409);

      const sets: string[] = [];
      const params: unknown[] = [id, req.user.sub, req.user.tid]; // $1 id, $2 updated_by, $3 tenant_id
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };

      if ("reference" in body && body.reference !== prev.rows[0].reference) {
        const dup = await c.query(
          "select id from trips where tenant_id=$1 and reference=$2 and deleted_at is null and id<>$3",
          [req.user.tid, body.reference, id]);
        if (dup.rowCount) throw new ApiError("CONFLICT", "A trip with this reference already exists.", 409);
      }
      if ("routeId" in body) {
        const route = await c.query(
          "select id, distance_km from routes where id=$1 and tenant_id=$2 and deleted_at is null",
          [body.routeId, req.user.tid]);
        if (!route.rowCount) throw new ApiError("NOT_FOUND", "Route not found", 404);
        set("route_id", body.routeId);
        set("distance_km", route.rows[0].distance_km ?? null); // re-snapshot with the route
      }
      if ("vesselId" in body && body.vesselId) {
        if (!(await ownedOrNull(c, "vessels", body.vesselId!, req.user.tid)))
          throw new ApiError("NOT_FOUND", "Vessel not found", 404);
        const conflict = await findResourceConflict(c, req.user.tid, "vessel_id", body.vesselId!, id);
        if (conflict) throw new ApiError("CONFLICT", `That vessel is already on trip ${conflict}.`, 409);
      }
      if ("driverId" in body && body.driverId) {
        if (!(await ownedOrNull(c, "drivers", body.driverId!, req.user.tid)))
          throw new ApiError("NOT_FOUND", "Driver not found", 404);
        const conflict = await findResourceConflict(c, req.user.tid, "driver_id", body.driverId!, id);
        if (conflict) throw new ApiError("CONFLICT", `That driver is already on trip ${conflict}.`, 409);
      }

      if ("reference" in body) set("reference", body.reference ?? null);
      if ("vesselId" in body) set("vessel_id", body.vesselId ?? null);
      if ("driverId" in body) set("driver_id", body.driverId ?? null);
      if ("plannedDeparture" in body) set("planned_departure", body.plannedDeparture ?? null);
      if ("plannedArrival" in body) set("planned_arrival", body.plannedArrival ?? null);
      if ("notes" in body) set("notes", body.notes ?? null);

      if (sets.length) {
        await c.query(
          `update trips set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          params);
      }
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "trips", entityId: id,
        action: "trip.updated",
        after: { reference: body.reference ?? null, status }
      });
    });
    return reply.send({ ok: true });
  });

  // ---------- Status change: enforced lifecycle ----------
  app.put("/trips/:id/status", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = tripStatusSchema.parse(req.body);

    await withTenant(req.user.tid, async (c) => {
      const prev = await c.query(
        "select status, reference, vessel_id, driver_id from trips where id=$1 and tenant_id=$2 and deleted_at is null",
        [id, req.user.tid]);
      if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Trip not found", 404);
      const from = prev.rows[0].status as (typeof TRIP_STATUSES)[number];

      if (body.status === from) return; // caller sees { ok: true }
      if (!tripCanTransition(from, body.status)) {
        throw new ApiError("CONFLICT", `A ${from.replace("_", " ")} trip cannot move to ${body.status.replace("_", " ")}.`, 409);
      }

      // Departing re-checks the double-booking guard (something may have
      // been planned after this trip was created).
      if (body.status === "in_transit") {
        if (prev.rows[0].vessel_id) {
          const conflict = await findResourceConflict(c, req.user.tid, "vessel_id", prev.rows[0].vessel_id, id);
          if (conflict) throw new ApiError("CONFLICT", `That vessel is already on trip ${conflict}.`, 409);
        }
        if (prev.rows[0].driver_id) {
          const conflict = await findResourceConflict(c, req.user.tid, "driver_id", prev.rows[0].driver_id, id);
          if (conflict) throw new ApiError("CONFLICT", `That driver is already on trip ${conflict}.`, 409);
        }
      }

      const stamps = tripStampsFor(body.status);
      await c.query(
        `update trips set
           status = $2,
           ${stamps.actualDeparture ? "actual_departure = now()," : ""}
           ${stamps.actualArrival ? "actual_arrival = now()," : ""}
           updated_by = $3, updated_at = now()
         where id = $1 and tenant_id = $4 and deleted_at is null`,
        [id, body.status, req.user.sub, req.user.tid]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        requestId: req.requestId, entity: "trips", entityId: id,
        action: "trip.status_changed",
        before: { status: from },
        after: { status: body.status }
      });
    });
    return reply.send({ ok: true });
  });

  // ---------- Delete (blocked while in transit) ----------
  app.delete("/trips/:id", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const r = await withTenant(req.user.tid, async (c) => {
      const prev = await c.query(
        "select status from trips where id=$1 and tenant_id=$2 and deleted_at is null",
        [id, req.user.tid]);
      if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Trip not found", 404);
      if (prev.rows[0].status === "in_transit")
        throw new ApiError("CONFLICT", "A trip in transit cannot be removed — mark it arrived or cancelled first.", 409);
      const res = await c.query(
        `update trips set deleted_at = now(), updated_by = $2
         where id = $1 and tenant_id = $3 and deleted_at is null`,
        [id, req.user.sub, req.user.tid]);
      if (res.rowCount) {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "trips", entityId: id,
          action: "trip.deleted"
        });
      }
      return res;
    });
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "Trip not found", 404);
    return reply.send({ ok: true });
  });

  // ---------- Shipments: add ----------
  app.post("/trips/:id/shipments", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = shipmentSchema.parse(req.body);

    const sid = uuidv7();
    await withTenant(req.user.tid, async (c) => {
      const trip = await c.query(
        "select status from trips where id=$1 and tenant_id=$2 and deleted_at is null",
        [id, req.user.tid]);
      if (!trip.rowCount) throw new ApiError("NOT_FOUND", "Trip not found", 404);
      if (trip.rows[0].status === "completed" || trip.rows[0].status === "cancelled")
        throw new ApiError("CONFLICT", `Cargo cannot be added to a ${trip.rows[0].status} trip.`, 409);

      await c.query(
        `insert into trip_shipments (id, tenant_id, trip_id, customer_name,
           customer_phone_encrypted, customer_phone_search, goods_description,
           package_count, weight_kg, freight_charge, notes, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [sid, req.user.tid, id, body.customerName,
         body.customerPhone ? encryptField(body.customerPhone) : null,
         body.customerPhone ? searchHash(body.customerPhone) : null,
         body.goodsDescription ?? null, body.packageCount ?? null,
         body.weightKg ?? null, body.freightCharge ?? null, body.notes ?? null,
         req.user.sub]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "trip_shipments", entityId: sid,
        action: "shipment.created",
        after: { tripId: id, customer: body.customerName, weightKg: body.weightKg ?? null }
      });
    });
    return reply.status(201).send({ id: sid });
  });

  // ---------- Shipments: update (presence-based, phone keeps stored when blank) ----------
  app.put("/trips/:id/shipments/:sid", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id, sid } = req.params as { id: string; sid: string };
    const body = shipmentSchema.partial().parse(req.body);

    await withTenant(req.user.tid, async (c) => {
      const trip = await c.query(
        "select status from trips where id=$1 and tenant_id=$2 and deleted_at is null",
        [id, req.user.tid]);
      if (!trip.rowCount) throw new ApiError("NOT_FOUND", "Trip not found", 404);
      if (trip.rows[0].status === "completed" || trip.rows[0].status === "cancelled")
        throw new ApiError("CONFLICT", `A ${trip.rows[0].status} trip can no longer be edited.`, 409);

      const prev = await c.query(
        "select customer_phone_search from trip_shipments where id=$1 and trip_id=$2 and tenant_id=$3 and deleted_at is null",
        [sid, id, req.user.tid]);
      if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Shipment not found", 404);

      const sets: string[] = [];
      const params: unknown[] = [sid, req.user.sub, req.user.tid]; // $1 sid, $2 updated_by, $3 tenant_id
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };

      if ("customerName" in body) set("customer_name", body.customerName);
      if ("customerPhone" in body) {
        set("customer_phone_encrypted",
          body.customerPhone != null ? encryptField(body.customerPhone) : null);
        set("customer_phone_search",
          body.customerPhone != null ? searchHash(body.customerPhone) : null);
      }
      if ("goodsDescription" in body) set("goods_description", body.goodsDescription);
      if ("packageCount" in body) set("package_count", body.packageCount);
      if ("weightKg" in body) set("weight_kg", body.weightKg);
      if ("freightCharge" in body) set("freight_charge", body.freightCharge);
      if ("notes" in body) set("notes", body.notes);

      if (sets.length) {
        await c.query(
          `update trip_shipments set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          params);
      }
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "trip_shipments", entityId: sid,
        action: "shipment.updated",
        before: { phone_search: prev.rows[0].customer_phone_search },
        after: { tripId: id, customer: body.customerName ?? null }
      });
    });
    return reply.send({ ok: true });
  });

  // ---------- Shipments: remove ----------
  app.delete("/trips/:id/shipments/:sid", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id, sid } = req.params as { id: string; sid: string };
    const r = await withTenant(req.user.tid, async (c) => {
      const trip = await c.query(
        "select status from trips where id=$1 and tenant_id=$2 and deleted_at is null",
        [id, req.user.tid]);
      if (!trip.rowCount) throw new ApiError("NOT_FOUND", "Trip not found", 404);
      if (trip.rows[0].status === "completed" || trip.rows[0].status === "cancelled")
        throw new ApiError("CONFLICT", `A ${trip.rows[0].status} trip can no longer be edited.`, 409);

      const res = await c.query(
        `update trip_shipments set deleted_at = now(), updated_by = $2
         where id = $1 and trip_id = $3 and tenant_id = $4 and deleted_at is null`,
        [sid, req.user.sub, id, req.user.tid]);
      if (res.rowCount) {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "trip_shipments", entityId: sid,
          action: "shipment.deleted", after: { tripId: id }
        });
      }
      return res;
    });
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "Shipment not found", 404);
    return reply.send({ ok: true });
  });

  // ---------- Checkpoint logs: append ----------
  app.post("/trips/:id/checkpoint-logs", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = logSchema.parse(req.body);

    const logId = uuidv7();
    await withTenant(req.user.tid, async (c) => {
      const trip = await c.query(
        "select status, route_id from trips where id=$1 and tenant_id=$2 and deleted_at is null",
        [id, req.user.tid]);
      if (!trip.rowCount) throw new ApiError("NOT_FOUND", "Trip not found", 404);
      if (trip.rows[0].status === "completed" || trip.rows[0].status === "cancelled")
        throw new ApiError("CONFLICT", `A ${trip.rows[0].status} trip cannot record new checkpoints.`, 409);

      let label = body.label ?? null;
      let kind = body.kind ?? "custom";
      let cpId: string | null = null;
      if (body.checkpointId) {
        const cp = await c.query(
          "select id, kind, name from route_checkpoints where id=$1 and route_id=$2 and tenant_id=$3",
          [body.checkpointId, trip.rows[0].route_id, req.user.tid]);
        if (!cp.rowCount) throw new ApiError("NOT_FOUND", "Checkpoint not found on this route", 404);
        cpId = cp.rows[0].id;
        label = cp.rows[0].name;
        kind = cp.rows[0].kind;
      }
      if (!label) throw new ApiError("VALIDATION_FAILED", "Pick a checkpoint or enter a label.", 400);

      await c.query(
        `insert into trip_checkpoint_logs (id, tenant_id, trip_id, route_checkpoint_id, label, kind, note, logged_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [logId, req.user.tid, id, cpId, label, kind, body.note ?? null, req.user.sub]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "trip_checkpoint_logs", entityId: logId,
        action: "checkpoint.logged",
        after: { tripId: id, label, kind }
      });
    });
    return reply.status(201).send({ id: logId });
  });

  // ---------- Checkpoint logs: remove (ledger correction) ----------
  app.delete("/trips/:id/checkpoint-logs/:logId", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id, logId } = req.params as { id: string; logId: string };
    const r = await withTenant(req.user.tid, async (c) => {
      const res = await c.query(
        "delete from trip_checkpoint_logs where id=$1 and trip_id=$2 and tenant_id=$3",
        [logId, id, req.user.tid]);
      if (res.rowCount) {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "trip_checkpoint_logs", entityId: logId,
          action: "checkpoint.log_removed", after: { tripId: id }
        });
      }
      return res;
    });
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "Checkpoint log not found", 404);
    return reply.send({ ok: true });
  });
}
