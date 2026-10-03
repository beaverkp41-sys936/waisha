import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { encryptField, searchHash } from "../util/crypto.js";
import { verifyAccessToken } from "../security/jwt.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const driverSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  nida: z.string().regex(/^\d{20}$/).optional(),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bloodGroup: z.enum(["A+","A-","B+","B-","AB+","AB-","O+","O-"]).optional(),
  licenceClass: z.string().max(20).optional(),
  licenceNumber: z.string().max(40).optional(),
  licenceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  defensiveDrivingCert: z.boolean().optional(),
  dangerousGoodsCert: z.boolean().optional(),
  assignedVesselId: z.string().uuid().nullable().optional(),
  status: z.enum(["available","on_trip","on_leave","suspended"]).optional(),
  address: z.string().max(200).optional(),
  nextOfKin: z.string().max(120).optional(),
  nextOfKinPhone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  notes: z.string().max(500).optional(),
  branchId: z.string().uuid().nullable().optional()
});

export async function driversRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- List (with licence expiry flags) ----------
  app.get("/drivers", { preHandler: [requireAuth] }, async (req: any) => {
    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select d.id, d.full_name, d.licence_class, d.licence_number, d.licence_expiry,
              d.status, d.blood_group, d.date_of_birth, d.defensive_driving_cert,
              d.dangerous_goods_cert, d.address, d.next_of_kin, d.notes,
              d.assigned_vessel_id, v.name as vessel_name, b.name as branch_name,
              case
                when d.licence_expiry is not null and d.licence_expiry < current_date + 30 then 'expiring'
                when d.licence_expiry is not null and d.licence_expiry < current_date then 'expired'
                else 'ok'
              end as licence_status
       from drivers d
       left join vessels v on v.id = d.assigned_vessel_id
       left join branches b on b.id = d.branch_id
       where d.tenant_id = $1 and d.deleted_at is null
       order by d.full_name`, [req.user.tid]));
    return rows;
  });

  // ---------- Create ----------
  app.post("/drivers", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const body = driverSchema.parse(req.body);
    const nidaSearch = body.nida ? searchHash(body.nida) : null;

    if (nidaSearch) {
      const dup = await withTenant(req.user.tid, (c) => c.query(
        "select id from drivers where tenant_id=$1 and nida_search=$2 and deleted_at is null",
        [req.user.tid, nidaSearch]));
      if (dup.rowCount) throw new ApiError("CONFLICT", "A driver with this NIDA already exists.", 409);
    }

    const id = uuidv7();
    await withTenant(req.user.tid, async (c) => {
      await c.query(
        `insert into drivers (id, tenant_id, branch_id, full_name,
           nida_encrypted, nida_search, phone_encrypted, phone_search,
           date_of_birth, blood_group, licence_class, licence_number, licence_expiry,
           defensive_driving_cert, dangerous_goods_cert, assigned_vessel_id,
           status, address, next_of_kin, next_of_kin_phone_encrypted,
           notes, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [id, req.user.tid, body.branchId ?? null, body.fullName,
         body.nida ? encryptField(body.nida) : null, nidaSearch,
         encryptField(body.phone), searchHash(body.phone),
         body.dateOfBirth ?? null, body.bloodGroup ?? null,
         body.licenceClass ?? null, body.licenceNumber ?? null, body.licenceExpiry ?? null,
         body.defensiveDrivingCert ?? false, body.dangerousGoodsCert ?? false,
         body.assignedVesselId ?? null,
         body.status ?? "available", body.address ?? null, body.nextOfKin ?? null,
         body.nextOfKinPhone ? encryptField(body.nextOfKinPhone) : null,
         body.notes ?? null, req.user.sub, req.user.sub]);
    });
    return reply.status(201).send({ id });
  });

  // ---------- Update ----------
  app.put("/drivers/:id", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = driverSchema.partial().parse(req.body);

    const existing = await withTenant(req.user.tid, (c) => c.query(
      "select nida_search, phone_search, next_of_kin_phone_encrypted from drivers where id=$1 and tenant_id=$2 and deleted_at is null",
      [id, req.user.tid]));
    if (!existing.rowCount) throw new ApiError("NOT_FOUND", "Driver not found", 404);
    const prev = existing.rows[0];

    await withTenant(req.user.tid, async (c) => {
      await c.query(
        `update drivers set
           full_name = coalesce($2, full_name),
           nida_encrypted = case when $3::text is not null then $4 else nida_encrypted end,
           nida_search = case when $3::text is not null then $5 else nida_search end,
           phone_encrypted = case when $6::text is not null then $7 else phone_encrypted end,
           phone_search = case when $6::text is not null then $8 else phone_search end,
           date_of_birth = coalesce($9, date_of_birth),
           blood_group = coalesce($10, blood_group),
           licence_class = coalesce($11, licence_class),
           licence_number = coalesce($12, licence_number),
           licence_expiry = coalesce($13, licence_expiry),
           defensive_driving_cert = coalesce($14, defensive_driving_cert),
           dangerous_goods_cert = coalesce($15, dangerous_goods_cert),
           assigned_vessel_id = coalesce($16, assigned_vessel_id),
           status = coalesce($17, status),
           address = coalesce($18, address),
           next_of_kin = coalesce($19, next_of_kin),
           next_of_kin_phone_encrypted = case when $20::text is not null then $21 else next_of_kin_phone_encrypted end,
           notes = coalesce($22, notes),
           updated_by = $23, updated_at = now()
         where id = $1 and tenant_id = $24 and deleted_at is null`,
        [id,
         body.fullName ?? null,
         body.nida ?? null, body.nida ? encryptField(body.nida) : null,
         body.nida ? searchHash(body.nida) : null,
         body.phone ?? null, body.phone ? encryptField(body.phone) : null,
         body.phone ? searchHash(body.phone) : null,
         body.dateOfBirth ?? null, body.bloodGroup ?? null,
         body.licenceClass ?? null, body.licenceNumber ?? null, body.licenceExpiry ?? null,
         body.defensiveDrivingCert ?? null, body.dangerousGoodsCert ?? null,
         body.assignedVesselId !== undefined ? body.assignedVesselId : null,
         body.status ?? null, body.address ?? null, body.nextOfKin ?? null,
         body.nextOfKinPhone ?? null,
         body.nextOfKinPhone ? encryptField(body.nextOfKinPhone) : null,
         body.notes ?? null, req.user.sub, req.user.tid]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "drivers", entityId: id,
        action: "driver.updated", after: { name: body.fullName ?? null, status: body.status ?? null }
      });
    });
    return reply.send({ ok: true });
  });

  // ---------- Delete ----------
  app.delete("/drivers/:id", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const r = await withTenant(req.user.tid, async (c) => {
      const res = await c.query(
        `update drivers set deleted_at = now(), updated_by = $2
         where id = $1 and tenant_id = $3 and deleted_at is null`,
        [id, req.user.sub, req.user.tid]);
      if (res.rowCount) {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "drivers", entityId: id,
          action: "driver.deleted"
        });
      }
      return res;
    });
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "Driver not found", 404);
    return reply.send({ ok: true });
  });
}