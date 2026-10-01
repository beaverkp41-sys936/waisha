import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const TRIAL_VESSEL_LIMIT = 3; // decision #1: trial tenants capped at 3 vessels

const vesselSchema = z.object({
  name: z.string().trim().min(1).max(80),
  vesselType: z.enum(["truck_head","trailer","tanker","flatbed","tipper","reefer","box_truck","van","pickup","lowbed","barge","boat","rail_wagon"]),
  plateNumber: z.string().trim().min(3).max(20),
  chassisVin: z.string().max(60).optional(),
  engineNumber: z.string().max(60).optional(),
  make: z.string().max(40).optional(),
  model: z.string().max(40).optional(),
  yearManufactured: z.number().int().min(1950).max(2100).optional(),
  capacityTonnes: z.number().nonnegative().optional(),
  capacityM3: z.number().nonnegative().optional(),
  capacityTeu: z.number().int().nonnegative().optional(),
  fuelType: z.enum(["diesel","petrol","cng","lng","electric","hydrogen","hybrid"]).default("diesel"),
  odometerKm: z.number().int().nonnegative().default(0),
  insurancePolicy: z.string().max(60).optional(),
  insuranceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  inspectionExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  roadLicenceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  branchId: z.string().uuid().nullable().optional()
});

export async function fleetRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- List (with trial counter) ----------
  app.get("/vessels", { preHandler: [requireAuth] }, async (req: any) => {
    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select v.*, b.name as branch_name,
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
  app.post("/vessels", { preHandler: [requireAuth] }, async (req: any, reply) => {
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
           status, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'standby',$21,$21)`,
        [id, req.user.tid, body.branchId ?? null, body.name, body.vesselType,
         body.plateNumber, body.chassisVin ?? null, body.engineNumber ?? null,
         body.make ?? null, body.model ?? null, body.yearManufactured ?? null,
         body.capacityTonnes ?? null, body.capacityM3 ?? null, body.capacityTeu ?? null,
         body.fuelType, body.odometerKm,
         body.insurancePolicy ?? null, body.insuranceExpiry ?? null,
         body.inspectionExpiry ?? null, body.roadLicenceExpiry ?? null,
         req.user.sub]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "vessels", entityId: id,
        action: "vessel.created",
        after: { name: body.name, type: body.vesselType, plate: body.plateNumber }
      });
    });
    return reply.status(201).send({ id });
  });

  // ---------- Update (incl. status with reason - spec 6.3) ----------
  app.put("/vessels/:id", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = vesselSchema.partial().parse(req.body);
    const statusReason = (req.body as any)?.statusReason as string | undefined;

    const prev = await withTenant(req.user.tid, (c) => c.query(
      "select status from vessels where id=$1 and tenant_id=$2 and deleted_at is null",
      [id, req.user.tid]));
    if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Vessel not found", 404);

    const sets: string[] = [];
    const vals: any[] = [id];
    const map: Record<string, string> = {
      name: "name", vesselType: "vessel_type", plateNumber: "plate_number",
      chassisVin: "chassis_vin", engineNumber: "engine_number",
      make: "make", model: "model", yearManufactured: "year_manufactured",
      capacityTonnes: "capacity_tonnes", capacityM3: "capacity_m3",
      capacityTeu: "capacity_teu", fuelType: "fuel_type", odometerKm: "odometer_km",
      insurancePolicy: "insurance_policy", insuranceExpiry: "insurance_expiry",
      inspectionExpiry: "inspection_expiry", roadLicenceExpiry: "road_licence_expiry",
      branchId: "branch_id", status: "status", statusReason: "status_reason"
    };
    for (const [k, col] of Object.entries(map)) {
      if ((body as any)[k] !== undefined) {
        vals.push((body as any)[k]);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    if (!sets.length) throw new ApiError("VALIDATION_FAILED", "Nothing to update", 400);
    vals.push(req.user.sub);
    sets.push(`updated_by = $${vals.length}`, `updated_at = now()`);

    await withTenant(req.user.tid, async (c) => {
      await c.query(`update vessels set ${sets.join(", ")} where id = $1`, vals);
      if (body.status && body.status !== prev.rows[0].status) {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "vessels", entityId: id,
          action: "vessel.status_changed",
          before: { status: prev.rows[0].status },
          after: { status: body.status, reason: statusReason ?? null }
        });
      } else {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "vessels", entityId: id,
          action: "vessel.updated", after: { ...body }
        });
      }
    });
    return reply.send({ ok: true });
  });

  app.delete("/vessels/:id", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const r = await withTenant(req.user.tid, async (c) => {
      const res = await c.query(
        `update vessels set deleted_at = now(), updated_by = $2
         where id = $1 and tenant_id = $2 and deleted_at is null`,
        [id, req.user.sub]);
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