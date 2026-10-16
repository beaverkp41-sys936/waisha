import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { encryptField, searchHash } from "../util/crypto.js";
import { verifyAccessToken } from "../security/jwt.js";
import { writeAudit } from "../audit/audit.js";
import { requirePermission } from "../security/permissions.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const branchSchema = z.object({
  kind: z.enum(["hq", "sub_hq", "branch"]),
  name: z.string().trim().min(2).max(80),
  regionId: z.number().int().positive().nullable().optional(),
  districtId: z.number().int().positive().nullable().optional(),
  wardId: z.number().int().positive().nullable().optional(),
  wardFreetext: z.string().max(80).optional(),
  street: z.string().max(120).optional(),
  postalAddress: z.string().max(120).optional(),
  gpsLat: z.number().min(-90).max(90).nullable().optional(),
  gpsLng: z.number().min(-180).max(180).nullable().optional(),
  contactPerson: z.string().max(80).optional(),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  email: z.string().email().optional(),
  operatingHours: z.string().max(120).optional()
});

/** Resolve a wardId to its official name for persistence. */
async function wardNameOf(wardId: number | null | undefined): Promise<string | null> {
  if (!wardId) return null;
  const w = await pool.query("select name from geo_wards where id = $1", [wardId]);
  return w.rows[0]?.name ?? null;
}

export async function profileRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Geography cascades ----------
  app.get("/geo/regions", { preHandler: [requireAuth] }, async () => {
    const { rows } = await pool.query(
      "select id, code, name_en, name_sw from geo_regions where is_active = true order by name_en");
    return rows;
  });

  app.get("/geo/districts/:regionId", { preHandler: [requireAuth] }, async (req: any) => {
    const { regionId } = req.params as { regionId: string };
    const { rows } = await pool.query(
      "select id, name_en, name_sw from geo_districts where region_id = $1 and is_active = true order by name_en",
      [Number(regionId)]);
    return rows;
  });

  app.get("/geo/wards/:districtId", { preHandler: [requireAuth] }, async (req: any) => {
    const { districtId } = req.params as { districtId: string };
    const { rows } = await pool.query(
      "select id, name from geo_wards where district_id = $1 order by name",
      [Number(districtId)]);
    return rows;
  });

  // ---------- Company profile ----------
  app.get("/profile", { preHandler: [requireAuth] }, async (req: any) => {
    const p = await withTenant(req.user.tid, (c) => c.query(
      "select * from company_profiles where tenant_id = $1", [req.user.tid]));
    if (p.rowCount) return p.rows[0];
    const t = await withTenant(req.user.tid, (c) => c.query(
      "select name from tenants where id = $1", [req.user.tid]));
    return { tenant_id: req.user.tid, company_name: t.rows[0]?.name ?? "", isNew: true };
  });

  app.put("/profile", { preHandler: [requireAuth, requirePermission("profile.edit")] }, async (req: any, reply) => {
    const body = z.object({
      companyName: z.string().trim().min(2).max(120),
      brelaNumber: z.string().max(60).optional(),
      vatNumber: z.string().max(60).optional(),
      transportLicenceNo: z.string().max(60).optional(),
      transportLicenceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      yearEstablished: z.number().int().min(1900).max(2100).optional(),
      fleetSizeDeclared: z.number().int().min(0).max(100000).optional(),
      servicesOffered: z.string().max(500).optional(),
      corridorsServed: z.string().max(300).optional(),
      description: z.string().max(2000).optional(),
      website: z.string().url().max(200).optional(),
      companyCode: z.string().trim().regex(/^[A-Za-z]{3}$/, "Company code must be exactly 3 letters").nullable().optional(),
      payBankName: z.string().max(120).nullable().optional(),
      payBankAccount: z.string().max(60).nullable().optional(),
      payAccountName: z.string().max(120).nullable().optional(),
      payMobileMoney: z.string().max(160).nullable().optional()
    }).parse(req.body);

    await withTenant(req.user.tid, async (c) => {
      await c.query(
        `insert into company_profiles (tenant_id, company_name, brela_number, vat_number,
           transport_licence_no, transport_licence_expiry, year_established,
           fleet_size_declared, services_offered, corridors_served, description,
           website, pay_bank_name, pay_bank_account, pay_account_name, pay_mobile_money,
           company_code, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         on conflict (tenant_id) do update set
           company_name = excluded.company_name,
           brela_number = excluded.brela_number,
           vat_number = excluded.vat_number,
           transport_licence_no = excluded.transport_licence_no,
           transport_licence_expiry = excluded.transport_licence_expiry,
           year_established = excluded.year_established,
           fleet_size_declared = excluded.fleet_size_declared,
           services_offered = excluded.services_offered,
           corridors_served = excluded.corridors_served,
           description = excluded.description,
           website = excluded.website,
           pay_bank_name = excluded.pay_bank_name,
           pay_bank_account = excluded.pay_bank_account,
           pay_account_name = excluded.pay_account_name,
           pay_mobile_money = excluded.pay_mobile_money,
           company_code = excluded.company_code,
           updated_by = excluded.updated_by,
           updated_at = now()`,
        [req.user.tid, body.companyName, body.brelaNumber ?? null, body.vatNumber ?? null,
         body.transportLicenceNo ?? null, body.transportLicenceExpiry ?? null,
         body.yearEstablished ?? null, body.fleetSizeDeclared ?? null,
         body.servicesOffered ?? null, body.corridorsServed ?? null,
         body.description ?? null, body.website ?? null,
         body.payBankName ?? null, body.payBankAccount ?? null,
         body.payAccountName ?? null, body.payMobileMoney ?? null,
         body.companyCode ? body.companyCode.toUpperCase() : null, req.user.sub]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "company_profiles",
        entityId: req.user.tid, action: "profile.updated"
      });
    });
    return reply.send({ ok: true });
  });

  // ---------- Branches ----------
  app.get("/branches", { preHandler: [requireAuth] }, async (req: any) => {
    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select b.id, b.kind, b.name, b.region_id, b.district_id,
              b.district_freetext, b.ward, b.street, b.postal_address,
              b.gps_lat, b.gps_lng, b.contact_person, b.email, b.operating_hours,
              r.name_en as region_name, d.name_en as district_name,
              (b.phone_search is not null) as has_phone
       from branches b
       left join geo_regions r on r.id = b.region_id
       left join geo_districts d on d.id = b.district_id
       where b.tenant_id = $1 and b.deleted_at is null
       order by case b.kind when 'hq' then 0 when 'sub_hq' then 1 else 2 end, b.name`,
      [req.user.tid]));
    return rows;
  });

  app.post("/branches", { preHandler: [requireAuth, requirePermission("profile.create")] }, async (req: any, reply) => {
    const body = branchSchema.parse(req.body);
    if (body.kind === "hq") {
      const hq = await withTenant(req.user.tid, (c) => c.query(
        "select id from branches where tenant_id=$1 and kind='hq' and deleted_at is null",
        [req.user.tid]));
      if (hq.rowCount) throw new ApiError("CONFLICT", "An HQ branch already exists. Edit it instead.", 409);
    }
    const wardName = await wardNameOf(body.wardId);
    const id = uuidv7();
    await withTenant(req.user.tid, async (c) => {
      await c.query(
        `insert into branches (id, tenant_id, kind, name, region_id, district_id,
           district_freetext, ward, street, postal_address, gps_lat, gps_lng,
           contact_person, phone_encrypted, phone_search, email, operating_hours,
           created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
        [id, req.user.tid, body.kind, body.name,
         body.regionId ?? null, body.districtId ?? null,
         body.districtId ? null : (body.wardFreetext ?? null),
         wardName ?? (body.districtId ? null : (body.wardFreetext ?? null)),
         body.street ?? null, body.postalAddress ?? null,
         body.gpsLat ?? null, body.gpsLng ?? null,
         body.contactPerson ?? null,
         body.phone ? encryptField(body.phone) : null,
         body.phone ? searchHash(body.phone) : null,
         body.email ?? null, body.operatingHours ?? null, req.user.sub]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "branches", entityId: id,
        action: "branch.created",
        after: { name: body.name, kind: body.kind, ward: wardName }
      });
    });
    return reply.status(201).send({ id, ward: wardName });
  });

  app.put("/branches/:id", { preHandler: [requireAuth, requirePermission("profile.edit")] }, async (req: any, reply) => {
    const body = branchSchema.parse(req.body);
    const { id } = req.params as { id: string };
    const wardName = await wardNameOf(body.wardId);
    const r = await withTenant(req.user.tid, async (c) => {
      const res = await c.query(
        `update branches set kind=$2, name=$3, region_id=$4, district_id=$5,
           district_freetext=$6, ward=$7, street=$8, postal_address=$9, gps_lat=$10,
           gps_lng=$11, contact_person=$12, phone_encrypted=$13, phone_search=$14,
           email=$15, operating_hours=$16, updated_by=$17, updated_at=now()
         where id=$1 and tenant_id=$17 and deleted_at is null
         returning id`, [id, body.kind, body.name,
          body.regionId ?? null, body.districtId ?? null,
          body.districtId ? null : (body.wardFreetext ?? null),
          wardName ?? (body.districtId ? null : (body.wardFreetext ?? null)),
          body.street ?? null, body.postalAddress ?? null,
          body.gpsLat ?? null, body.gpsLng ?? null,
          body.contactPerson ?? null,
          body.phone ? encryptField(body.phone) : null,
          body.phone ? searchHash(body.phone) : null,
          body.email ?? null, body.operatingHours ?? null, req.user.sub]);
      if (res.rowCount) {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "branches", entityId: id,
          action: "branch.updated", after: { name: body.name, kind: body.kind, ward: wardName }
        });
      }
      return res;
    });
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "Branch not found", 404);
    return reply.send({ ok: true, ward: wardName });
  });

  app.delete("/branches/:id", { preHandler: [requireAuth, requirePermission("profile.delete")] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const r = await withTenant(req.user.tid, async (c) => {
      const res = await c.query(
        `update branches set deleted_at = now(), updated_by = $2
         where id = $1 and tenant_id = $2 and deleted_at is null`,
        [id, req.user.sub]);
      if (res.rowCount) {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "branches", entityId: id,
          action: "branch.deleted"
        });
      }
      return res;
    });
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "Branch not found", 404);
    return reply.send({ ok: true });
  });
}