import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { writeAudit } from "../audit/audit.js";
import { requirePermission, checkPermission } from "../security/permissions.js";
import { inCorridorBox, insertPosition } from "../operations/fleet.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const TRIAL_VESSEL_LIMIT = 3; // decision #1: trial tenants capped at 3 vessels

const vesselSchema = z.object({
  name: z.string().trim().min(1).max(80),
  vesselType: z.enum(["truck_head","trailer","tanker","flatbed","tipper","reefer","box_truck","van","pickup","lowbed","barge","boat","rail_wagon","cargo_ship","ferry","tank_barge"]),
  plateNumber: z.string().trim().min(3).max(20),
  chassisVin: z.string().max(60).optional(),
  engineNumber: z.string().max(60).optional(),
  make: z.string().max(40).optional(),
  model: z.string().max(40).optional(),
  yearManufactured: z.number().int().min(1950).max(2100).optional(),
  capacityTonnes: z.number().nonnegative().optional(),
  capacityM3: z.number().nonnegative().optional(),
  capacityTeu: z.number().int().nonnegative().optional(),
  grossWeightKg: z.number().nonnegative().optional(),
  lengthM: z.number().nonnegative().optional(),
  widthM: z.number().nonnegative().optional(),
  heightM: z.number().nonnegative().optional(),
  fuelType: z.enum(["diesel","petrol","cng","lng","electric","hydrogen","hybrid"]).default("diesel"),
  odometerKm: z.number().int().nonnegative().default(0),
  insurancePolicy: z.string().max(60).optional(),
  insuranceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  inspectionExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  roadLicenceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  branchId: z.string().uuid().nullable().optional(),
  imoNumber: z.string().max(30).optional(),
  homePort: z.string().max(80).optional(),
  waterBody: z.enum(["lake_victoria","lake_tanganyika","lake_nyasa","indian_ocean","river"]).optional()
});

const statusSchema = z.object({
  status: z.enum(["on_route","standby","booked","in_garage","out_of_service"]),
  statusReason: z.string().max(200).optional()
});

const assignSchema = z.object({
  driverId: z.string().uuid(),
  startOdometerKm: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(500).nullable().optional()
});

const endAssignSchema = z.object({
  endOdometerKm: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(500).nullable().optional()
});

// A report may describe the recent past ("he phoned from Malade at 06:00"); the window the
// platform believes is the one a trail is still worth reading as a trail.
const REPORT_WINDOW_DAYS = 30;
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{3})?(Z|[+-]\d{2}:\d{2})?$/;

const positionSchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  // device = this browser's own fix; manual = someone's word for where the truck is.
  // trip_departure / trip_arrival are written by the platform and refused here.
  source: z.enum(["device", "manual"]),
  accuracyM: z.number().int().nonnegative().nullable().optional(),
  odometerKm: z.number().int().nonnegative().nullable().optional(),
  note: z.string().max(300).nullable().optional(),
  recordedAt: z.string().regex(isoInstant).nullable().optional()
});

const logEntrySchema = z.object({
  kind: z.enum(["note", "odometer", "service", "inspection", "paperwork", "movement", "damage"]),
  title: z.string().trim().min(2).max(140),
  detail: z.string().max(2000).nullable().optional(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  odometerKm: z.number().int().nonnegative().nullable().optional(),
  actorName: z.string().max(80).nullable().optional()
});

/** Older than this, and a position is history, not "where it is" — the map says so. */
const STALE_AFTER_SECONDS = 6 * 3600;

/** The reading a plate's odometer may not go backwards past, in either register. */
function regressionError(stored: number, given: number, whose: string) {
  return new ApiError("ODOMETER_REGRESSION",
    `${whose} reads ${given.toLocaleString()} km but this vessel is already recorded at `
    + `${stored.toLocaleString()} km. An odometer does not run backwards — if the stored `
    + `figure is wrong, correct it on the vessel record.`,
    409);
}

export async function fleetRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- List (with trial counter) ----------
  app.get("/vessels", { preHandler: [requireAuth] }, async (req: any) => {
    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select v.*, b.name as branch_name,
              -- A pg DATE column JSON-serialises through UTC, so east of Greenwich it arrives
              -- as the day before. The paper a clerk reads has to be the day it was written
              -- on, so the plain day travels beside the shifted value.
              to_char(v.insurance_expiry, 'YYYY-MM-DD') as insurance_expiry_day,
              to_char(v.inspection_expiry, 'YYYY-MM-DD') as inspection_expiry_day,
              to_char(v.road_licence_expiry, 'YYYY-MM-DD') as road_licence_expiry_day,
              (select t.reference from trips t
                where t.vessel_id = v.id and t.status in ('planned','in_transit')
                  and t.deleted_at is null
                order by t.created_at desc limit 1) as active_trip_reference,
              -- A lapsed paper and a paper lapsing next month are not one state. The first
              -- draft of this column answered 'expiring' for an insurance that died last
              -- year, which is the wrong direction to be wrong in.
              case
                when v.insurance_expiry < current_date
                  or v.inspection_expiry < current_date
                  or v.road_licence_expiry < current_date then 'expired'
                when v.insurance_expiry < current_date + 30
                  or v.inspection_expiry < current_date + 30
                  or v.road_licence_expiry < current_date + 30 then 'expiring'
                else 'ok'
              end as document_status,
              a.driver_id as current_driver_id,
              d.full_name as current_driver_name
       from vessels v
       left join branches b on b.id = v.branch_id
       -- The register, not drivers.assigned_vessel_id: an open row here is the only answer
       -- the database stands behind (092).
       left join vessel_assignments a on a.vessel_id = v.id and a.status = 'active'
         and a.deleted_at is null
       left join drivers d on d.id = a.driver_id and d.deleted_at is null
       where v.tenant_id = $1 and v.deleted_at is null
       order by v.created_at desc`, [req.user.tid]));

    const licence = await pool.query("select platform_auth.get_licence($1) as l", [req.user.tid]);
    const l = licence.rows[0]?.l ?? {};
    const isTrial = l.subscription_status === "trial" || l.tenant_status === "trial";

    return {
      vessels: rows,
      fleetLimit: isTrial ? TRIAL_VESSEL_LIMIT : null,
      fleetUsed: rows.length
    };
  });

  // ---------- Create (trial cap enforced server-side) ----------
  app.post("/vessels", { preHandler: [requireAuth, requirePermission("fleet.create")] }, async (req: any, reply) => {
    const body = vesselSchema.parse(req.body);

    const licence = await pool.query("select platform_auth.get_licence($1) as l", [req.user.tid]);
    const l = licence.rows[0]?.l ?? {};
    const isTrial = l.subscription_status === "trial" || l.tenant_status === "trial";

    if (isTrial) {
      const cnt = await withTenant(req.user.tid, (c) => c.query(
        "select count(*)::int as n from vessels where tenant_id=$1 and deleted_at is null",
        [req.user.tid]));
      if (cnt.rows[0].n >= TRIAL_VESSEL_LIMIT) {
        throw new ApiError("TRIAL_LIMIT",
          `Trial fleet is limited to ${TRIAL_VESSEL_LIMIT} vessels. Activate a licence for unlimited fleet.`,
          403);
      }
    }

    const dup = await withTenant(req.user.tid, (c) => c.query(
      "select id from vessels where tenant_id=$1 and plate_number=$2 and deleted_at is null",
      [req.user.tid, body.plateNumber]));
    if (dup.rowCount) throw new ApiError("CONFLICT", "A vessel with this plate number already exists.", 409);

    const id = uuidv7();
    await withTenant(req.user.tid, async (c) => {
      await c.query(
        `insert into vessels (id, tenant_id, branch_id, name, vessel_type, plate_number,
           chassis_vin, engine_number, make, model, year_manufactured,
           capacity_tonnes, capacity_m3, capacity_teu, fuel_type, odometer_km,
           insurance_policy, insurance_expiry, inspection_expiry, road_licence_expiry,
           imo_number, home_port, water_body,
           gross_weight_kg, length_m, width_m, height_m,
           status, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
           $21,$22,$23,$25,$26,$27,$28,'standby',$24,$24)`,
        [id, req.user.tid, body.branchId ?? null, body.name, body.vesselType,
         body.plateNumber, body.chassisVin ?? null, body.engineNumber ?? null,
         body.make ?? null, body.model ?? null, body.yearManufactured ?? null,
         body.capacityTonnes ?? null, body.capacityM3 ?? null, body.capacityTeu ?? null,
         body.fuelType, body.odometerKm,
         body.insurancePolicy ?? null, body.insuranceExpiry ?? null,
         body.inspectionExpiry ?? null, body.roadLicenceExpiry ?? null,
         body.imoNumber ?? null, body.homePort ?? null, body.waterBody ?? null,
         req.user.sub,
         body.grossWeightKg ?? null, body.lengthM ?? null,
         body.widthM ?? null, body.heightM ?? null]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "vessels", entityId: id,
        action: "vessel.created",
        after: { name: body.name, type: body.vesselType, plate: body.plateNumber,
                 waterBody: body.waterBody ?? null }
      });
    });
    return reply.status(201).send({ id });
  });

  // ---------- Update (presence-based): absent key keeps, explicit null clears ----------
  app.put("/vessels/:id", { preHandler: [requireAuth, requirePermission("fleet.edit")] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = vesselSchema.partial().parse(req.body);

    const prev = await withTenant(req.user.tid, (c) => c.query(
      "select status from vessels where id=$1 and tenant_id=$2 and deleted_at is null",
      [id, req.user.tid]));
    if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Vessel not found", 404);

    const sets: string[] = [];
    const params: unknown[] = [id, req.user.sub, req.user.tid]; // $1 id, $2 updated_by, $3 tenant_id
    const set = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if ("name" in body) set("name", body.name);
    if ("vesselType" in body) set("vessel_type", body.vesselType);
    if ("plateNumber" in body) set("plate_number", body.plateNumber);
    if ("chassisVin" in body) set("chassis_vin", body.chassisVin ?? null);
    if ("engineNumber" in body) set("engine_number", body.engineNumber ?? null);
    if ("make" in body) set("make", body.make ?? null);
    if ("model" in body) set("model", body.model ?? null);
    if ("yearManufactured" in body) set("year_manufactured", body.yearManufactured ?? null);
    if ("capacityTonnes" in body) set("capacity_tonnes", body.capacityTonnes ?? null);
    if ("capacityM3" in body) set("capacity_m3", body.capacityM3 ?? null);
    if ("capacityTeu" in body) set("capacity_teu", body.capacityTeu ?? null);
    if ("fuelType" in body) set("fuel_type", body.fuelType);
    if ("odometerKm" in body) set("odometer_km", body.odometerKm ?? 0);
    if ("insurancePolicy" in body) set("insurance_policy", body.insurancePolicy ?? null);
    if ("insuranceExpiry" in body) set("insurance_expiry", body.insuranceExpiry ?? null);
    if ("inspectionExpiry" in body) set("inspection_expiry", body.inspectionExpiry ?? null);
    if ("roadLicenceExpiry" in body) set("road_licence_expiry", body.roadLicenceExpiry ?? null);
    if ("branchId" in body) set("branch_id", body.branchId ?? null);
    if ("imoNumber" in body) set("imo_number", body.imoNumber ?? null);
    if ("homePort" in body) set("home_port", body.homePort ?? null);
    if ("waterBody" in body) set("water_body", body.waterBody ?? null);
    if ("grossWeightKg" in body) set("gross_weight_kg", body.grossWeightKg ?? null);
    if ("lengthM" in body) set("length_m", body.lengthM ?? null);
    if ("widthM" in body) set("width_m", body.widthM ?? null);
    if ("heightM" in body) set("height_m", body.heightM ?? null);

    await withTenant(req.user.tid, async (c) => {
      if (sets.length) {
        await c.query(
          `update vessels set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          params);
      }
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "vessels", entityId: id,
        action: "vessel.updated", after: { ...body }
      });
    });
    return reply.send({ ok: true });
  });

  // ---------- Status change: DEDICATED endpoint (spec 6.3, static SQL) ----------
  app.put("/vessels/:id/status", { preHandler: [requireAuth, requirePermission("fleet.edit")] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = statusSchema.parse(req.body);

    const prev = await withTenant(req.user.tid, (c) => c.query(
      "select status from vessels where id=$1 and tenant_id=$2 and deleted_at is null",
      [id, req.user.tid]));
    if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Vessel not found", 404);

    if (body.status === prev.rows[0].status) {
      return reply.send({ ok: true, unchanged: true });
    }

    await withTenant(req.user.tid, async (c) => {
      await c.query(
        `update vessels set
           status = $2, status_reason = $3, updated_by = $4, updated_at = now()
         where id = $1 and tenant_id = $5 and deleted_at is null`,
        [id, body.status, body.statusReason ?? null, req.user.sub, req.user.tid]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        requestId: req.requestId, entity: "vessels", entityId: id,
        action: "vessel.status_changed",
        before: { status: prev.rows[0].status },
        after: { status: body.status, reason: body.statusReason ?? null }
      });
    });
    return reply.send({ ok: true });
  });

  app.delete("/vessels/:id", { preHandler: [requireAuth, requirePermission("fleet.delete")] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const r = await withTenant(req.user.tid, async (c) => {
      const res = await c.query(
        `update vessels set deleted_at = now(), updated_by = $2
         where id = $1 and tenant_id = $3 and deleted_at is null`,
        [id, req.user.sub, req.user.tid]);
      if (res.rowCount) {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "vessels", entityId: id,
          action: "vessel.deleted"
        });
      }
      return res;
    });
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "Vessel not found", 404);
    return reply.send({ ok: true });
  });

  // ==================================================================
  // WHO HOLDS IT — the assignment register (092)
  // ==================================================================
  //
  // `drivers.assigned_vessel_id` stays as the projection the drivers page and the trip
  // double-booking guard already read; this register is what says who holds a vehicle, since
  // when, at what reading, and on whose authority. The two open-row unique indexes in 092 are
  // the real guard — the checks below exist to return a sentence instead of a constraint
  // violation.

  app.post("/vessels/:id/assignments",
    { preHandler: [requireAuth, requirePermission("fleet.edit")] }, async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = assignSchema.parse(req.body);

      const aid = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        const vessel = await c.query(
          `select name, plate_number, odometer_km from vessels
            where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!vessel.rowCount) throw new ApiError("NOT_FOUND", "Vessel not found", 404);

        const driver = await c.query(
          `select full_name, status from drivers
            where id = $1 and tenant_id = $2 and deleted_at is null`,
          [body.driverId, req.user.tid]);
        if (!driver.rowCount) throw new ApiError("NOT_FOUND", "Driver not found", 404);
        if (driver.rows[0].status === "suspended") {
          throw new ApiError("ASSIGNMENT_DRIVER_SUSPENDED",
            `${driver.rows[0].full_name} is suspended. Lift the suspension before handing `
            + `over a vehicle.`, 409);
        }

        const onTruck = await c.query(
          `select d.full_name from vessel_assignments a
            join drivers d on d.id = a.driver_id
           where a.tenant_id = $1 and a.vessel_id = $2 and a.status = 'active'
             and a.deleted_at is null`,
          [req.user.tid, id]);
        if (onTruck.rowCount) {
          throw new ApiError("ASSIGNMENT_VESSEL_TAKEN",
            `${vessel.rows[0].name} (${vessel.rows[0].plate_number}) is already in the hands `
            + `of ${onTruck.rows[0].full_name}. End that assignment first.`, 409);
        }

        const onDriver = await c.query(
          `select v.name, v.plate_number from vessel_assignments a
            join vessels v on v.id = a.vessel_id
           where a.tenant_id = $1 and a.driver_id = $2 and a.status = 'active'
             and a.deleted_at is null`,
          [req.user.tid, body.driverId]);
        if (onDriver.rowCount) {
          throw new ApiError("ASSIGNMENT_DRIVER_BUSY",
            `${driver.rows[0].full_name} already holds ${onDriver.rows[0].name} `
            + `(${onDriver.rows[0].plate_number}). One vehicle per driver.`, 409);
        }

        const start = body.startOdometerKm ?? null;
        if (start != null && start < vessel.rows[0].odometer_km) {
          throw regressionError(vessel.rows[0].odometer_km, start,
            "The handover reading");
        }

        try {
          await c.query(
            `insert into vessel_assignments (id, tenant_id, vessel_id, driver_id, status,
                                              start_odometer_km, notes, assigned_by, created_by)
             values ($1,$2,$3,$4,'active',$5,$6,$7,$7)`,
            [aid, req.user.tid, id, body.driverId, start, body.notes ?? null, req.user.sub]);
        } catch (e: any) {
          if (e?.code === "23505") {
            throw new ApiError("ASSIGNMENT_TAKEN",
              "That driver or vehicle was claimed in the same moment by someone else. "
              + "Reload the register before trying again.", 409);
          }
          throw e;
        }

        await c.query(
          `update drivers set assigned_vessel_id = $2, updated_by = $3, updated_at = now()
            where id = $1 and tenant_id = $4 and deleted_at is null`,
          [body.driverId, id, req.user.sub, req.user.tid]);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.requestId, entity: "vessel_assignments", entityId: aid,
          action: "vessel.assigned",
          after: {
            vessel_id: id, vessel: `${vessel.rows[0].name} ${vessel.rows[0].plate_number}`,
            driver_id: body.driverId, driver: driver.rows[0].full_name,
            start_odometer_km: start
          }
        });
      });
      return reply.status(201).send({ id: aid });
    });

  app.post("/vessels/:id/assignments/:aid/end",
    { preHandler: [requireAuth, requirePermission("fleet.edit")] }, async (req: any, reply) => {
      const { id, aid } = req.params as { id: string; aid: string };
      const body = endAssignSchema.parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const open = await c.query(
          `select a.status, a.driver_id, a.start_odometer_km, d.full_name
             from vessel_assignments a
             join drivers d on d.id = a.driver_id
            where a.id = $1 and a.vessel_id = $2 and a.tenant_id = $3
              and a.deleted_at is null`,
          [aid, id, req.user.tid]);
        if (!open.rowCount) throw new ApiError("NOT_FOUND", "Assignment not found", 404);
        if (open.rows[0].status !== "active") {
          throw new ApiError("ASSIGNMENT_ALREADY_ENDED",
            `That handover was already closed. The register keeps it as history.`, 409);
        }

        const vessel = await c.query(
          `select name, odometer_km from vessels
            where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        const stored = Number(vessel.rows[0]?.odometer_km ?? 0);
        const end = body.endOdometerKm ?? null;
        const start = open.rows[0].start_odometer_km;
        if (end != null && start != null && end < start) {
          throw new ApiError("ODOMETER_REGRESSION",
            `The return reading (${end.toLocaleString()} km) is below the handover reading `
            + `(${Number(start).toLocaleString()} km) for this handover. An odometer does not `
            + `run backwards.`, 409);
        }
        if (end != null && end < stored) {
          throw regressionError(stored, end, "The return reading");
        }

        await c.query(
          `update vessel_assignments
              set status = 'ended', ended_at = now(), end_odometer_km = $2,
                  notes = coalesce($3, notes), ended_by = $4, updated_by = $4, updated_at = now()
            where id = $1 and tenant_id = $5 and deleted_at is null`,
          [aid, end, body.notes ?? null, req.user.sub, req.user.tid]);

        // The scalar points here only while this very row is the reason it does; a later
        // assignment to another truck must not be wiped by closing an old one.
        await c.query(
          `update drivers set assigned_vessel_id = null, updated_by = $3, updated_at = now()
            where id = $1 and tenant_id = $2 and assigned_vessel_id = $4 and deleted_at is null`,
          [open.rows[0].driver_id, req.user.tid, req.user.sub, id]);

        // The truck came back with a higher reading than the one on its record: that is the
        // fleet's number, so the fleet takes it.
        let odometerMoved = false;
        if (end != null && end > stored) {
          const r = await c.query(
            `update vessels set odometer_km = $2, updated_by = $3, updated_at = now()
              where id = $1 and tenant_id = $4 and deleted_at is null and odometer_km < $2`,
            [id, end, req.user.sub, req.user.tid]);
          odometerMoved = !!r.rowCount;
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.requestId, entity: "vessel_assignments", entityId: aid,
          action: "vessel.assignment_ended",
          before: { driver: open.rows[0].full_name, status: "active" },
          after: {
            status: "ended", driver_id: open.rows[0].driver_id, end_odometer_km: end,
            km_this_handover: end != null && start != null ? end - Number(start) : null,
            vessel_odometer_updated: odometerMoved
          }
        });
      });
      return reply.send({ ok: true });
    });

  // ==================================================================
  // WHERE IT IS — the position ledger (092)
  // ==================================================================
  //
  // Reports, not telemetry. No row in this table claims to come from a device the platform
  // cannot see, and every read carries the age of the fix so no screen can present a
  // three-day-old word as a current position.

  app.post("/vessels/:id/positions",
    { preHandler: [requireAuth, requirePermission("tracking.create")] }, async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = positionSchema.parse(req.body);

      if (!Number.isFinite(body.lat) || !Number.isFinite(body.lng)) {
        throw new ApiError("POSITION_INCOMPLETE",
          "A position needs a usable latitude and longitude.", 400);
      }
      if (!inCorridorBox(body.lat, body.lng)) {
        throw new ApiError("POSITION_OUT_OF_RANGE",
          "That is outside the southern and east African corridors this platform plans, so it "
          + "cannot be where the vehicle is. Check the coordinates before filing them.", 400);
      }

      let recordedAt: string | null = null;
      if (body.recordedAt) {
        const when = new Date(body.recordedAt);
        if (Number.isNaN(when.getTime())) {
          throw new ApiError("POSITION_TIME_INVALID", "That report time is not a real instant.", 400);
        }
        const skew = when.getTime() - Date.now();
        if (skew > 10 * 60 * 1000) {
          throw new ApiError("POSITION_IN_FUTURE",
            "A report cannot describe a position that has not happened yet.", 400);
        }
        if (skew < -REPORT_WINDOW_DAYS * 86400_000) {
          throw new ApiError("POSITION_TOO_OLD",
            `Reports older than ${REPORT_WINDOW_DAYS} days belong in the logbook, not in the `
            + `live position trail.`, 400);
        }
        recordedAt = when.toISOString();
      }

      const pid = await withTenant(req.user.tid, async (c) => {
        const vessel = await c.query(
          `select v.name, v.plate_number, v.odometer_km, a.driver_id
             from vessels v
             left join vessel_assignments a on a.vessel_id = v.id
               and a.status = 'active' and a.deleted_at is null
            where v.id = $1 and v.tenant_id = $2 and v.deleted_at is null`,
          [id, req.user.tid]);
        if (!vessel.rowCount) throw new ApiError("NOT_FOUND", "Vessel not found", 404);

        const newId = await insertPosition(c, {
          tenantId: req.user.tid,
          vesselId: id,
          lat: body.lat,
          lng: body.lng,
          source: body.source,
          driverId: vessel.rows[0].driver_id ?? null,
          accuracyM: body.accuracyM ?? null,
          odometerKm: body.odometerKm ?? null,
          note: body.note ?? null,
          recordedAt,
          recordedBy: req.user.sub
        });

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "vessel_positions", entityId: newId,
          action: "vessel.position_recorded",
          after: {
            vessel: `${vessel.rows[0].name} ${vessel.rows[0].plate_number}`,
            lat: body.lat, lng: body.lng, source: body.source,
            odometer_km: body.odometerKm ?? null
          }
        });
        return newId;
      });
      return reply.status(201).send({ id: pid });
    });

  // The trail is the tracking duty's own data: the dossier and the fleet map both withhold it
  // from a seat that cannot see tracking, so this raw read has to answer the same question or
  // the duty would be a suggestion. A driver seat holds tracking.create and not tracking.view —
  // it reports where the truck is, and does not read the fleet's whole trail.
  app.get("/vessels/:id/positions",
    { preHandler: [requireAuth, requirePermission("tracking.view")] }, async (req: any) => {
    const { id } = req.params as { id: string };
    const limit = Math.min(Math.max(Number(req.query?.limit ?? 50) || 50, 1), 200);
    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select p.id, p.lat, p.lng, p.source, p.accuracy_m, p.odometer_km, p.note,
              p.recorded_at, p.trip_id, t.reference as trip_reference,
              extract(epoch from (now() - p.recorded_at))::int as age_seconds
         from vessel_positions p
         left join trips t on t.id = p.trip_id
        where p.vessel_id = $1 and p.tenant_id = $2
        order by p.recorded_at desc
        limit $3`,
      [id, req.user.tid, limit]));
    return { positions: rows, staleAfterSeconds: STALE_AFTER_SECONDS };
  });

  // One line per vehicle — including the ones nobody has ever reported, because a fleet map
  // that shows only the located trucks hides the ones a dispatcher most needs to ask about.
  app.get("/tracking/fleet", { preHandler: [requireAuth] }, async (req: any) => {
    const wantPositions = await withTenant(req.user.tid, (c) =>
      checkPermission(c, req.user.sub, "tracking.view"));
    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select v.id, v.name, v.plate_number, v.vessel_type, v.status, v.odometer_km,
              ${wantPositions ? `p.lat, p.lng, p.source, p.note, p.recorded_at, p.trip_id,
                       extract(epoch from (now() - p.recorded_at))::int as age_seconds,` : ""}
              d.full_name as driver_name,
              (select coalesce(t.reference, t.id::text) from trips t
                where t.vessel_id = v.id and t.status in ('planned','in_transit')
                  and t.deleted_at is null
                order by t.created_at desc limit 1) as trip_reference
         from vessels v
         left join vessel_assignments a on a.vessel_id = v.id
           and a.status = 'active' and a.deleted_at is null
         left join drivers d on d.id = a.driver_id and d.deleted_at is null
         ${wantPositions ? `left join lateral (
             select x.lat, x.lng, x.source, x.note, x.recorded_at, x.trip_id
               from vessel_positions x
              where x.vessel_id = v.id
              order by x.recorded_at desc limit 1) p on true` : ""}
        where v.tenant_id = $1 and v.deleted_at is null
        order by v.name`, [req.user.tid]));

    return {
      located: wantPositions,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      vessels: rows.map((x: any) => x.age_seconds == null ? x : {
        ...x,
        stale: Number(x.age_seconds) > STALE_AFTER_SECONDS
      })
    };
  });

  // ==================================================================
  // WHAT HAS HAPPENED TO IT — the per-plate logbook (092)
  // ==================================================================

  app.post("/vessels/:id/logbook",
    { preHandler: [requireAuth, requirePermission("fleet.create")] }, async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = logEntrySchema.parse(req.body);

      if (body.entryDate && body.entryDate > new Date().toISOString().slice(0, 10)) {
        throw new ApiError("LOG_DATE_FUTURE",
          "A logbook entry cannot be dated in the future — it has not happened yet.", 400);
      }

      const lid = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        const vessel = await c.query(
          `select name, plate_number, odometer_km from vessels
            where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!vessel.rowCount) throw new ApiError("NOT_FOUND", "Vessel not found", 404);

        const stored = Number(vessel.rows[0].odometer_km ?? 0);
        const reading = body.odometerKm ?? null;
        if (body.kind === "odometer" && reading == null) {
          throw new ApiError("LOG_ODOMETER_REQUIRED",
            "An odometer entry has to carry the reading — that is the fact being recorded.", 400);
        }
        if (reading != null && reading < stored) {
          throw regressionError(stored, reading, "That reading");
        }

        await c.query(
          `insert into vessel_log_entries (id, tenant_id, vessel_id, entry_date, kind, title,
                                           detail, odometer_km, actor_name, created_by, updated_by)
           values ($1,$2,$3, coalesce($4::date, current_date), $5,$6,$7,$8,$9,$10,$10)`,
          [lid, req.user.tid, id, body.entryDate ?? null, body.kind, body.title,
           body.detail ?? null, reading, body.actorName ?? null, req.user.sub]);

        // A forward reading *is* the vehicle's reading, so the record and the register agree.
        let odometerMoved = false;
        if (reading != null && reading > stored) {
          const r = await c.query(
            `update vessels set odometer_km = $2, updated_by = $3, updated_at = now()
              where id = $1 and tenant_id = $4 and deleted_at is null and odometer_km < $2`,
            [id, reading, req.user.sub, req.user.tid]);
          odometerMoved = !!r.rowCount;
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "vessel_log_entries", entityId: lid,
          action: "vessel.logged",
          after: {
            vessel: `${vessel.rows[0].name} ${vessel.rows[0].plate_number}`,
            kind: body.kind, title: body.title, odometer_km: reading,
            vessel_odometer_updated: odometerMoved
          }
        });
      });
      return reply.status(201).send({ id: lid });
    });

  // Retired, never erased: 041 took hard delete away from every register like this one, and a
  // logbook whose wrong line can vanish is a logbook nobody can rely on. The hint the page
  // gives is the rule — append a correcting entry.
  app.delete("/vessels/:id/logbook/:eid",
    { preHandler: [requireAuth, requirePermission("fleet.delete")] }, async (req: any, reply) => {
      const { id, eid } = req.params as { id: string; eid: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update vessel_log_entries set deleted_at = now(), updated_by = $3
            where id = $1 and vessel_id = $2 and tenant_id = $4 and deleted_at is null
            returning kind, title`,
          [eid, id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "vessel_log_entries", entityId: eid,
            action: "vessel.log_retired",
            before: { ...res.rows[0] }
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Logbook entry not found", 404);
      return reply.send({ ok: true });
    });

  // ==================================================================
  // ONE PLATE, EVERY REGISTER — the dossier
  // ==================================================================
  //
  // A fleet manager opens a plate to answer one question at three in the morning: what has
  // this vehicle done, to whom, where was it last seen, and what is wrong with it. That is
  // six screens today. One read assembles them, and the position block only appears for a
  // seat that actually holds the tracking duty — the rest of the dossier is fleet data the
  // fleet page has always shown.

  app.get("/vessels/:id/dossier", { preHandler: [requireAuth] }, async (req: any) => {
    const { id } = req.params as { id: string };
    return withTenant(req.user.tid, async (c) => {
      const tid = req.user.tid;
      const vessel = await c.query(
        `select v.*, b.name as branch_name,
                to_char(v.insurance_expiry, 'YYYY-MM-DD') as insurance_expiry_day,
                to_char(v.inspection_expiry, 'YYYY-MM-DD') as inspection_expiry_day,
                to_char(v.road_licence_expiry, 'YYYY-MM-DD') as road_licence_expiry_day,
                case
                  when v.insurance_expiry < current_date or v.inspection_expiry < current_date
                    or v.road_licence_expiry < current_date then 'expired'
                  when v.insurance_expiry < current_date + 30
                    or v.inspection_expiry < current_date + 30
                    or v.road_licence_expiry < current_date + 30 then 'expiring'
                  else 'ok'
                end as document_status
           from vessels v
           left join branches b on b.id = v.branch_id
          where v.id = $1 and v.tenant_id = $2 and v.deleted_at is null`,
        [id, tid]);
      if (!vessel.rowCount) throw new ApiError("NOT_FOUND", "Vessel not found", 404);

      const assignments = await c.query(
        `select a.id, a.status, a.started_at, a.ended_at, a.start_odometer_km,
                a.end_odometer_km, a.notes, d.full_name as driver_name, d.id as driver_id
           from vessel_assignments a
           join drivers d on d.id = a.driver_id
          where a.vessel_id = $1 and a.tenant_id = $2 and a.deleted_at is null
          order by a.started_at desc
          limit 30`, [id, tid]);

      const maySeePositions = await checkPermission(c, req.user.sub, "tracking.view");
      const positions = maySeePositions ? await c.query(
        `select p.id, p.lat, p.lng, p.source, p.accuracy_m, p.odometer_km, p.note,
                p.recorded_at, p.trip_id, t.reference as trip_reference,
                extract(epoch from (now() - p.recorded_at))::int as age_seconds
           from vessel_positions p
           left join trips t on t.id = p.trip_id
          where p.vessel_id = $1 and p.tenant_id = $2
          order by p.recorded_at desc
          limit 60`, [id, tid]) : null;

      const logbook = await c.query(
        `select id, to_char(entry_date, 'YYYY-MM-DD') as entry_date, kind, title, detail,
                odometer_km, actor_name, created_at
           from vessel_log_entries
          where vessel_id = $1 and tenant_id = $2 and deleted_at is null
          order by entry_date desc, created_at desc
          limit 80`, [id, tid]);

      const fuel = await c.query(
        `select id, to_char(log_date, 'YYYY-MM-DD') as log_date, litres, price_per_litre,
                total_cost, odometer_km, station, notes
           from fuel_logs
          where vessel_id = $1 and tenant_id = $2 and deleted_at is null
          order by log_date desc limit 15`, [id, tid]);
      const fuelTotals = await c.query(
        `select count(*)::int as entries, coalesce(sum(litres),0)::text as litres,
                coalesce(sum(total_cost),0)::text as cost
           from fuel_logs
          where vessel_id = $1 and tenant_id = $2 and deleted_at is null`, [id, tid]);

      const incidents = await c.query(
        `select id, to_char(incident_date, 'YYYY-MM-DD') as incident_date, type, severity,
                location, description, status
           from incidents
          where vessel_id = $1 and tenant_id = $2 and deleted_at is null
          order by incident_date desc limit 15`, [id, tid]);

      const documents = await c.query(
        `select id, kind, file_name, mime_type, size_bytes, created_at
           from documents
          where entity_type = 'vessel' and entity_id = $1 and tenant_id = $2
            and deleted_at is null
          order by created_at desc limit 30`, [id, tid]);

      const trips = await c.query(
        `select t.id, coalesce(t.reference, t.id::text) as reference, t.status,
                t.planned_departure, t.actual_departure, t.actual_arrival, t.distance_km,
                r.name as route_name, d.full_name as driver_name
           from trips t
           join routes r on r.id = t.route_id
           left join drivers d on d.id = t.driver_id
          where t.vessel_id = $1 and t.tenant_id = $2 and t.deleted_at is null
          order by coalesce(t.actual_departure, t.planned_departure, t.created_at) desc
          limit 15`, [id, tid]);

      const open = assignments.rows.filter((x: any) => x.status === "active");
      return {
        vessel: vessel.rows[0],
        assignment: { current: open[0] ?? null, history: assignments.rows },
        // No block at all, rather than an empty one, when the seat cannot see tracking: the
        // page reads its absence as "this duty has no tracking", not "this truck has no fixes".
        position: maySeePositions ? {
          latest: positions!.rows[0] ?? null,
          trail: positions!.rows,
          staleAfterSeconds: STALE_AFTER_SECONDS
        } : null,
        logbook: logbook.rows,
        // Named apart on purpose: the totals row carries its own `entries` count, and a
        // spread over the logs array would silently replace it with a number.
        fuel: { logs: fuel.rows, totals: fuelTotals.rows[0] },
        incidents: incidents.rows,
        documents: documents.rows,
        trips: trips.rows
      };
    });
  });
}