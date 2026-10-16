import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { writeAudit } from "../audit/audit.js";
import { requirePermission } from "../security/permissions.js";

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

export async function fleetRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- List (with trial counter) ----------
  app.get("/vessels", { preHandler: [requireAuth] }, async (req: any) => {
    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select v.*, b.name as branch_name,
              (select t.reference from trips t
                where t.vessel_id = v.id and t.status in ('planned','in_transit')
                  and t.deleted_at is null
                order by t.created_at desc limit 1) as active_trip_reference,
              case
                when v.insurance_expiry is not null and v.insurance_expiry < current_date + 30 then 'expiring'
                when v.inspection_expiry is not null and v.inspection_expiry < current_date + 30 then 'expiring'
                when v.road_licence_expiry is not null and v.road_licence_expiry < current_date + 30 then 'expiring'
                else 'ok'
              end as document_status
       from vessels v
       left join branches b on b.id = v.branch_id
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
}