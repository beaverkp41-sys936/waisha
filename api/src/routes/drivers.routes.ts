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
  nida: z.string().regex(/^\d{20}$/).nullable().optional(),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  bloodGroup: z.enum(["A+","A-","B+","B-","AB+","AB-","O+","O-"]).nullable().optional(),
  licenceClass: z.string().max(20).nullable().optional(),
  licenceNumber: z.string().max(40).nullable().optional(),
  licenceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  defensiveDrivingCert: z.boolean().optional(),
  dangerousGoodsCert: z.boolean().optional(),
  assignedVesselId: z.string().uuid().nullable().optional(),
  status: z.enum(["available","on_trip","on_leave","suspended"]).optional(),
  address: z.string().max(200).nullable().optional(),
  nextOfKin: z.string().max(120).nullable().optional(),
  nextOfKinPhone: z.string().regex(/^\+[1-9]\d{7,14}$/).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  branchId: z.string().uuid().nullable().optional()
});

export async function driversRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- List (with licence expiry flags) ----------
  app.get("/drivers", { preHandler: [requireAuth] }, async (req: any) => {
    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select d.id, d.full_name, d.licence_class, d.licence_number, d.licence_expiry,
              d.status, d.blood_group, d.date_of_birth, d.defensive_driving_cert,
              d.dangerous_goods_cert, d.address, d.next_of_kin, d.notes,
              d.assigned_vessel_id, d.branch_id, v.name as vessel_name, b.name as branch_name,
              case
                when d.licence_expiry is not null and d.licence_expiry < current_date then 'expired'
                when d.licence_expiry is not null and d.licence_expiry < current_date + 30 then 'expiring'
                else 'ok'
              end as licence_status,
              (select t.reference from trips t
                where t.driver_id = d.id and t.status in ('planned','in_transit')
                  and t.deleted_at is null
                order by t.created_at desc limit 1) as active_trip_reference
       from drivers d
       left join vessels v on v.id = d.assigned_vessel_id
       left join branches b on b.id = d.branch_id
       where d.tenant_id = $1 and d.deleted_at is null
       order by d.full_name`, [req.user.tid]));    return rows;
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
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "drivers", entityId: id,
        action: "driver.created", after: { name: body.fullName }
      });
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

    const nidaSearch = body.nida ? searchHash(body.nida) : null;
    if (nidaSearch) {
      const dup = await withTenant(req.user.tid, (c) => c.query(
        "select id from drivers where tenant_id=$1 and nida_search=$2 and deleted_at is null and id<>$3",
        [req.user.tid, nidaSearch, id]));
      if (dup.rowCount) throw new ApiError("CONFLICT", "A driver with this NIDA already exists.", 409);
    }

    // Presence-based update: an absent key leaves the column untouched, a present
    // key (even null) sets it — so the portal can clear optional fields, e.g.
    // unassign a driver's vessel.
    const sets: string[] = [];
    const params: unknown[] = [id, req.user.sub, req.user.tid]; // $1 id, $2 updated_by, $3 tenant_id
    const set = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if ("fullName" in body) set("full_name", body.fullName);
    if ("nida" in body) {
      set("nida_encrypted", body.nida != null ? encryptField(body.nida) : null);
      set("nida_search", nidaSearch);
    }
    if ("phone" in body) {
      set("phone_encrypted", body.phone != null ? encryptField(body.phone) : null);
      set("phone_search", body.phone != null ? searchHash(body.phone) : null);
    }
    if ("dateOfBirth" in body) set("date_of_birth", body.dateOfBirth);
    if ("bloodGroup" in body) set("blood_group", body.bloodGroup);
    if ("licenceClass" in body) set("licence_class", body.licenceClass);
    if ("licenceNumber" in body) set("licence_number", body.licenceNumber);
    if ("licenceExpiry" in body) set("licence_expiry", body.licenceExpiry);
    if ("defensiveDrivingCert" in body) set("defensive_driving_cert", body.defensiveDrivingCert);
    if ("dangerousGoodsCert" in body) set("dangerous_goods_cert", body.dangerousGoodsCert);
    if ("assignedVesselId" in body) set("assigned_vessel_id", body.assignedVesselId ?? null);
    if ("status" in body) set("status", body.status);
    if ("address" in body) set("address", body.address);
    if ("nextOfKin" in body) set("next_of_kin", body.nextOfKin);
    if ("nextOfKinPhone" in body) {
      set("next_of_kin_phone_encrypted",
        body.nextOfKinPhone != null ? encryptField(body.nextOfKinPhone) : null);
    }
    if ("notes" in body) set("notes", body.notes);
    if ("branchId" in body) set("branch_id", body.branchId ?? null);

    await withTenant(req.user.tid, async (c) => {
      await c.query(
        `update drivers set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
         where id = $1 and tenant_id = $3 and deleted_at is null`,
        params);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "drivers", entityId: id,
        action: "driver.updated",
        before: { nida_search: prev.nida_search, phone_search: prev.phone_search },
        after: { name: body.fullName ?? null, status: body.status ?? null }
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