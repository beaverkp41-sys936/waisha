import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { encryptField, searchHash, decryptField } from "../util/crypto.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

const MODES = ["road", "marine", "air", "rail"] as const;
type CarrierMode = typeof MODES[number];
// Mirrors vessels.vessel_type (017/018) plus the two air types, so the carrier
// register and the fleet table cannot drift into two vocabularies.
const UNIT_TYPES = [
  "truck_head", "trailer", "tanker", "flatbed", "tipper", "reefer", "box_truck",
  "van", "pickup", "lowbed", "barge", "boat", "cargo_ship", "ferry", "tank_barge",
  "rail_wagon", "air_freighter", "air_charter"
] as const;
/**
 * The register is one table for four modes of transport, so the mode has to be
 * checked against the unit type: without it a cargo ship can be filed as a
 * mainland truck and printed at the head of a road manifest.
 */
const UNIT_MODE: Record<typeof UNIT_TYPES[number], CarrierMode> = {
  truck_head: "road", trailer: "road", tanker: "road", flatbed: "road", tipper: "road",
  reefer: "road", box_truck: "road", van: "road", pickup: "road", lowbed: "road",
  barge: "marine", boat: "marine", cargo_ship: "marine", ferry: "marine", tank_barge: "marine",
  rail_wagon: "rail", air_freighter: "air", air_charter: "air"
};
function assertUnitMode(unitType: string, mode: string) {
  const want = UNIT_MODE[unitType as typeof UNIT_TYPES[number]];
  if (want === mode) return;
  throw new ApiError("VALIDATION_FAILED",
    `A ${unitType.replace(/_/g, " ")} is a ${want} unit, not a ${mode} one.`,
    400, [{ field: "unitType" }]);
}
const CAPACITY_UNITS = ["tonnes", "kg", "teu", "m3"] as const;
const SPECIALISATIONS = [
  "general", "dry_bulk", "liquid_bulk", "refrigerated", "hazardous", "live_animals"
] as const;
const MANIFEST_STATUSES = ["draft", "manifested", "in_transit", "delivered", "cancelled"] as const;
type ManifestStatus = typeof MANIFEST_STATUSES[number];
// A leg moves forward and the paper behind it closes. A cancelled manifest can
// be revived — clerks raise them in error — but nothing that has been delivered
// is re-opened, because its weight and freight are already on a signed note.
const MANIFEST_NEXT: Record<ManifestStatus, ManifestStatus[]> = {
  draft: ["manifested", "cancelled"],
  manifested: ["in_transit", "cancelled", "draft"],
  in_transit: ["delivered", "cancelled"],
  delivered: [],
  cancelled: ["draft"]
};
// Once the load has arrived, or the leg has been called off, its lines are
// evidence: the manifest can still be settled, but what rode on it is fixed.
const PARCEL_FROZEN: ManifestStatus[] = ["delivered", "cancelled"];
const CONTAINER_TYPES = ["20ft", "40ft", "loose_cargo", "car"] as const;

/** Money to 2 decimals — every amount passes through here. */
const money = (n: number) => Math.round(n * 100) / 100;
/** Weights and volumes to 3 — a parcel is weighed, not rounded to a cent. */
const qty = (n: number) => Math.round(n * 1000) / 1000;

const carrierSchema = z.object({
  mode: z.enum(MODES),
  unitType: z.enum(UNIT_TYPES),
  displayName: z.string().trim().min(2).max(160),
  operatorName: z.string().trim().max(160).nullable().optional(),
  registration: z.string().trim().max(60).nullable().optional(),
  vesselId: z.string().uuid().nullable().optional(),
  make: z.string().trim().max(80).nullable().optional(),
  model: z.string().trim().max(80).nullable().optional(),
  yearManufactured: z.number().int().min(1900).max(2100).nullable().optional(),
  capacityUnit: z.enum(CAPACITY_UNITS).default("tonnes"),
  capacityMax: z.number().nonnegative().max(1_000_000).nullable().optional(),
  specialisations: z.array(z.enum(SPECIALISATIONS)).max(SPECIALISATIONS.length).default([]),
  homeBase: z.string().trim().max(160).nullable().optional(),
  isActive: z.boolean().default(true),
  notes: z.string().trim().max(600).nullable().optional()
});

const geoEnd = z.object({
  regionId: z.number().int().positive().nullable().optional(),
  districtId: z.number().int().positive().nullable().optional(),
  wardId: z.number().int().positive().nullable().optional(),
  text: z.string().trim().max(240).nullable().optional()
});

const manifestSchema = z.object({
  carrierId: z.string().uuid(),
  origin: geoEnd.default({}),
  destination: geoEnd.default({}),
  routeId: z.string().uuid().nullable().optional(),
  shipmentId: z.string().uuid().nullable().optional(),
  billOfLading: z.string().trim().max(60).nullable().optional(),
  containerNo: z.string().trim().max(40).nullable().optional(),
  sealNo: z.string().trim().max(40).nullable().optional(),
  containerType: z.enum(CONTAINER_TYPES).nullable().optional(),
  departureDate: dateOnly.nullable().optional(),
  arrivalDate: dateOnly.nullable().optional(),
  currency: z.string().trim().min(3).max(8).default("TZS"),
  routingNotes: z.string().trim().max(1000).nullable().optional()
});

const parcelSchema = z.object({
  consignorName: z.string().trim().min(2).max(160),
  consignorPhone: e164.nullable().optional(),
  consignorEmail: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  consignorAddress: z.string().trim().max(300).nullable().optional(),
  goodsDescription: z.string().trim().min(2).max(300),
  packageCount: z.number().int().positive().max(1_000_000).default(1),
  packageKind: z.string().trim().max(60).nullable().optional(),
  marksNumbers: z.string().trim().max(120).nullable().optional(),
  netWeightKg: z.number().nonnegative().max(1_000_000).default(0),
  lengthM: z.number().nonnegative().max(10_000).nullable().optional(),
  widthM: z.number().nonnegative().max(10_000).nullable().optional(),
  heightM: z.number().nonnegative().max(10_000).nullable().optional(),
  specialisation: z.enum(SPECIALISATIONS).nullable().optional(),
  transportFee: z.number().nonnegative().max(1_000_000_000).default(0),
  notes: z.string().trim().max(600).nullable().optional()
});

const settleSchema = z.object({
  amountPaid: z.number().nonnegative().max(1_000_000_000),
  paymentReference: z.string().trim().max(60).nullable().optional(),
  paidAt: dateOnly.nullable().optional()
});

const CARRIER_SELECT = `
  select cc.id, cc.mode, cc.unit_type, cc.display_name, cc.operator_name, cc.registration,
         cc.vessel_id, cc.make, cc.model, cc.year_manufactured, cc.capacity_unit,
         cc.capacity_max, cc.specialisations, cc.home_base, cc.is_active, cc.notes,
         cc.created_at, cc.updated_at,
         (select count(*)::int from consolidations m
           where m.carrier_id = cc.id and m.deleted_at is null
             and m.status <> 'cancelled') as live_manifests
  from consolidation_carriers cc`;

// Whole statements, composed here rather than at the call site: the security
// scan fails any `.query()` line that interpolates SQL, and every value that
// reaches Postgres must travel as a bind parameter.
const CARRIER_ONE_SQL = `${CARRIER_SELECT}
  where cc.id = $1 and cc.tenant_id = $2 and cc.deleted_at is null`;

// The detail sheet resolves the unit a leg was carried on, and a retired unit
// must still print on the paper that named it — so no deleted_at filter here.
const CARRIER_BY_ID_SQL = `${CARRIER_SELECT}
  where cc.id = $1 and cc.tenant_id = $2`;

const MANIFEST_SELECT = `
  select m.id, m.manifest_number, m.status, m.carrier_id,
         m.origin_region_id, m.origin_district_id, m.origin_ward_id, m.origin_text,
         m.dest_region_id, m.dest_district_id, m.dest_ward_id, m.dest_text,
         m.route_id, m.shipment_id, m.bill_of_lading, m.container_no, m.seal_no,
         m.container_type, m.departure_date::text as departure_date,
         m.arrival_date::text as arrival_date,
         m.weight_on_board_kg, m.cbm_total, m.parcel_count, m.currency,
         m.transport_fee_total, m.amount_paid_total, m.routing_notes,
         m.created_at, m.updated_at,
         (m.transport_fee_total - m.amount_paid_total)::float8 as balance_due,
         cc.display_name as carrier_name, cc.mode as carrier_mode, cc.unit_type,
         cc.capacity_unit, cc.capacity_max, cc.specialisations, cc.operator_name,
         cc.registration,
         cs.file_number, cs.cargo_description
  from consolidations m
  join consolidation_carriers cc on cc.id = m.carrier_id
  left join cargo_shipments cs on cs.id = m.shipment_id`;

const MANIFEST_ONE_SQL = `${MANIFEST_SELECT}
  where m.id = $1 and m.tenant_id = $2 and m.deleted_at is null`;

/**
 * A manifest is a document of the office that issues it, so the print sheet
 * carries the same letterhead a proforma does — company name, the registered
 * numbers, the head-office address and the logo the tenant last uploaded.
 */
const LETTERHEAD_SQL = `
  select cp.company_name, cp.tin_display, cp.brela_number, cp.vat_number, cp.website,
         b.postal_address, b.street, b.email as branch_email,
         (select d.id from documents d
           where d.tenant_id = $1 and d.entity_type = 'tenant'
             and d.kind = 'logo' and d.deleted_at is null
           order by d.created_at desc limit 1) as logo_document_id
  from company_profiles cp
  left join branches b on b.tenant_id = cp.tenant_id and b.kind = 'hq' and b.deleted_at is null
  where cp.tenant_id = $1`;

const PARCEL_SELECT = `
  select p.id, p.seq, p.tracking_number, p.consignor_name, p.consignor_email,
         p.consignor_address, p.consignor_phone_encrypted, p.consignor_phone_search,
         p.goods_description, p.package_count, p.package_kind,
         p.marks_numbers, p.net_weight_kg, p.length_m, p.width_m, p.height_m, p.cbm,
         p.specialisation, p.transport_fee, p.amount_paid, p.currency,
         p.payment_reference, p.paid_at::text as paid_at, p.notes,
         case
           when p.transport_fee > 0 and p.amount_paid >= p.transport_fee then 'paid'
           when p.amount_paid > 0 then 'partial'
           else 'unpaid'
         end as payment_status,
         (p.transport_fee - p.amount_paid)::float8 as balance_due
  from consolidation_parcels p`;

const PARCEL_FOR_MANIFEST_SQL = `${PARCEL_SELECT}
  where p.manifest_id = $1 and p.tenant_id = $2 and p.deleted_at is null
  order by p.seq`;

/**
 * Presence-based update: a key absent from the body keeps its column and an
 * explicit null clears it — the same contract the drivers PUT uses, so the
 * manifest form can leave a field alone without resending it.
 */
function buildUpdate(map: Record<string, string>, body: Record<string, any>,
  cast: Record<string, (v: number) => number> = {}) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(map)) {
    if (!(key in body)) continue;
    const value = body[key] ?? null;
    params.push(value !== null && cast[key] ? cast[key](value) : value);
    sets.push(`${column} = $${params.length}`);
  }
  return { sets, params };
}

/**
 * The changed columns for the audit trail. Ciphertext never belongs in a jsonb
 * payload — the searchable hash is what gets recorded, the same posture the
 * driver update takes.
 */
const auditDiff = (sets: string[], params: unknown[]) => Object.fromEntries(
  sets.map((s, i) => [s.split(" = ")[0], params[i]] as const)
    .filter(([col]) => !col.endsWith("_encrypted")));

async function nextManifestNumber(c: any, tid: string): Promise<string> {
  const seq = await c.query(
    `select coalesce(max(nullif(regexp_replace(manifest_number, '\\D', '', 'g'), '')::bigint), 0) + 1 as next
     from consolidations where tenant_id = $1 and deleted_at is null`, [tid]);
  return `CSL-${String(seq.rows[0].next).padStart(4, "0")}`;
}

/**
 * A ward has to sit inside the district and the district inside the region.
 * Without this the picker can be driven straight from the API into a manifest
 * that prints "Ilala, Arusha, Dar es Salaam" on the same line.
 */
async function assertGeoChain(c: any, label: string, end: z.infer<typeof geoEnd>) {
  const { regionId, districtId, wardId } = end;
  if (!districtId && !wardId) return;
  if (districtId) {
    if (!regionId) throw missing(`${label} district`, `${label} region`);
    const d = await c.query("select region_id from geo_districts where id = $1", [districtId]);
    if (!d.rowCount) throw new ApiError("VALIDATION_FAILED", `Unknown ${label} district.`, 400, [{ field: label }]);
    if (d.rows[0].region_id !== regionId) throw mismatched(`${label} district`, `${label} region`);
  }
  if (wardId) {
    if (!districtId) throw missing(`${label} ward`, `${label} district`);
    const w = await c.query("select district_id from geo_wards where id = $1", [wardId]);
    if (!w.rowCount) throw new ApiError("VALIDATION_FAILED", `Unknown ${label} ward.`, 400, [{ field: label }]);
    if (w.rows[0].district_id !== districtId) throw mismatched(`${label} ward`, `${label} district`);
  }
}

const missing = (child: string, parent: string) => new ApiError("VALIDATION_FAILED",
  `A ${child} needs a ${parent} picked with it.`, 400, [{ field: parent }]);
const mismatched = (child: string, parent: string) => new ApiError("VALIDATION_FAILED",
  `That ${child} does not sit inside the picked ${parent}.`, 400, [{ field: child }]);

/** "Kawe, Ilala, Dar es Salaam" — the string printed on the manifest. */
async function geoLabel(c: any, end: z.infer<typeof geoEnd>): Promise<string | null> {
  const parts: string[] = [];
  if (end.wardId) {
    const w = await c.query("select name from geo_wards where id = $1", [end.wardId]);
    if (w.rows[0]?.name) parts.push(w.rows[0].name);
  }
  if (end.districtId) {
    const d = await c.query("select name_en from geo_districts where id = $1", [end.districtId]);
    if (d.rows[0]?.name_en) parts.push(d.rows[0].name_en);
  }
  if (end.regionId) {
    const r = await c.query("select name_en from geo_regions where id = $1", [end.regionId]);
    if (r.rows[0]?.name_en) parts.push(r.rows[0].name_en);
  }
  if (end.text) parts.push(end.text);
  return parts.length ? parts.join(", ") : null;
}

/**
 * The manifest totals are the sum of its parcels. Recomputed on every parcel
 * write rather than typed, because weight on board is what gets checked against
 * what the unit can legally carry.
 */
async function rollupManifest(c: any, tid: string, manifestId: string) {
  const { rows } = await c.query(
    `select coalesce(sum(net_weight_kg), 0)::float8 as kg,
            coalesce(sum(cbm), 0)::float8 as cbm,
            count(*)::int as pieces,
            coalesce(sum(transport_fee), 0)::float8 as fees,
            coalesce(sum(amount_paid), 0)::float8 as paid
     from consolidation_parcels
     where manifest_id = $1 and tenant_id = $2 and deleted_at is null`,
    [manifestId, tid]);
  const s = rows[0];
  await c.query(
    `update consolidations set weight_on_board_kg = $3, cbm_total = $4, parcel_count = $5,
            transport_fee_total = $6, amount_paid_total = $7, updated_at = now()
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [manifestId, tid, qty(s.kg), qty(s.cbm), s.pieces, money(s.fees), money(s.paid)]);
  return s;
}

/** Cubic metres from the three measured dimensions when all three are given. */
function cbmOf(p: { lengthM?: number | null; widthM?: number | null; heightM?: number | null }) {
  const { lengthM, widthM, heightM } = p;
  if (!lengthM || !widthM || !heightM) return 0;
  return qty(lengthM * widthM * heightM);
}

/**
 * Everything a parcel write needs from the manifest it hangs off: the number,
 * the leg's status and what the carrier is permitted to carry. Checking the
 * specialisation here rather than only on insert is what stops a PUT walking a
 * DG drum onto a plain box trailer, and the frozen-status check is what stops
 * weight being quietly reshuffled on a load that has already been delivered.
 */
async function parcelGate(c: any, manifestId: string, tid: string, specialisation?: string | null) {
  const { rows } = await c.query(
    `select m.manifest_number, m.status, cc.specialisations
     from consolidations m
     join consolidation_carriers cc on cc.id = m.carrier_id
     where m.id = $1 and m.tenant_id = $2 and m.deleted_at is null`,
    [manifestId, tid]);
  if (!rows.length) throw new ApiError("NOT_FOUND", "Manifest not found", 404);
  const head = rows[0];
  if (PARCEL_FROZEN.includes(head.status)) {
    throw new ApiError("CONFLICT",
      `${head.manifest_number} was delivered — what was on board it is settled paper now.`, 409);
  }
  if (specialisation && specialisation !== "general"
    && !(head.specialisations as string[]).includes(specialisation)) {
    throw new ApiError("CONFLICT",
      `This carrier is not listed for ${specialisation} cargo. Add the specialisation ` +
      "to the carrier or pick another unit.", 409, [{ field: "specialisation" }]);
  }
  return head;
}

export async function consolidationRoutes(app: FastifyInstance, _opts: unknown) {

  // ================= Carriers =================

  app.get("/consolidation/carriers", { preHandler: [requireAuth, requirePermission("consolidation.view")] },
    async (req: any) => {
      // "false" is truthy as a string, so the filter is parsed as an enum rather
      // than coerced — ?active=false has to mean inactive.
      const q = z.object({
        mode: z.enum(MODES).optional(),
        active: z.enum(["true", "false"]).optional()
      }).parse(req.query);
      const where = ["cc.deleted_at is null"];
      const params: unknown[] = [req.user.tid];
      if (q.mode) { params.push(q.mode); where.push(`cc.mode = $${params.length}`); }
      if (q.active !== undefined) {
        params.push(q.active === "true");
        where.push(`cc.is_active = $${params.length}`);
      }
      return withTenant(req.user.tid, async (c) => {
        const { rows } = await c.query(
          `${CARRIER_SELECT} where cc.tenant_id = $1 and ${where.join(" and ")}
           order by cc.display_name`, params);
        return { carriers: rows };
      });
    });

  app.post("/consolidation/carriers", { preHandler: [requireAuth, requirePermission("consolidation.create")] },
    async (req: any, reply) => {
      const body = carrierSchema.parse(req.body);
      assertUnitMode(body.unitType, body.mode);
      const id = uuidv7();
      try {
        await withTenant(req.user.tid, async (c) => {
          if (body.vesselId && !(await c.query(
            "select id from vessels where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.vesselId, req.user.tid])).rowCount) {
            throw new ApiError("NOT_FOUND", "Vessel not found", 404);
          }
          await c.query(
            `insert into consolidation_carriers (id, tenant_id, mode, unit_type, display_name,
               operator_name, registration, vessel_id, make, model, year_manufactured,
               capacity_unit, capacity_max, specialisations, home_base, is_active, notes,
               created_by, updated_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
            [id, req.user.tid, body.mode, body.unitType, body.displayName,
             body.operatorName ?? null, body.registration ?? null, body.vesselId ?? null,
             body.make ?? null, body.model ?? null, body.yearManufactured ?? null,
             body.capacityUnit, body.capacityMax ?? null, body.specialisations,
             body.homeBase ?? null, body.isActive, body.notes ?? null, req.user.sub]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "consolidation_carrier", entityId: id,
            action: "consolidation.carrier_created",
            after: { mode: body.mode, unitType: body.unitType, name: body.displayName,
                     capacityUnit: body.capacityUnit, capacityMax: body.capacityMax ?? null,
                     specialisations: body.specialisations }
          });
        });
      } catch (e: any) {
        if (e.code === "23505") {
          throw new ApiError("CONFLICT", `A carrier registered as ${body.registration} already exists.`, 409);
        }
        throw e;
      }
      return reply.status(201).send({ id });
    });

  app.put("/consolidation/carriers/:id", { preHandler: [requireAuth, requirePermission("consolidation.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = carrierSchema.partial().parse(req.body);
      return withTenant(req.user.tid, async (c) => {
        const prev = await c.query(CARRIER_ONE_SQL, [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Carrier not found", 404);
        // Either half can arrive alone, so the pair is checked as it would read
        // after the update — a patch that flips only the mode cannot file a
        // cargo ship as a road unit either.
        if (body.mode || body.unitType) {
          assertUnitMode(body.unitType ?? prev.rows[0].unit_type, body.mode ?? prev.rows[0].mode);
        }

        // A lane cannot be withdrawn from a unit that is still carrying cargo in
        // it, or the filed manifest ends up printed against a carrier that no
        // longer claims to be able to haul it.
        if (body.specialisations) {
          const orphaned = await c.query(
            `select p.tracking_number from consolidation_parcels p
             join consolidations m on m.id = p.manifest_id
             where m.carrier_id = $1 and p.tenant_id = $2 and m.tenant_id = $2
               and m.deleted_at is null and p.deleted_at is null
               and m.status <> 'cancelled' and p.specialisation <> 'general'
               and not (p.specialisation = any($3::text[]))
             limit 3`, [id, req.user.tid, body.specialisations]);
          if (orphaned.rowCount) {
            throw new ApiError("CONFLICT",
              "Still carrying cargo in a lane being dropped: " +
              `${orphaned.rows.map((r: any) => r.tracking_number).join(", ")}. ` +
              "Move those parcels or cancel those manifests first.", 409,
              [{ field: "specialisations" }]);
          }
        }

        const { sets, params } = buildUpdate({
          mode: "mode", unitType: "unit_type", displayName: "display_name",
          operatorName: "operator_name", registration: "registration", vesselId: "vessel_id",
          make: "make", model: "model", yearManufactured: "year_manufactured",
          capacityUnit: "capacity_unit", capacityMax: "capacity_max",
          specialisations: "specialisations", homeBase: "home_base",
          isActive: "is_active", notes: "notes"
        }, body as Record<string, any>);
        if (!sets.length) return { ok: true, changed: 0 };

        const before = prev.rows[0];
        await c.query(
          `update consolidation_carriers set ${sets.join(", ")}, updated_by = $${params.length + 1},
                  updated_at = now()
           where id = $${params.length + 2} and tenant_id = $${params.length + 3}`,
          [...params, req.user.sub, id, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "consolidation_carrier", entityId: id,
          action: "consolidation.carrier_updated",
          before: { capacityMax: before.capacity_max, specialisations: before.specialisations,
                    isActive: before.is_active },
          after: auditDiff(sets, params)
        });
        return { ok: true, changed: sets.length };
      });
    });

  // A carrier that a live manifest still rides on cannot be retired: the
  // manifest prints its capacity and specialisation, and a retired unit would
  // leave that paper pointing at nothing.
  app.delete("/consolidation/carriers/:id", { preHandler: [requireAuth, requirePermission("consolidation.delete")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const cur = await c.query(
          `select cc.display_name, cc.registration,
                  (select count(*)::int from consolidations m
                    where m.carrier_id = cc.id and m.deleted_at is null
                      and m.status <> 'cancelled') as live
           from consolidation_carriers cc
           where cc.id = $1 and cc.tenant_id = $2 and cc.deleted_at is null`,
          [id, req.user.tid]);
        if (!cur.rowCount) throw new ApiError("NOT_FOUND", "Carrier not found", 404);
        if (cur.rows[0].live) {
          throw new ApiError("CONFLICT",
            `${cur.rows[0].display_name} is carrying ${cur.rows[0].live} open manifest(s). ` +
            "Cancel or complete those first.", 409);
        }
        await c.query(`update consolidation_carriers set deleted_at = now(), updated_by = $2,
            updated_at = now() where id = $1 and tenant_id = $3`,
          [id, req.user.sub, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "consolidation_carrier", entityId: id,
          action: "consolidation.carrier_deleted", before: { name: cur.rows[0].display_name }
        });
        return { ok: true };
      });
    });

  // ================= Manifests =================

  app.get("/consolidation", { preHandler: [requireAuth, requirePermission("consolidation.view")] },
    async (req: any) => {
      const q = z.object({
        status: z.enum(MANIFEST_STATUSES).optional(),
        carrierId: z.string().uuid().optional(),
        q: z.string().trim().max(80).optional()
      }).parse(req.query);
      const where = ["m.deleted_at is null", "m.tenant_id = $1"];
      const params: unknown[] = [req.user.tid];
      if (q.status) { params.push(q.status); where.push(`m.status = $${params.length}`); }
      if (q.carrierId) { params.push(q.carrierId); where.push(`m.carrier_id = $${params.length}`); }
      if (q.q) {
        params.push(`%${q.q.toLowerCase()}%`);
        where.push(`(lower(m.manifest_number) like $${params.length}
                     or lower(m.bill_of_lading) like $${params.length}
                     or lower(m.container_no) like $${params.length}
                     or lower(cc.display_name) like $${params.length})`);
      }
      return withTenant(req.user.tid, async (c) => {
        const { rows } = await c.query(
          `${MANIFEST_SELECT} where ${where.join(" and ")} order by m.created_at desc limit 200`, params);
        const kpis = await c.query(
          `select count(*)::int as manifests,
                  coalesce(sum(m.transport_fee_total), 0)::float8 as billed,
                  coalesce(sum(m.amount_paid_total), 0)::float8 as collected,
                  coalesce(sum(m.transport_fee_total - m.amount_paid_total)
                           filter (where m.status <> 'cancelled'), 0)::float8 as outstanding,
                  count(*) filter (where m.status = 'in_transit')::int as in_transit
           from consolidations m where m.tenant_id = $1 and m.deleted_at is null`,
          [req.user.tid]);
        return { manifests: rows, kpis: kpis.rows[0] };
      });
    });

  app.post("/consolidation", { preHandler: [requireAuth, requirePermission("consolidation.create")] },
    async (req: any, reply) => {
      const body = manifestSchema.parse(req.body);
      const id = uuidv7();
      const number = await withTenant(req.user.tid, async (c) => {
        await assertGeoChain(c, "origin", body.origin);
        await assertGeoChain(c, "destination", body.destination);
        const carrier = await c.query(
          `select id, display_name from consolidation_carriers
           where id = $1 and tenant_id = $2 and deleted_at is null and is_active`,
          [body.carrierId, req.user.tid]);
        if (!carrier.rowCount) throw new ApiError("NOT_FOUND", "Carrier not found or is retired.", 404);
        if (body.routeId && !(await c.query(
          "select id from routes where id = $1 and tenant_id = $2 and deleted_at is null",
          [body.routeId, req.user.tid])).rowCount) {
          throw new ApiError("NOT_FOUND", "Route not found", 404);
        }
        if (body.shipmentId && !(await c.query(
          "select id from cargo_shipments where id = $1 and tenant_id = $2 and deleted_at is null",
          [body.shipmentId, req.user.tid])).rowCount) {
          throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
        }
        if (body.departureDate && body.arrivalDate && body.arrivalDate < body.departureDate) {
          throw new ApiError("VALIDATION_FAILED",
            "The load cannot arrive before it departs.", 400, [{ field: "arrivalDate" }]);
        }
        const manifestNumber = await nextManifestNumber(c, req.user.tid);
        await c.query(
          `insert into consolidations (id, tenant_id, manifest_number, carrier_id,
             origin_region_id, origin_district_id, origin_ward_id, origin_text,
             dest_region_id, dest_district_id, dest_ward_id, dest_text,
             route_id, shipment_id, bill_of_lading, container_no, seal_no, container_type,
             departure_date, arrival_date, currency, routing_notes, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)`,
          [id, req.user.tid, manifestNumber, body.carrierId,
           body.origin.regionId ?? null, body.origin.districtId ?? null,
           body.origin.wardId ?? null, body.origin.text ?? null,
           body.destination.regionId ?? null, body.destination.districtId ?? null,
           body.destination.wardId ?? null, body.destination.text ?? null,
           body.routeId ?? null, body.shipmentId ?? null, body.billOfLading ?? null,
           body.containerNo ?? null, body.sealNo ?? null, body.containerType ?? null,
           body.departureDate ?? null, body.arrivalDate ?? null, body.currency,
           body.routingNotes ?? null, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "consolidation", entityId: id,
          action: "consolidation.created",
          after: { manifestNumber, carrier: carrier.rows[0].display_name }
        });
        return manifestNumber;
      });
      return reply.status(201).send({ id, manifestNumber: number });
    });

  app.get("/consolidation/:id", { preHandler: [requireAuth, requirePermission("consolidation.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const head = await c.query(MANIFEST_ONE_SQL, [id, req.user.tid]);
        if (!head.rowCount) throw new ApiError("NOT_FOUND", "Manifest not found", 404);
        const row = head.rows[0];

        const [parcels, carrier, route, letter] = await Promise.all([
          c.query(PARCEL_FOR_MANIFEST_SQL, [id, req.user.tid]),
          c.query(CARRIER_BY_ID_SQL, [row.carrier_id, req.user.tid]),
          row.route_id
            ? c.query(`select id, name, corridor, distance_km, expected_duration_hours
                       from routes where id = $1 and tenant_id = $2`, [row.route_id, req.user.tid])
            : null,
          c.query(LETTERHEAD_SQL, [req.user.tid])
        ]);

        // Consignor phone is PII: it is decrypted for the one manifest being
        // worked on and never appears in the list query above.
        const lines = parcels.rows.map((p: any) => ({
          ...p,
          consignor_phone: p.consignor_phone_encrypted
            ? decryptField(p.consignor_phone_encrypted)
            : null,
          consignor_phone_encrypted: undefined,
          consignor_phone_search: undefined,
          balance_due: money(Number(p.transport_fee) - Number(p.amount_paid))
        }));

        const origin = await geoLabel(c, {
          regionId: row.origin_region_id, districtId: row.origin_district_id,
          wardId: row.origin_ward_id, text: row.origin_text
        });
        const destination = await geoLabel(c, {
          regionId: row.dest_region_id, districtId: row.dest_district_id,
          wardId: row.dest_ward_id, text: row.dest_text
        });

        const cr = carrier.rows[0];
        const capacityKg = capacityInKg(cr.capacity_unit, cr.capacity_max === null
          ? null : Number(cr.capacity_max));
        const onBoard = Number(row.weight_on_board_kg);
        return {
          ...row,
          origin_label: origin,
          destination_label: destination,
          letterhead: letter.rows[0] ?? null,
          route: route?.rows[0] ?? null,
          carrier: cr,
          parcels: lines,
          capacity: {
            unit: cr.capacity_unit,
            max: cr.capacity_max === null ? null : Number(cr.capacity_max),
            stated_in_mass: capacityKg !== null,
            weight_on_board_kg: onBoard,
            // Only meaningful when both sides are a mass; a TEU or cube slot
            // cannot be over-full by weight.
            over_capacity: capacityKg === null || cr.capacity_max === null
              ? false : onBoard > capacityKg + 1e-6,
            utilisation_pct: capacityKg === null || !capacityKg ? null
              : Math.round((onBoard / capacityKg) * 1000) / 10
          },
          settlement: {
            billed: Number(row.transport_fee_total),
            collected: Number(row.amount_paid_total),
            balance_due: money(Number(row.transport_fee_total) - Number(row.amount_paid_total)),
            parcels_paid: parcels.rows.filter((p: any) => p.payment_status === "paid").length,
            parcels_partial: parcels.rows.filter((p: any) => p.payment_status === "partial").length,
            parcels_unpaid: parcels.rows.filter((p: any) => p.payment_status === "unpaid").length
          }
        };
      });
    });

  app.put("/consolidation/:id", { preHandler: [requireAuth, requirePermission("consolidation.edit")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = manifestSchema.partial().parse(req.body);
      return withTenant(req.user.tid, async (c) => {
        const prev = await c.query(MANIFEST_ONE_SQL, [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Manifest not found", 404);
        if (prev.rows[0].status === "cancelled") {
          throw new ApiError("CONFLICT", "A cancelled manifest cannot be edited.", 409);
        }
        // The header is the signed part of the paper: once the load has been
        // handed over, the lane, unit and dates are evidence. Settlement stays
        // open on the payment door.
        if (prev.rows[0].status === "delivered") {
          throw new ApiError("CONFLICT",
            "This manifest has been signed for as delivered — its cargo, unit and " +
            "dates are fixed. Settle the outstanding parcels instead.", 409);
        }
        if (body.origin) await assertGeoChain(c, "origin", body.origin);
        if (body.destination) await assertGeoChain(c, "destination", body.destination);
        if (body.carrierId && body.carrierId !== prev.rows[0].carrier_id) {
          const next = await c.query(
            `select id, display_name, specialisations from consolidation_carriers
             where id = $1 and tenant_id = $2 and deleted_at is null and is_active`,
            [body.carrierId, req.user.tid]);
          if (!next.rowCount) throw new ApiError("NOT_FOUND", "Carrier not found or is retired.", 404);
          // Swapping the unit cannot smuggle cargo it is not permitted to carry:
          // every lane already riding this leg has to fit the new unit too.
          const stranded = await c.query(
            `select p.tracking_number, p.specialisation from consolidation_parcels p
             where p.manifest_id = $1 and p.tenant_id = $2 and p.deleted_at is null
               and p.specialisation is not null and p.specialisation <> 'general'
               and not (p.specialisation = any($3::text[]))
             order by p.seq limit 3`,
            [id, req.user.tid, next.rows[0].specialisations]);
          if (stranded.rowCount) {
            const list = stranded.rows.map((r: any) => `${r.tracking_number} (${r.specialisation})`).join(", ");
            throw new ApiError("CONFLICT",
              `${next.rows[0].display_name} is not listed for cargo already on this manifest: ${list}.`,
              409, [{ field: "carrierId" }]);
          }
        }

        const departure = body.departureDate ?? prev.rows[0].departure_date;
        const arrival = body.arrivalDate ?? prev.rows[0].arrival_date;
        if (departure && arrival && arrival < departure) {
          throw new ApiError("VALIDATION_FAILED",
            "The load cannot arrive before it departs.", 400, [{ field: "arrivalDate" }]);
        }

        const flat: Record<string, any> = { ...body };
        delete flat.origin;
        delete flat.destination;
        const map: Record<string, string> = {
          carrierId: "carrier_id", routeId: "route_id", shipmentId: "shipment_id",
          billOfLading: "bill_of_lading", containerNo: "container_no", sealNo: "seal_no",
          containerType: "container_type", departureDate: "departure_date",
          arrivalDate: "arrival_date", currency: "currency", routingNotes: "routing_notes"
        };
        for (const [k, prefix] of [["origin", "origin"], ["destination", "dest"]] as const) {
          const end = (body as any)[k];
          if (!end) continue;
          map[`${k}RegionId`] = `${prefix}_region_id`;
          map[`${k}DistrictId`] = `${prefix}_district_id`;
          map[`${k}WardId`] = `${prefix}_ward_id`;
          map[`${k}Text`] = `${prefix}_text`;
          flat[`${k}RegionId`] = end.regionId ?? null;
          flat[`${k}DistrictId`] = end.districtId ?? null;
          flat[`${k}WardId`] = end.wardId ?? null;
          flat[`${k}Text`] = end.text ?? null;
        }
        const { sets, params } = buildUpdate(map, flat);
        if (!sets.length) return { ok: true, changed: 0 };
        await c.query(
          `update consolidations set ${sets.join(", ")}, updated_by = $${params.length + 1},
                  updated_at = now()
           where id = $${params.length + 2} and tenant_id = $${params.length + 3}`,
          [...params, req.user.sub, id, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "consolidation", entityId: id,
          action: "consolidation.updated",
          after: auditDiff(sets, params)
        });
        return { ok: true, changed: sets.length };
      });
    });

  app.put("/consolidation/:id/status", { preHandler: [requireAuth, requirePermission("consolidation.edit")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = z.object({ status: z.enum(MANIFEST_STATUSES) }).parse(req.body);
      return withTenant(req.user.tid, async (c) => {
        const cur = await c.query(
          `select status, parcel_count, manifest_number from consolidations
           where id = $1 and tenant_id = $2 and deleted_at is null`, [id, req.user.tid]);
        if (!cur.rowCount) throw new ApiError("NOT_FOUND", "Manifest not found", 404);
        const from = cur.rows[0].status as ManifestStatus;
        if (from === body.status) return { ok: true, status: from };
        if (!MANIFEST_NEXT[from].includes(body.status)) {
          throw new ApiError("CONFLICT",
            `A ${from} manifest cannot become ${body.status}.` +
            (MANIFEST_NEXT[from].length
              ? ` From ${from} it can go to ${MANIFEST_NEXT[from].join(" or ")}.`
              : " A delivered leg has no way back."), 409);
        }
        // Nothing moves a load that has no pieces on it.
        if (body.status !== "draft" && body.status !== "cancelled" && !cur.rows[0].parcel_count) {
          throw new ApiError("CONFLICT",
            "Add at least one parcel before moving this manifest past draft.", 409);
        }
        await c.query(`update consolidations set status = $3, updated_by = $4, updated_at = now()
          where id = $1 and tenant_id = $2`, [id, req.user.tid, body.status, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "consolidation", entityId: id,
          action: "consolidation.status_changed",
          before: { status: from }, after: { status: body.status,
            manifestNumber: cur.rows[0].manifest_number }
        });
        return { ok: true, status: body.status };
      });
    });

  app.delete("/consolidation/:id", { preHandler: [requireAuth, requirePermission("consolidation.delete")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const cur = await c.query(
          `select status, manifest_number, amount_paid_total::float8 as paid from consolidations
           where id = $1 and tenant_id = $2 and deleted_at is null`, [id, req.user.tid]);
        if (!cur.rowCount) throw new ApiError("NOT_FOUND", "Manifest not found", 404);
        if (cur.rows[0].status === "delivered") {
          throw new ApiError("CONFLICT",
            `${cur.rows[0].manifest_number} has been delivered. Delivered paper is kept, not deleted.`, 409);
        }
        if (Number(cur.rows[0].paid) > 0) {
          throw new ApiError("CONFLICT",
            `${cur.rows[0].manifest_number} has payments recorded against it and cannot be deleted.`, 409);
        }
        await c.query(`update consolidations set deleted_at = now(), updated_by = $2,
            updated_at = now() where id = $1 and tenant_id = $3`,
          [id, req.user.sub, req.user.tid]);
        await c.query(`update consolidation_parcels set deleted_at = now(), updated_at = now()
          where manifest_id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "consolidation", entityId: id,
          action: "consolidation.deleted", before: { manifestNumber: cur.rows[0].manifest_number }
        });
        return { ok: true };
      });
    });

  // ================= Parcels =================

  app.post("/consolidation/:id/parcels",
    { preHandler: [requireAuth, requirePermission("consolidation.create")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = parcelSchema.parse(req.body);
      const parcelId = uuidv7();
      const tracking = await withTenant(req.user.tid, async (c) => {
        const head = await parcelGate(c, id, req.user.tid, body.specialisation);
        const { manifest_number: number } = head;
        // The sequence runs over every parcel this manifest has ever held, soft
        // deletes included: a number already printed on a piece of cargo cannot
        // be handed to a second piece. The gap the removed parcel leaves is the
        // honest record; a reused tracking number is two papers claiming one
        // consignment.
        const seqRow = await c.query(
          `select coalesce(max(seq), 0) + 1 as next from consolidation_parcels
           where manifest_id = $1 and tenant_id = $2`, [id, req.user.tid]);
        const seq = seqRow.rows[0].next;
        const trackingNumber = `${number}-${String(seq).padStart(3, "0")}`;
        const phone = body.consignorPhone ? encryptField(body.consignorPhone) : null;
        await c.query(
          `insert into consolidation_parcels (id, tenant_id, manifest_id, seq, tracking_number,
             consignor_name, consignor_phone_encrypted, consignor_phone_search, consignor_email,
             consignor_address, goods_description, package_count, package_kind, marks_numbers,
             net_weight_kg, length_m, width_m, height_m, cbm, specialisation, transport_fee,
             currency, notes, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                   (select currency from consolidations where id = $3),$22,$23,$23)`,
          [parcelId, req.user.tid, id, seq, trackingNumber, body.consignorName, phone,
           body.consignorPhone ? searchHash(body.consignorPhone) : null,
           body.consignorEmail ?? null, body.consignorAddress ?? null, body.goodsDescription,
           body.packageCount, body.packageKind ?? null, body.marksNumbers ?? null,
           qty(body.netWeightKg), body.lengthM ?? null, body.widthM ?? null, body.heightM ?? null,
           cbmOf(body), body.specialisation ?? null, money(body.transportFee),
           body.notes ?? null, req.user.sub]);
        await rollupManifest(c, req.user.tid, id);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "consolidation_parcel", entityId: parcelId,
          action: "consolidation.parcel_added",
          after: { trackingNumber, goods: body.goodsDescription,
                   netWeightKg: body.netWeightKg, transportFee: body.transportFee }
        });
        return trackingNumber;
      });
      return reply.status(201).send({ id: parcelId, trackingNumber: tracking });
    });

  app.put("/consolidation/:id/parcels/:parcelId",
    { preHandler: [requireAuth, requirePermission("consolidation.edit")] },
    async (req: any) => {
      const { id, parcelId } = req.params as { id: string; parcelId: string };
      const body = parcelSchema.partial().parse(req.body);
      return withTenant(req.user.tid, async (c) => {
        // Only a lane that is actually being changed is re-gated, so a clerk
        // correcting a spelling cannot be blocked by a specialisation the
        // carrier has since dropped.
        await parcelGate(c, id, req.user.tid,
          "specialisation" in body ? body.specialisation : undefined);
        const prev = await parcelRow(c, id, parcelId, req.user.tid);
        const { sets, params } = buildUpdate({
          consignorName: "consignor_name", consignorEmail: "consignor_email",
          consignorAddress: "consignor_address", goodsDescription: "goods_description",
          packageCount: "package_count", packageKind: "package_kind",
          marksNumbers: "marks_numbers", netWeightKg: "net_weight_kg",
          lengthM: "length_m", widthM: "width_m", heightM: "height_m",
          specialisation: "specialisation", transportFee: "transport_fee", notes: "notes"
        }, body as Record<string, any>, { netWeightKg: qty, transportFee: money });
        let phoneHash: string | null | undefined;
        if ("consignorPhone" in body) {
          const phone = body.consignorPhone as string | null | undefined;
          phoneHash = phone ? searchHash(phone) : null;
          params.push(phone ? encryptField(phone) : null);
          sets.push(`consignor_phone_encrypted = $${params.length}`);
          params.push(phoneHash);
          sets.push(`consignor_phone_search = $${params.length}`);
        }
        // cbm is measured geometry, not a field anyone should have to keep in
        // their head: it is recomputed whenever any dimension is touched.
        if (["lengthM", "widthM", "heightM"].some((k) => k in body)) {
          const merged = {
            lengthM: "lengthM" in body ? body.lengthM : Number(prev.length_m),
            widthM: "widthM" in body ? body.widthM : Number(prev.width_m),
            heightM: "heightM" in body ? body.heightM : Number(prev.height_m)
          };
          params.push(cbmOf(merged));
          sets.push(`cbm = $${params.length}`);
        }
        if (!sets.length) return { ok: true, changed: 0 };
        await c.query(
          `update consolidation_parcels set ${sets.join(", ")}, updated_by = $${params.length + 1},
                  updated_at = now()
           where id = $${params.length + 2} and tenant_id = $${params.length + 3}
             and manifest_id = $${params.length + 4}`,
          [...params, req.user.sub, parcelId, req.user.tid, id]);
        await rollupManifest(c, req.user.tid, id);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "consolidation_parcel", entityId: parcelId,
          action: "consolidation.parcel_updated",
          before: { netWeightKg: prev.net_weight_kg, transportFee: prev.transport_fee },
          after: auditDiff(sets, params)
        });
        return { ok: true, changed: sets.length };
      });
    });

  /**
   * Settlement on a parcel. The system never moves the money: this records the
   * figure the clerk was given, the reference written on the slip, and the date.
   * Over-payment is refused the same way an invoice refuses it.
   */
  app.put("/consolidation/:id/parcels/:parcelId/payment",
    { preHandler: [requireAuth, requirePermission("consolidation.settle")] },
    async (req: any) => {
      const { id, parcelId } = req.params as { id: string; parcelId: string };
      const body = settleSchema.parse(req.body);
      return withTenant(req.user.tid, async (c) => {
        // parcelRow already refuses a parcel that is not on a live manifest.
        const prev = await parcelRow(c, id, parcelId, req.user.tid);
        const fee = Number(prev.transport_fee);
        if (fee <= 0) {
          throw new ApiError("CONFLICT",
            "This parcel has no transport fee stated, so there is nothing to settle against it.", 409);
        }
        if (money(body.amountPaid) > money(fee) + 0.001) {
          throw new ApiError("CONFLICT",
            `This payment is more than the ${fee.toLocaleString("en-US", { minimumFractionDigits: 2 })} ` +
            `${prev.currency} the parcel owes.`, 409, [{ field: "amountPaid" }]);
        }
        await c.query(
          `update consolidation_parcels set amount_paid = $3, payment_reference = $4,
                  paid_at = coalesce($5, paid_at, current_date), updated_by = $6, updated_at = now()
           where id = $1 and tenant_id = $2 and manifest_id = $7`,
          [parcelId, req.user.tid, money(body.amountPaid), body.paymentReference ?? null,
           body.paidAt ?? null, req.user.sub, id]);
        await rollupManifest(c, req.user.tid, id);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "consolidation_parcel", entityId: parcelId,
          action: "consolidation.payment_recorded",
          before: { amountPaid: Number(prev.amount_paid) },
          after: { amountPaid: money(body.amountPaid), reference: body.paymentReference ?? null,
                   balanceAfter: money(fee - money(body.amountPaid)),
                   trackingNumber: prev.tracking_number }
        });
        return { ok: true, balanceDue: money(fee - money(body.amountPaid)) };
      });
    });

  // Soft delete, and the seq is never reused: the piece that came off the load
  // stays in the table, so the paper record of what was on board survives.
  app.delete("/consolidation/:id/parcels/:parcelId",
    { preHandler: [requireAuth, requirePermission("consolidation.edit")] },
    async (req: any) => {
      const { id, parcelId } = req.params as { id: string; parcelId: string };
      return withTenant(req.user.tid, async (c) => {
        await parcelGate(c, id, req.user.tid);
        const prev = await parcelRow(c, id, parcelId, req.user.tid);
        if (Number(prev.amount_paid) > 0) {
          throw new ApiError("CONFLICT",
            `${prev.tracking_number} has a payment recorded against it and cannot be removed.`, 409);
        }
        await c.query(`update consolidation_parcels set deleted_at = now(), updated_by = $3,
            updated_at = now() where id = $1 and tenant_id = $2 and manifest_id = $4`,
          [parcelId, req.user.tid, req.user.sub, id]);
        await rollupManifest(c, req.user.tid, id);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "consolidation_parcel", entityId: parcelId,
          action: "consolidation.parcel_removed",
          before: { trackingNumber: prev.tracking_number, goods: prev.goods_description }
        });
        return { ok: true };
      });
    });
}

/** A parcel on this manifest in this tenant, or a 404. */
async function parcelRow(c: any, manifestId: string, parcelId: string, tid: string) {
  const { rows } = await c.query(
    `select p.*, m.manifest_number, m.status as manifest_status
     from consolidation_parcels p
     join consolidations m on m.id = p.manifest_id
     where p.id = $1 and p.manifest_id = $2 and p.tenant_id = $3
       and p.deleted_at is null and m.deleted_at is null`,
    [parcelId, manifestId, tid]);
  if (!rows.length) throw new ApiError("NOT_FOUND", "Parcel not found on this manifest", 404);
  return rows[0];
}

/**
 * Capacity compared against weight only makes sense once both are a mass. TEU
 * and cubic-metre slots return null so the caller says "not measurable by
 * weight" instead of reporting an impossible overload.
 */
function capacityInKg(unit: string, max: number | null): number | null {
  if (max === null) return null;
  if (unit === "kg") return max;
  if (unit === "tonnes") return max * 1000;
  return null;
}
